from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient
from google.adk.events import Event
from google.genai import types
from starlette.testclient import WebSocketDenialResponse

from app.adk_runtime import BoundedLiveRequestQueue, build_run_config
from app.config import Settings
from app.gemini_live import GeminiLiveError, TranscriptCursor, _emit_event
from app.main import create_app


ALLOWED_ORIGIN = "http://localhost:3000"


@dataclass
class RecordingSessionService:
    created: list[dict[str, str]] = field(default_factory=list)
    deleted: list[dict[str, str]] = field(default_factory=list)

    async def create_session(self, **kwargs: str) -> object:
        self.created.append(kwargs)
        return object()

    async def delete_session(self, **kwargs: str) -> None:
        self.deleted.append(kwargs)


class FakeRunner:
    def __init__(self, events: list[Event] | None = None) -> None:
        self.events = events or []
        self.calls: list[dict[str, Any]] = []
        self.audio_requests: list[Any] = []
        self.generator_closed = False

    async def run_live(self, **kwargs: Any) -> AsyncIterator[Event]:
        self.calls.append(kwargs)
        queue = kwargs["live_request_queue"]
        try:
            request = await queue.get()
            if request.close:
                return
            self.audio_requests.append(request)
            for event in self.events:
                yield event
            while True:
                request = await queue.get()
                if request.close:
                    return
                self.audio_requests.append(request)
        finally:
            self.generator_closed = True


class FailingSetupRunner:
    async def run_live(self, **kwargs: Any) -> AsyncIterator[Event]:
        del kwargs
        if False:
            yield Event(invocation_id="never", author="voice_assistant")
        raise RuntimeError("provider setup failed with private details")


class FakeRuntime:
    app_name = "gemini_voice"
    model_name = "gemini-live-2.5-flash-native-audio"

    def __init__(self, events: list[Event] | None = None, queue_frames: int = 2) -> None:
        self.session_service = RecordingSessionService()
        self.runner = FakeRunner(events)
        self.queue_frames = queue_frames
        self.queues: list[BoundedLiveRequestQueue] = []
        self.voices: list[str] = []
        self.closed = False

    def new_live_request_queue(self) -> BoundedLiveRequestQueue:
        queue = BoundedLiveRequestQueue(self.queue_frames)
        self.queues.append(queue)
        return queue

    def run_config(self, voice: str):
        self.voices.append(voice)
        return build_run_config(voice)

    async def close(self) -> None:
        self.closed = True


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "_env_file": None,
        "app_env": "test",
        "google_cloud_project": "voice-test-project",
        "google_cloud_location": "us-central1",
        "allowed_origins_csv": ALLOWED_ORIGIN,
        "gemini_live_rate_limit": 20,
        "gemini_live_concurrency": 4,
    }
    values.update(overrides)
    return Settings(**values)


def make_client(runtime: FakeRuntime, settings: Settings | None = None) -> TestClient:
    return TestClient(
        create_app(
            settings or make_settings(),
            gemini_runtime_factory=lambda _: runtime,  # type: ignore[arg-type]
        )
    )


class RecordingWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.audio: list[bytes] = []

    async def send_json(self, value: dict[str, Any]) -> None:
        self.messages.append(value)

    async def send_bytes(self, value: bytes) -> None:
        self.audio.append(value)


@pytest.mark.asyncio
async def test_transcription_ids_advance_per_role_not_turn_complete() -> None:
    websocket = RecordingWebSocket()
    cursor = TranscriptCursor()

    await _emit_event(
        websocket,
        Event(
            invocation_id="first",
            author="voice_assistant",
            output_transcription=types.Transcription(text="First", finished=False),
            turn_complete=True,
        ),
        cursor,
    )
    await _emit_event(
        websocket,
        Event(
            invocation_id="late-output",
            author="voice_assistant",
            input_transcription=types.Transcription(text="Next question", finished=True),
            output_transcription=types.Transcription(text=" answer", finished=True),
        ),
        cursor,
    )
    await _emit_event(
        websocket,
        Event(
            invocation_id="next-output",
            author="voice_assistant",
            output_transcription=types.Transcription(text="Second", finished=True),
        ),
        cursor,
    )

    captions = [message for message in websocket.messages if message["type"] == "caption"]
    assert [(message["role"], message["item_id"]) for message in captions] == [
        ("assistant", "gemini-assistant-0"),
        ("user", "gemini-user-0"),
        ("assistant", "gemini-assistant-0"),
        ("assistant", "gemini-assistant-1"),
    ]


@pytest.mark.asyncio
async def test_separate_finished_transcript_and_interruption_keep_exact_item() -> None:
    websocket = RecordingWebSocket()
    cursor = TranscriptCursor()

    await _emit_event(
        websocket,
        Event(
            invocation_id="finished-transcript",
            author="voice_assistant",
            output_transcription=types.Transcription(
                text="Cancelled answer", finished=True
            ),
        ),
        cursor,
    )
    await _emit_event(
        websocket,
        Event(
            invocation_id="interrupted-after-flush",
            author="voice_assistant",
            interrupted=True,
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        inline_data=types.Blob(
                            data=b"\x01\x00", mime_type="audio/pcm;rate=24000"
                        )
                    )
                ],
            ),
            turn_complete=True,
        ),
        cursor,
    )

    assert websocket.messages == [
        {
            "type": "caption",
            "role": "assistant",
            "text": "Cancelled answer",
            "item_id": "gemini-assistant-0",
            "mode": "replace",
            "final": True,
        },
        {"type": "interrupted", "item_id": "gemini-assistant-0"},
        {"type": "turn_complete"},
    ]
    assert websocket.audio == []

    await _emit_event(
        websocket,
        Event(
            invocation_id="new-empty-interruption",
            author="voice_assistant",
            interrupted=True,
        ),
        cursor,
    )
    assert websocket.messages[-1] == {
        "type": "interrupted",
        "item_id": "gemini-assistant-1",
    }


@pytest.mark.asyncio
async def test_vad_and_tool_activity_are_projected_without_private_payloads() -> None:
    websocket = RecordingWebSocket()
    cursor = TranscriptCursor()
    private_value = "private-tool-payload"

    await _emit_event(
        websocket,
        Event(
            invocation_id="tool-call-event",
            author="voice_assistant",
            voice_activity=types.VoiceActivity(
                voice_activity_type=types.VoiceActivityType.ACTIVITY_START
            ),
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            id="private-call-id",
                            name="private_tool",
                            args={"value": private_value},
                        )
                    )
                ],
            ),
        ),
        cursor,
    )
    await _emit_event(
        websocket,
        Event(
            invocation_id="tool-return-event",
            author="voice_assistant",
            voice_activity=types.VoiceActivity(
                voice_activity_type=types.VoiceActivityType.ACTIVITY_END
            ),
            content=types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(
                            id="private-call-id",
                            name="private_tool",
                            response={"value": private_value},
                        )
                    )
                ],
            ),
        ),
        cursor,
    )

    assert websocket.messages == [
        {"type": "endpoint", "kind": "speech-start"},
        {"type": "tool_activity", "kind": "call"},
        {"type": "endpoint", "kind": "speech-end"},
        {"type": "tool_activity", "kind": "return"},
    ]
    assert private_value not in repr(websocket.messages)


@pytest.mark.asyncio
@pytest.mark.parametrize("mime_type", ["audio/pcm;rate=16000", "audio/pcm;rate=48000"])
async def test_conflicting_output_sample_rate_is_rejected(mime_type: str) -> None:
    websocket = RecordingWebSocket()
    event = Event(
        invocation_id="wrong-rate",
        author="voice_assistant",
        content=types.Content(
            role="model",
            parts=[
                types.Part(
                    inline_data=types.Blob(data=b"\x01\x00", mime_type=mime_type)
                )
            ],
        ),
    )

    with pytest.raises(GeminiLiveError):
        await _emit_event(websocket, event, TranscriptCursor())
    assert websocket.audio == []


@pytest.mark.parametrize("output_mime_type", ["audio/pcm", "audio/pcm;rate=24000"])
def test_binary_pcm_round_trip_sanitized_events_and_cleanup(
    output_mime_type: str,
) -> None:
    provider_secret = "provider-internal-secret"
    output_audio = b"\x02\x00\x03\x00"
    event = Event(
        invocation_id="internal-invocation",
        author="voice_assistant",
        input_transcription=types.Transcription(text="Hello", finished=True),
        output_transcription=types.Transcription(text="Hi there", finished=True),
        content=types.Content(
            role="model",
            parts=[
                types.Part(
                    inline_data=types.Blob(
                        data=output_audio, mime_type=output_mime_type
                    )
                )
            ],
        ),
        turn_complete=True,
        custom_metadata={"do_not_send": provider_secret},
    )
    runtime = FakeRuntime([event])

    with make_client(runtime) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as websocket:
            assert websocket.receive_json() == {
                "type": "ready",
                "provider": "gemini",
                "model": "gemini-live-2.5-flash-native-audio",
                "voice": "Kore",
                "input_sample_rate": 16_000,
                "output_sample_rate": 24_000,
                "agent_runtime": "google-adk",
            }

            input_audio = b"\x00\x00\x01\x00"
            websocket.send_bytes(input_audio)
            messages: list[Any] = [
                websocket.receive_json(),
                websocket.receive_json(),
                websocket.receive_bytes(),
                websocket.receive_json(),
            ]
            assert messages == [
                {
                    "type": "caption",
                    "role": "user",
                    "text": "Hello",
                    "item_id": "gemini-user-0",
                    "mode": "replace",
                    "final": True,
                },
                {
                    "type": "caption",
                    "role": "assistant",
                    "text": "Hi there",
                    "item_id": "gemini-assistant-0",
                    "mode": "replace",
                    "final": True,
                },
                output_audio,
                {"type": "turn_complete"},
            ]
            assert provider_secret not in repr(messages)

            websocket.send_json({"type": "end"})
            assert websocket.receive()["type"] == "websocket.close"

        assert len(runtime.runner.calls) == 1
        call = runtime.runner.calls[0]
        assert call["user_id"].startswith("browser-")
        assert call["session_id"]
        assert "session" not in call
        assert runtime.voices == ["Kore"]
        config = call["run_config"]
        assert config.save_live_blob is False
        assert config.speech_config.voice_config.prebuilt_voice_config.voice_name == "Kore"
        # The first request is a short silence probe used to prove that ADK has
        # completed upstream setup before the browser receives `ready`.
        assert runtime.runner.audio_requests[0].blob.data == b"\x00\x00" * 320
        request = runtime.runner.audio_requests[1]
        assert request.blob.data == input_audio
        assert request.blob.mime_type == "audio/pcm;rate=16000"
        assert runtime.queues[0].closed is True
        assert runtime.runner.generator_closed is True
        assert runtime.session_service.deleted == runtime.session_service.created

    assert runtime.closed is True


def test_provider_setup_failure_is_safe_and_never_reports_ready() -> None:
    runtime = FakeRuntime()
    runtime.runner = FailingSetupRunner()  # type: ignore[assignment]

    with make_client(runtime) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as websocket:
            assert websocket.receive_json() == {
                "type": "error",
                "message": "Gemini Live could not continue this session.",
            }
            assert websocket.receive()["code"] == 1011

    assert runtime.session_service.deleted == runtime.session_service.created


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "unknown"},
        {"type": "end", "extra": True},
    ],
)
def test_only_exact_end_control_is_allowed(payload: dict[str, Any]) -> None:
    runtime = FakeRuntime()
    with make_client(runtime) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as websocket:
            websocket.receive_json()
            websocket.send_json(payload)
            error = websocket.receive_json()
            assert error == {
                "type": "error",
                "message": "The browser sent an invalid audio or control message.",
            }
            closed = websocket.receive()
            assert closed["type"] == "websocket.close"
            assert closed["code"] == 1008

        assert runtime.queues[0].closed is True
        assert runtime.session_service.deleted == runtime.session_service.created


def test_invalid_audio_frame_is_rejected() -> None:
    runtime = FakeRuntime()
    settings = make_settings(gemini_live_max_frame_bytes=640)
    with make_client(runtime, settings) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as websocket:
            websocket.receive_json()
            websocket.send_bytes(b"\x00" * 642)
            assert websocket.receive_json()["type"] == "error"
            assert websocket.receive()["code"] == 1008


def test_audio_token_bucket_rejects_a_fast_browser_burst() -> None:
    runtime = FakeRuntime(queue_frames=2)
    settings = make_settings(
        gemini_live_max_frame_bytes=8_192,
        gemini_live_audio_burst_bytes=8_192,
        gemini_live_audio_bytes_per_second=32_000,
    )
    with make_client(runtime, settings) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as websocket:
            websocket.receive_json()
            websocket.send_bytes(b"\x00" * 8_192)
            websocket.send_bytes(b"\x00" * 8_192)
            assert websocket.receive_json() == {
                "type": "error",
                "message": "The browser sent an invalid audio or control message.",
            }
            assert websocket.receive()["code"] == 1008


def test_provider_error_text_and_event_are_not_exposed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider_secret = "provider-debug-secret"
    runtime = FakeRuntime(
        [Event(error_code="UPSTREAM", error_message=provider_secret)]
    )
    with caplog.at_level(logging.WARNING), make_client(runtime) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as websocket:
            websocket.receive_json()
            websocket.send_bytes(b"\x00\x00")
            error = websocket.receive_json()
            assert error == {
                "type": "error",
                "message": "Gemini Live could not continue this session.",
            }
            assert websocket.receive()["code"] == 1011

    assert provider_secret not in error["message"] + caplog.text


@pytest.mark.parametrize(
    ("path", "origin", "expected_status"),
    [
        ("/api/live/gemini?voice=Kore", "https://evil.invalid", 403),
        ("/api/live/gemini", ALLOWED_ORIGIN, 422),
        ("/api/live/gemini?voice=unknown", ALLOWED_ORIGIN, 422),
        ("/api/live/gemini?voice=Kore&voice=Puck", ALLOWED_ORIGIN, 422),
    ],
)
def test_handshake_checks_happen_before_session_creation(
    path: str, origin: str, expected_status: int
) -> None:
    runtime = FakeRuntime()
    settings = make_settings(app_env="production")
    with make_client(runtime, settings) as client:
        with pytest.raises(WebSocketDenialResponse) as exc_info:
            with client.websocket_connect(path, headers={"Origin": origin}):
                pass

    assert exc_info.value.status_code == expected_status
    assert runtime.session_service.created == []
    assert exc_info.value.headers["cache-control"].startswith("no-store")


def test_missing_origin_is_denied_in_production() -> None:
    runtime = FakeRuntime()
    with make_client(runtime, make_settings(app_env="production")) as client:
        with pytest.raises(WebSocketDenialResponse) as exc_info:
            with client.websocket_connect("/api/live/gemini?voice=Kore"):
                pass

    assert exc_info.value.status_code == 403
    assert runtime.session_service.created == []


def test_unconfigured_gemini_is_denied_before_accept() -> None:
    settings = make_settings(google_cloud_project=None, google_cloud_location=None)
    application = create_app(settings)
    with TestClient(application) as client:
        with pytest.raises(WebSocketDenialResponse) as exc_info:
            with client.websocket_connect(
                "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
            ):
                pass

    assert exc_info.value.status_code == 503


def test_live_connection_rate_limit_is_separate_and_pre_accept() -> None:
    runtime = FakeRuntime()
    settings = make_settings(gemini_live_rate_limit=1)
    with make_client(runtime, settings) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as first:
            first.receive_json()
            first.send_json({"type": "end"})
            first.receive()

        with pytest.raises(WebSocketDenialResponse) as exc_info:
            with client.websocket_connect(
                "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
            ):
                pass

    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["retry-after"] == "60"
    assert len(runtime.session_service.created) == 1


def test_live_concurrency_is_checked_before_second_accept() -> None:
    runtime = FakeRuntime()
    settings = make_settings(gemini_live_concurrency=1)
    with make_client(runtime, settings) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as first:
            first.receive_json()
            with pytest.raises(WebSocketDenialResponse) as exc_info:
                with client.websocket_connect(
                    "/api/live/gemini?voice=Puck",
                    headers={"Origin": ALLOWED_ORIGIN},
                ):
                    pass
            assert exc_info.value.status_code == 429
            assert exc_info.value.headers["retry-after"] == "1"
            first.send_json({"type": "end"})
            first.receive()

    assert len(runtime.session_service.created) == 1


def test_browser_disconnect_still_closes_queue_and_deletes_session() -> None:
    runtime = FakeRuntime()
    with make_client(runtime) as client:
        with client.websocket_connect(
            "/api/live/gemini?voice=Kore", headers={"Origin": ALLOWED_ORIGIN}
        ) as websocket:
            websocket.receive_json()
            websocket.close()

        assert runtime.queues[0].closed is True
        assert runtime.session_service.deleted == runtime.session_service.created
