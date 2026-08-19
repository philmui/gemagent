"""FastAPI entry point."""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .adk_runtime import GeminiAdkRuntime, build_gemini_adk_runtime
from .config import Settings, get_settings
from .gemini_live import serve_gemini_live
from .guards import (
    ConcurrencyGuard,
    ConcurrencyLimitExceeded,
    RateLimitExceeded,
    SlidingWindowRateLimiter,
)
from .models import (
    HealthResponse,
    Provider,
    ProviderHealth,
    SessionTokenRequest,
    SessionTokenResponse,
    WebSearchRequest,
    WebSearchResponse,
)
from .providers import (
    ProviderNotConfigured,
    UpstreamSearchError,
    UpstreamTokenError,
    mint_openai_token,
    search_openai_web,
)
from .voices import UnsupportedVoiceError, canonicalize_voice, voices_for


logger = logging.getLogger(__name__)


def _client_key(request: Request) -> str:
    # Do not trust X-Forwarded-For here. A trusted edge can enforce a stronger,
    # distributed identity-aware rate limit in production.
    return request.client.host if request.client else "unknown"


def _websocket_client_key(websocket: WebSocket) -> str:
    # As with HTTP requests, a trusted edge should provide the distributed,
    # authenticated abuse-control identity for a public deployment.
    return websocket.client.host if websocket.client else "unknown"


def _origin_is_allowed(
    origins: list[str], settings: Settings, allowed_origins: tuple[str, ...]
) -> bool:
    has_one_allowed_origin = len(origins) == 1 and origins[0] in allowed_origins
    missing_origin_allowed = not origins and settings.app_env != "production"
    return has_one_allowed_origin or missing_origin_allowed


def _no_store(response: JSONResponse) -> JSONResponse:
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


def create_app(
    settings: Settings | None = None,
    *,
    http_client_factory: Callable[[], httpx.AsyncClient] | None = None,
    gemini_runtime_factory: Callable[[Settings], GeminiAdkRuntime] | None = None,
) -> FastAPI:
    app_settings = settings or get_settings()
    allowed_origins = app_settings.allowed_origins
    make_http_client = http_client_factory or (
        lambda: httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=5.0))
    )
    make_gemini_runtime = gemini_runtime_factory or build_gemini_adk_runtime

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        application.state.http_client = make_http_client()
        application.state.gemini_runtime = None
        try:
            if app_settings.gemini_configured:
                application.state.gemini_runtime = make_gemini_runtime(app_settings)
            yield
        finally:
            runtime = application.state.gemini_runtime
            try:
                if runtime is not None:
                    await runtime.close()
            finally:
                await application.state.http_client.aclose()

    application = FastAPI(
        title="Voice Lab ADK gateway",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    application.state.settings = app_settings
    application.state.rate_limiter = SlidingWindowRateLimiter(
        app_settings.session_token_rate_limit
    )
    application.state.concurrency_guard = ConcurrencyGuard(
        app_settings.session_token_concurrency
    )
    application.state.web_search_rate_limiter = SlidingWindowRateLimiter(
        app_settings.web_search_rate_limit
    )
    application.state.web_search_concurrency_guard = ConcurrencyGuard(
        app_settings.web_search_concurrency
    )
    application.state.gemini_live_rate_limiter = SlidingWindowRateLimiter(
        app_settings.gemini_live_rate_limit
    )
    application.state.gemini_live_concurrency_guard = ConcurrencyGuard(
        app_settings.gemini_live_concurrency
    )

    @application.middleware("http")
    async def exact_origin_and_cache_control(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            origins = request.headers.getlist("origin")
            if not _origin_is_allowed(origins, app_settings, allowed_origins):
                return _no_store(
                    JSONResponse(
                        status_code=status.HTTP_403_FORBIDDEN,
                        content={"detail": "Origin is not allowed."},
                    )
                )
            limiter = (
                application.state.web_search_rate_limiter
                if request.url.path == "/api/tools/web-search"
                else application.state.rate_limiter
            )
            try:
                await limiter.check(_client_key(request))
            except RateLimitExceeded:
                target = (
                    "web search requests"
                    if request.url.path == "/api/tools/web-search"
                    else "session token requests"
                )
                return _no_store(
                    JSONResponse(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        content={"detail": f"Too many {target}. Try again shortly."},
                        headers={"Retry-After": "60"},
                    )
                )
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
            return response
        return await call_next(request)

    # CORS remains a browser interoperability layer. The middleware above performs
    # the explicit exact-origin decision on credential-minting requests.
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
        max_age=600,
    )

    @application.exception_handler(RequestValidationError)
    async def request_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Do not reflect request values. A caller may accidentally submit a secret
        # in an unknown field, and FastAPI's default response includes that input.
        del request, exc
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"detail": "Request validation failed."},
        )

    @application.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(
            providers={
                Provider.GEMINI: ProviderHealth(
                    configured=app_settings.gemini_configured,
                    model=app_settings.gemini_live_model,
                    runtime="google-adk",
                ),
                Provider.OPENAI: ProviderHealth(
                    configured=app_settings.openai_configured,
                    model=app_settings.openai_realtime_model,
                    runtime="openai-agents-sdk",
                ),
            }
        )

    @application.post("/api/session-token", response_model=SessionTokenResponse)
    async def create_session_token(payload: SessionTokenRequest) -> SessionTokenResponse:
        if payload.provider is not Provider.OPENAI:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Gemini sessions use the live WebSocket endpoint.",
            )
        try:
            voice = canonicalize_voice(payload.provider, payload.voice)
        except UnsupportedVoiceError as exc:
            allowed = ", ".join(voices_for(exc.provider))
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Unsupported {exc.provider.value} voice. Allowed voices: {allowed}.",
            ) from None

        try:
            async with application.state.concurrency_guard.slot():
                return await mint_openai_token(
                    app_settings, voice, application.state.http_client
                )
        except ConcurrencyLimitExceeded:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="The session token service is busy. Try again shortly.",
                headers={"Retry-After": "1"},
            ) from None
        except ProviderNotConfigured as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"{exc.provider.value.capitalize()} is not configured.",
            ) from None
        except UpstreamTokenError:
            logger.warning(
                "Session token provisioning failed for provider=%s", payload.provider.value
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Unable to create a session token right now.",
            ) from None

    @application.post("/api/tools/web-search", response_model=WebSearchResponse)
    async def web_search(payload: WebSearchRequest) -> WebSearchResponse:
        """Execute OpenAI hosted search for the browser-side Realtime function."""

        try:
            async with application.state.web_search_concurrency_guard.slot():
                return await search_openai_web(
                    app_settings,
                    payload.query,
                    application.state.http_client,
                )
        except ConcurrencyLimitExceeded:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="The web search service is busy. Try again shortly.",
                headers={"Retry-After": "1"},
            ) from None
        except ProviderNotConfigured:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="OpenAI is not configured.",
            ) from None
        except UpstreamSearchError:
            logger.warning("Web search failed for provider=openai")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Unable to search the web right now.",
            ) from None

    async def deny_websocket(
        websocket: WebSocket,
        *,
        status_code: int,
        detail: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        response = _no_store(
            JSONResponse(
                status_code=status_code,
                content={"detail": detail},
                headers=headers,
            )
        )
        try:
            await websocket.send_denial_response(response)
        except RuntimeError:
            # ASGI servers without the denial-response extension can still
            # reject the handshake without accepting an application session.
            await websocket.close(code=1008)

    @application.websocket("/api/live/gemini")
    async def gemini_live(websocket: WebSocket) -> None:
        origins = websocket.headers.getlist("origin")
        if not _origin_is_allowed(origins, app_settings, allowed_origins):
            await deny_websocket(
                websocket,
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Origin is not allowed.",
            )
            return

        voices = websocket.query_params.getlist("voice")
        if len(voices) != 1:
            await deny_websocket(
                websocket,
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Choose exactly one Gemini voice.",
            )
            return
        try:
            voice = canonicalize_voice(Provider.GEMINI, voices[0])
        except UnsupportedVoiceError:
            await deny_websocket(
                websocket,
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    "Unsupported Gemini voice. Allowed voices: "
                    f"{', '.join(voices_for(Provider.GEMINI))}."
                ),
            )
            return

        runtime = application.state.gemini_runtime
        if runtime is None:
            await deny_websocket(
                websocket,
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Gemini is not configured.",
            )
            return

        try:
            await application.state.gemini_live_rate_limiter.check(
                _websocket_client_key(websocket)
            )
        except RateLimitExceeded:
            await deny_websocket(
                websocket,
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many Gemini live sessions. Try again shortly.",
                headers={"Retry-After": "60"},
            )
            return

        try:
            async with application.state.gemini_live_concurrency_guard.slot():
                await websocket.accept()
                await serve_gemini_live(
                    websocket,
                    runtime=runtime,
                    settings=app_settings,
                    voice=voice,
                )
        except ConcurrencyLimitExceeded:
            await deny_websocket(
                websocket,
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="The Gemini live service is busy. Try again shortly.",
                headers={"Retry-After": "1"},
            )

    return application


app = create_app()
