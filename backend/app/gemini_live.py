"""Sanitized browser WebSocket bridge to Gemini Live through Google ADK."""

from __future__ import annotations

import asyncio
from contextlib import aclosing
from dataclasses import dataclass, field
import json
import logging
import secrets
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
from google.genai import types

from .adk_runtime import GeminiAdkRuntime
from .config import Settings


logger = logging.getLogger(__name__)

INPUT_SAMPLE_RATE = 16_000
OUTPUT_SAMPLE_RATE = 24_000
INPUT_MIME_TYPE = f"audio/pcm;rate={INPUT_SAMPLE_RATE}"
OUTPUT_MIME_TYPE = f"audio/pcm;rate={OUTPUT_SAMPLE_RATE}"
# Gemini Live output has a fixed 24 kHz PCM contract. google-genai currently
# emits the canonical MIME type without a rate parameter, while older ADK test
# fixtures and some provider versions include the explicit rate.
SUPPORTED_OUTPUT_MIME_TYPES = frozenset({"audio/pcm", OUTPUT_MIME_TYPE})
MAX_CONTROL_MESSAGE_CHARS = 1_024
MAX_CAPTION_CHARS = 16_000
MAX_OUTPUT_AUDIO_CHUNK_BYTES = 1_000_000
PROVIDER_SETUP_TIMEOUT_SECONDS = 15
PROVIDER_PROBE_AUDIO = b"\x00\x00" * 320


class ClientProtocolError(Exception):
    pass


class GeminiLiveError(Exception):
    pass


@dataclass
class TranscriptCursor:
    user_turn: int = 0
    assistant_turn: int = 0
    active_assistant_item_id: str | None = None
    seen_tool_activity: set[str] = field(default_factory=set)

    def item_id(self, role: str) -> str:
        turn = self.user_turn if role == "user" else self.assistant_turn
        return f"gemini-{role}-{turn}"

    def finish(self, role: str) -> None:
        if role == "user":
            self.user_turn += 1
        else:
            self.assistant_turn += 1

    def observe(self, role: str, item_id: str) -> None:
        if role == "assistant":
            self.active_assistant_item_id = item_id

    def interruption_item_id(self) -> str:
        return self.active_assistant_item_id or self.item_id("assistant")

    def complete_turn(self) -> None:
        self.active_assistant_item_id = None

    def observe_tool_activity(self, kind: str, activity_id: str) -> bool:
        key = f"{kind}:{activity_id}"
        if key in self.seen_tool_activity:
            return False
        self.seen_tool_activity.add(key)
        return True


async def _send_error(websocket: WebSocket, message: str) -> None:
    try:
        await websocket.send_json({"type": "error", "message": message})
    except (RuntimeError, WebSocketDisconnect):
        pass


def _parse_control(text: str) -> str:
    if len(text) > MAX_CONTROL_MESSAGE_CHARS:
        raise ClientProtocolError
    try:
        value = json.loads(text)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ClientProtocolError from exc
    if not isinstance(value, dict) or set(value) != {"type"} or value.get("type") != "end":
        raise ClientProtocolError
    return "end"


async def _browser_to_adk(
    websocket: WebSocket,
    runtime: GeminiAdkRuntime,
    queue: Any,
    settings: Settings,
) -> None:
    del runtime
    loop = asyncio.get_running_loop()
    last_refill = loop.time()
    audio_tokens = float(settings.gemini_live_audio_burst_bytes)

    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return

        audio = message.get("bytes")
        if audio is not None:
            if (
                not audio
                or len(audio) % 2 != 0
                or len(audio) > settings.gemini_live_max_frame_bytes
            ):
                raise ClientProtocolError

            now = loop.time()
            audio_tokens = min(
                float(settings.gemini_live_audio_burst_bytes),
                audio_tokens
                + max(0.0, now - last_refill)
                * settings.gemini_live_audio_bytes_per_second,
            )
            last_refill = now
            if len(audio) > audio_tokens:
                raise ClientProtocolError
            audio_tokens -= len(audio)

            await queue.send_realtime_wait(
                types.Blob(data=bytes(audio), mime_type=INPUT_MIME_TYPE)
            )
            continue

        text = message.get("text")
        if text is None or _parse_control(text) != "end":
            raise ClientProtocolError
        return


async def _send_transcription(
    websocket: WebSocket,
    *,
    role: str,
    transcription: types.Transcription | None,
    cursor: TranscriptCursor,
) -> None:
    if transcription is None:
        return
    item_id = cursor.item_id(role)
    cursor.observe(role, item_id)
    if transcription.text:
        await websocket.send_json(
            {
                "type": "caption",
                "role": role,
                "text": transcription.text[:MAX_CAPTION_CHARS],
                "item_id": item_id,
                # ADK streams partial chunks, then emits the cumulative final
                # transcript. Replace on final to avoid duplicating text.
                "mode": "replace" if transcription.finished else "append",
                "final": bool(transcription.finished),
            }
        )
    if transcription.finished:
        # Input and output transcription completion can arrive independently of
        # the model turn-complete marker. Advance each role only on its own signal.
        cursor.finish(role)


async def _emit_event(
    websocket: WebSocket,
    event: Any,
    cursor: TranscriptCursor,
) -> None:
    # Never serialize the complete ADK Event. It can contain internal IDs,
    # usage details, tool data, or provider error text.
    if getattr(event, "error_code", None) or getattr(event, "error_message", None):
        raise GeminiLiveError

    voice_activity = getattr(event, "voice_activity", None)
    voice_activity_type = getattr(voice_activity, "voice_activity_type", None)
    voice_activity_value = getattr(voice_activity_type, "value", voice_activity_type)
    endpoint_kind = {
        "ACTIVITY_START": "speech-start",
        "ACTIVITY_END": "speech-end",
    }.get(voice_activity_value)
    if endpoint_kind:
        await websocket.send_json({"type": "endpoint", "kind": endpoint_kind})

    event_identity = str(
        getattr(event, "id", None) or getattr(event, "invocation_id", "event")
    )
    for kind, activities in (
        ("call", event.get_function_calls()),
        ("return", event.get_function_responses()),
    ):
        for index, activity in enumerate(activities):
            activity_id = str(getattr(activity, "id", None) or f"{event_identity}:{index}")
            if cursor.observe_tool_activity(kind, activity_id):
                # Tool names, IDs, arguments, and results stay inside ADK. The
                # browser receives only the activity transition needed by the UI.
                await websocket.send_json({"type": "tool_activity", "kind": kind})

    await _send_transcription(
        websocket,
        role="user",
        transcription=getattr(event, "input_transcription", None),
        cursor=cursor,
    )

    await _send_transcription(
        websocket,
        role="assistant",
        transcription=getattr(event, "output_transcription", None),
        cursor=cursor,
    )

    # Project captions first so an interruption can mark the current assistant
    # item before the browser clears queued audio.
    if getattr(event, "interrupted", False):
        await websocket.send_json(
            {"type": "interrupted", "item_id": cursor.interruption_item_id()}
        )

    # ADK marks content on an interrupted response as ignorable. Never enqueue
    # a cancelled PCM tail after the browser has cleared its playback buffer.
    if not getattr(event, "interrupted", False):
        content = getattr(event, "content", None)
        for part in (content.parts if content and content.parts else []):
            blob = part.inline_data
            if blob is None or not blob.data or not blob.mime_type:
                continue
            if not blob.mime_type.startswith("audio/pcm"):
                continue
            if (
                blob.mime_type not in SUPPORTED_OUTPUT_MIME_TYPES
                or len(blob.data) % 2 != 0
                or len(blob.data) > MAX_OUTPUT_AUDIO_CHUNK_BYTES
            ):
                raise GeminiLiveError
            await websocket.send_bytes(blob.data)

    if getattr(event, "turn_complete", False):
        await websocket.send_json({"type": "turn_complete"})
        cursor.complete_turn()


async def _adk_to_browser(
    websocket: WebSocket,
    runtime: GeminiAdkRuntime,
    queue: Any,
    user_id: str,
    session_id: str,
    voice: str,
    browser_ready: asyncio.Event,
) -> None:
    """Forward a Gemini ADK live-event stream to the browser.

    Starts an ADK bidirectional live run for the existing user/session, consuming
    browser audio from ``queue`` and receiving provider events in return. Provider
    events are held until ``browser_ready`` is set, then validated and projected
    onto the browser WebSocket by ``_emit_event``.

    The async event generator is always closed on normal completion, cancellation,
    or failure. Exceptions from ADK, the provider connection, event validation, or
    WebSocket transmission intentionally propagate to ``serve_gemini_live``, which
    maps them to browser errors and performs session cleanup.
    """
    cursor = TranscriptCursor()
    events = runtime.runner.run_live(
        user_id=user_id,
        session_id=session_id,
        live_request_queue=queue,
        run_config=runtime.run_config(voice),
    )
    async with aclosing(events) as event_stream:
        async for event in event_stream:
            await browser_ready.wait()
            await _emit_event(websocket, event, cursor)


async def serve_gemini_live(
    websocket: WebSocket,
    *,
    runtime: GeminiAdkRuntime,
    settings: Settings,
    voice: str,
) -> None:
    """Serve one accepted WebSocket and clean every ADK resource on exit."""

    user_id = f"browser-{secrets.token_urlsafe(18)}"
    session_id = secrets.token_urlsafe(24)
    queue: Any | None = None
    session_created = False
    tasks: set[asyncio.Task[None]] = set()
    setup_waiter: asyncio.Task[None] | None = None
    close_code = 1000
    browser_ready = asyncio.Event()

    try:
        queue = runtime.new_live_request_queue()
        await runtime.session_service.create_session(
            app_name=runtime.app_name,
            user_id=user_id,
            session_id=session_id,
        )
        session_created = True
        async with asyncio.timeout(settings.gemini_live_max_seconds):
            # ADK exposes provider setup through its async generator rather than
            # a public connection callback. A short silence probe is consumed
            # only after the upstream Live connection has completed setup.
            await queue.send_realtime_wait(
                types.Blob(data=PROVIDER_PROBE_AUDIO, mime_type=INPUT_MIME_TYPE)
            )
            adk_task = asyncio.create_task(
                _adk_to_browser(
                    websocket,
                    runtime,
                    queue,
                    user_id,
                    session_id,
                    voice,
                    browser_ready,
                ),
                name="gemini-adk-to-browser",
            )
            tasks.add(adk_task)
            setup_waiter = asyncio.create_task(
                queue.wait_until_consumed(), name="gemini-provider-setup"
            )
            setup_done, _ = await asyncio.wait(
                {setup_waiter, adk_task},
                timeout=PROVIDER_SETUP_TIMEOUT_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not setup_done:
                raise GeminiLiveError
            if adk_task in setup_done:
                adk_task.result()
                raise GeminiLiveError

            await websocket.send_json(
                {
                    "type": "ready",
                    "provider": "gemini",
                    "model": runtime.model_name,
                    "voice": voice,
                    "input_sample_rate": INPUT_SAMPLE_RATE,
                    "output_sample_rate": OUTPUT_SAMPLE_RATE,
                    "agent_runtime": "google-adk",
                }
            )
            browser_ready.set()
            tasks.add(
                asyncio.create_task(
                    _browser_to_adk(websocket, runtime, queue, settings),
                    name="gemini-browser-to-adk",
                )
            )
            done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                task.result()
            queue.close()
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    except TimeoutError:
        close_code = 1000
        await _send_error(websocket, "The Gemini voice session reached its time limit.")
    except ClientProtocolError:
        close_code = 1008
        await _send_error(websocket, "The browser sent an invalid audio or control message.")
    except WebSocketDisconnect:
        close_code = 1000
    except GeminiLiveError:
        close_code = 1011
        logger.warning("Gemini ADK returned an unsafe or invalid live event")
        await _send_error(websocket, "Gemini Live could not continue this session.")
    except Exception as exc:
        close_code = 1011
        # Exception text can include provider request details. Log only its type.
        logger.warning("Gemini ADK session failed type=%s", type(exc).__name__)
        await _send_error(websocket, "Gemini Live could not continue this session.")
    finally:
        if setup_waiter is not None and not setup_waiter.done():
            setup_waiter.cancel()
            await asyncio.gather(setup_waiter, return_exceptions=True)
        if queue is not None:
            queue.close()
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if session_created:
            try:
                await runtime.session_service.delete_session(
                    app_name=runtime.app_name,
                    user_id=user_id,
                    session_id=session_id,
                )
            except Exception as exc:
                logger.warning("ADK session cleanup failed type=%s", type(exc).__name__)
        try:
            await websocket.close(code=close_code)
        except (RuntimeError, WebSocketDisconnect):
            pass
