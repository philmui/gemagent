from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings
from app.main import create_app
from app.models import (
    Provider,
    SessionTokenResponse,
    SessionTransport,
    WebSearchResponse,
    WebSearchSource,
)


def _session_response(provider: Provider, voice: str) -> SessionTokenResponse:
    return SessionTokenResponse(
        provider=provider,
        token=f"{provider.value}-short-lived-token",
        expires_at=datetime.now(UTC) + timedelta(seconds=60),
        model=(
            "gemini-live-2.5-flash-native-audio"
            if provider is Provider.GEMINI
            else "gpt-realtime-2.1"
        ),
        transport=SessionTransport(
            type="websocket" if provider is Provider.GEMINI else "webrtc",
            url="wss://gemini.example.test" if provider is Provider.GEMINI else "https://openai.test",
        ),
        config={"voice": voice},
    )


def test_health_exposes_readiness_and_models_but_not_keys(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "providers": {
                "gemini": {
                    "configured": True,
                    "model": "gemini-live-2.5-flash-native-audio",
                    "runtime": "google-adk",
                },
                "openai": {
                    "configured": True,
                    "model": "gpt-realtime-2.1",
                    "runtime": "openai-agents-sdk",
                },
        }
    }
    assert "long-lived" not in response.text


def test_missing_openai_key_disables_only_openai() -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        google_cloud_project="voice-project",
        google_cloud_location="us-central1",
        openai_api_key=None,
        allowed_origins_csv="http://localhost:3000",
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/health")

    assert response.json()["providers"]["gemini"]["configured"] is True
    assert response.json()["providers"]["openai"]["configured"] is False


@pytest.mark.parametrize(
    ("provider", "voice"),
    [("openai", "Kore"), ("openai", "unknown")],
)
def test_provider_specific_voice_validation(
    client: TestClient, provider: str, voice: str
) -> None:
    response = client.post(
        "/api/session-token",
        headers={"Origin": "http://localhost:3000"},
        json={"provider": provider, "voice": voice},
    )

    assert response.status_code == 422
    assert "Unsupported" in response.json()["detail"]
    assert response.headers["cache-control"].startswith("no-store")


def test_voice_is_canonicalized_and_response_is_no_store(
    monkeypatch: pytest.MonkeyPatch, client: TestClient
) -> None:
    seen: dict[str, str] = {}

    async def fake_mint(
        settings: Settings, voice: str, http_client: httpx.AsyncClient
    ) -> SessionTokenResponse:
        del settings, http_client
        seen["voice"] = voice
        return _session_response(Provider.OPENAI, voice)

    monkeypatch.setattr(main, "mint_openai_token", fake_mint)
    response = client.post(
        "/api/session-token",
        headers={"Origin": "http://localhost:3000"},
        json={"provider": "openai", "voice": "MARIN"},
    )

    assert response.status_code == 200
    assert seen["voice"] == "marin"
    assert response.json()["config"]["voice"] == "marin"
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_missing_openai_key_returns_safe_503() -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        google_cloud_project=None,
        google_cloud_location=None,
        openai_api_key=None,
        allowed_origins_csv="http://localhost:3000",
    )
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/session-token",
            headers={"Origin": "http://localhost:3000"},
            json={"provider": "openai", "voice": "marin"},
        )

    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]
    assert "key" not in response.text.lower()


def test_gemini_is_not_minted_through_the_openai_token_endpoint(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/session-token",
        headers={"Origin": "http://localhost:3000"},
        json={"provider": "gemini", "voice": "Kore"},
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Gemini sessions use the live WebSocket endpoint."
    }
    assert response.headers["cache-control"].startswith("no-store")


def test_exact_origin_enforcement_in_production() -> None:
    settings = Settings(
        _env_file=None,
        app_env="production",
        allowed_origins_csv="https://voice.example.test",
    )
    with TestClient(create_app(settings)) as client:
        no_origin = client.post(
            "/api/session-token", json={"provider": "openai", "voice": "marin"}
        )
        wrong_origin = client.post(
            "/api/session-token",
            headers={"Origin": "https://voice.example.test.evil.invalid"},
            json={"provider": "openai", "voice": "marin"},
        )
        exact_origin = client.post(
            "/api/session-token",
            headers={"Origin": "https://voice.example.test"},
            json={"provider": "openai", "voice": "marin"},
        )

    assert no_origin.status_code == 403
    assert wrong_origin.status_code == 403
    assert exact_origin.status_code == 503
    assert no_origin.headers["cache-control"].startswith("no-store")


def test_cors_preflight_uses_the_same_exact_allowlist(client: TestClient) -> None:
    allowed = client.options(
        "/api/session-token",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    denied = client.options(
        "/api/session-token",
        headers={
            "Origin": "http://localhost:3000.evil.invalid",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


def test_missing_origin_is_allowed_for_local_non_browser_clients() -> None:
    settings = Settings(
        _env_file=None,
        app_env="development",
        allowed_origins_csv="http://localhost:3000",
    )
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/session-token", json={"provider": "openai", "voice": "marin"}
        )

    assert response.status_code == 503


def test_endpoint_rate_limit_is_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        openai_api_key="configured",
        allowed_origins_csv="http://localhost:3000",
        session_token_rate_limit=1,
    )

    async def fake_mint(
        settings: Settings, voice: str, http_client: httpx.AsyncClient
    ) -> SessionTokenResponse:
        del settings, http_client
        return _session_response(Provider.OPENAI, voice)

    monkeypatch.setattr(main, "mint_openai_token", fake_mint)
    with TestClient(create_app(settings)) as client:
        first = client.post(
            "/api/session-token", json={"provider": "openai", "voice": "marin"}
        )
        second = client.post(
            "/api/session-token", json={"provider": "openai", "voice": "marin"}
        )

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.headers["retry-after"] == "60"
    assert second.headers["cache-control"].startswith("no-store")


def test_invalid_bodies_do_not_bypass_the_rate_limit() -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        allowed_origins_csv="http://localhost:3000",
        session_token_rate_limit=1,
    )
    with TestClient(create_app(settings)) as client:
        invalid = client.post(
            "/api/session-token", json={"provider": "gemini", "api_key": "do-not-reflect"}
        )
        limited = client.post(
            "/api/session-token", json={"provider": "gemini", "voice": "Kore"}
        )

    assert invalid.status_code == 422
    assert "do-not-reflect" not in invalid.text
    assert limited.status_code == 429


def test_upstream_error_does_not_leak_secrets_or_body(
    caplog: pytest.LogCaptureFixture,
) -> None:
    long_lived_key = "openai-super-secret-key"
    upstream_secret = "provider-debug-secret"
    settings = Settings(
        _env_file=None,
        app_env="test",
        openai_api_key=long_lived_key,
        allowed_origins_csv="http://localhost:3000",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text=f"bad key {upstream_secret}")

    application = create_app(
        settings,
        http_client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    with caplog.at_level(logging.WARNING), TestClient(application) as client:
        response = client.post(
            "/api/session-token", json={"provider": "openai", "voice": "marin"}
        )

    combined = response.text + caplog.text
    assert response.status_code == 502
    assert response.json() == {"detail": "Unable to create a session token right now."}
    assert long_lived_key not in combined
    assert upstream_secret not in combined
    assert response.headers["cache-control"].startswith("no-store")


def test_extra_request_fields_are_rejected_and_not_cached(client: TestClient) -> None:
    response = client.post(
        "/api/session-token",
        json={"provider": "gemini", "voice": "Kore", "api_key": "client-secret"},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Request validation failed."}
    assert "client-secret" not in response.text
    assert response.headers["cache-control"].startswith("no-store")


def test_web_search_endpoint_returns_only_bounded_public_results(
    monkeypatch: pytest.MonkeyPatch,
    client: TestClient,
) -> None:
    seen: dict[str, str] = {}

    async def fake_search(
        settings: Settings,
        query: str,
        http_client: httpx.AsyncClient,
    ) -> WebSearchResponse:
        del settings, http_client
        seen["query"] = query
        return WebSearchResponse(
            answer="Grounded answer",
            sources=[WebSearchSource(title="Source", url="https://example.test/source")],
        )

    monkeypatch.setattr(main, "search_openai_web", fake_search)
    response = client.post(
        "/api/tools/web-search",
        headers={"Origin": "http://localhost:3000"},
        json={"query": "  what changed today?  "},
    )

    assert response.status_code == 200
    assert seen["query"] == "what changed today?"
    assert response.json() == {
        "answer": "Grounded answer",
        "sources": [{"title": "Source", "url": "https://example.test/source"}],
    }
    assert response.headers["cache-control"] == "no-store, max-age=0"


def test_web_search_has_an_independent_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        openai_api_key="configured",
        allowed_origins_csv="http://localhost:3000",
        session_token_rate_limit=20,
        web_search_rate_limit=1,
    )

    async def fake_search(
        settings: Settings,
        query: str,
        http_client: httpx.AsyncClient,
    ) -> WebSearchResponse:
        del settings, query, http_client
        return WebSearchResponse(answer="Answer", sources=[])

    monkeypatch.setattr(main, "search_openai_web", fake_search)
    with TestClient(create_app(settings)) as client:
        first = client.post("/api/tools/web-search", json={"query": "first"})
        second = client.post("/api/tools/web-search", json={"query": "second"})
        session = client.post(
            "/api/session-token",
            json={"provider": "openai", "voice": "not-supported"},
        )

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.headers["retry-after"] == "60"
    assert session.status_code == 422


def test_web_search_upstream_error_does_not_leak_keys_or_provider_body(
    caplog: pytest.LogCaptureFixture,
) -> None:
    long_lived_key = "openai-search-secret-key"
    upstream_secret = "search-provider-debug-secret"
    settings = Settings(
        _env_file=None,
        app_env="test",
        openai_api_key=long_lived_key,
        allowed_origins_csv="http://localhost:3000",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(401, text=f"rejected {upstream_secret}")

    application = create_app(
        settings,
        http_client_factory=lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ),
    )
    with caplog.at_level(logging.WARNING), TestClient(application) as client:
        response = client.post(
            "/api/tools/web-search",
            json={"query": "current documentation"},
        )

    combined = response.text + caplog.text
    assert response.status_code == 502
    assert response.json() == {"detail": "Unable to search the web right now."}
    assert long_lived_key not in combined
    assert upstream_secret not in combined
