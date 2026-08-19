"""Reusable Google ADK runtime for Gemini Live speech sessions."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from google.adk.agents import Agent, LiveRequest, LiveRequestQueue, RunConfig
from google.adk.agents.run_config import StreamingMode
from google.adk.apps import App
from google.adk.models import Gemini
from google.adk.runners import Runner
from google.adk.sessions import BaseSessionService, InMemorySessionService
from google.adk.tools.google_search_agent_tool import (
    GoogleSearchAgentTool,
    create_google_search_agent,
)
from google.genai import types

from .config import Settings
from .observability import configure_langsmith_google_adk


ADK_APP_NAME = "gemini_voice"
ADK_AGENT_NAME = "voice_assistant"

GEMINI_SYSTEM_INSTRUCTION = (
    "You are a warm, concise voice assistant. Answer naturally in the user's language. "
    "Keep most replies to one or two short sentences. If audio is unclear, ask a brief "
    "clarifying question. Use the google_search_agent tool for current information, recent "
    "events, or facts you are not confident are current. Briefly identify important sources "
    "in your spoken response. Never claim to have completed an action you did not complete."
)


class QueueClosedError(RuntimeError):
    pass


class BoundedLiveRequestQueue(LiveRequestQueue):
    """ADK live request queue with bounded audio buffering and async backpressure.

    ADK 2.6.2 constructs an unbounded ``asyncio.Queue`` internally and its public
    send methods use ``put_nowait``. The gateway needs a hard bound because its
    input is an untrusted browser WebSocket. This subclass preserves ADK's public
    queue type and ``get`` contract while adding the awaited method used here.
    A compatibility test protects this small integration seam on ADK upgrades.
    """

    def __init__(self, maxsize: int) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be positive")
        super().__init__()
        self._queue = asyncio.Queue(maxsize=maxsize)
        self._closed = False
        self._first_request_consumed = asyncio.Event()

    @property
    def maxsize(self) -> int:
        return self._queue.maxsize

    @property
    def closed(self) -> bool:
        return self._closed

    async def send_realtime_wait(self, blob: types.Blob) -> None:
        if self._closed:
            raise QueueClosedError("live request queue is closed")
        await self._queue.put(LiveRequest(blob=blob))

    async def get(self) -> LiveRequest:
        request = await self._queue.get()
        self._first_request_consumed.set()
        return request

    async def wait_until_consumed(self) -> None:
        """Wait until ADK has opened the live flow and begun draining input."""

        await self._first_request_consumed.wait()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        close_request = LiveRequest(close=True)
        try:
            self._queue.put_nowait(close_request)
        except asyncio.QueueFull:
            # Closing must never block indefinitely behind browser audio. Drop
            # one queued frame so ADK can observe the terminal signal.
            self._queue.get_nowait()
            self._queue.put_nowait(close_request)


def build_run_config(voice: str) -> RunConfig:
    """Create the session-specific ADK configuration for native audio."""

    return RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=[types.Modality.AUDIO],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=25_000,
            sliding_window=types.SlidingWindow(target_tokens=8_000),
        ),
        # Audio blobs must never be persisted by the ADK session service.
        save_live_blob=False,
    )


@dataclass
class GeminiAdkRuntime:
    """Application-scoped ADK objects shared by live connections."""

    app: App
    runner: Runner
    session_service: BaseSessionService
    model_name: str
    queue_frames: int

    @property
    def app_name(self) -> str:
        return self.app.name

    def new_live_request_queue(self) -> BoundedLiveRequestQueue:
        return BoundedLiveRequestQueue(self.queue_frames)

    def run_config(self, voice: str) -> RunConfig:
        return build_run_config(voice)

    async def close(self) -> None:
        await self.runner.close()


def _gemini_client_kwargs(settings: Settings) -> dict[str, object]:
    if not settings.gemini_configured:
        raise ValueError(
            "Gemini on Google Cloud requires GOOGLE_GENAI_USE_VERTEXAI=true, "
            "GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION"
        )
    return {
        # google-genai 2.x names the current Google Cloud mode `enterprise`.
        # It is the successor to the legacy `vertexai=True` flag and uses ADC.
        "enterprise": True,
        "project": settings.google_cloud_project,
        "location": settings.google_cloud_location,
    }


def build_gemini_adk_runtime(
    settings: Settings,
    *,
    session_service: BaseSessionService | None = None,
) -> GeminiAdkRuntime:
    """Build the reusable Agent, App, and Runner without opening a provider call."""

    # This must happen before constructing any ADK agent so LangSmith can wrap
    # the full live agent, tool, and Gemini model execution tree.
    configure_langsmith_google_adk(settings.app_env)

    model = Gemini(
        model=settings.gemini_live_model,
        # Explicit Google Cloud options force ADC and prevent an ambient API key
        # from changing the authentication mode. ADK excludes this field from repr.
        client_kwargs=_gemini_client_kwargs(settings),
    )
    search_model = Gemini(
        model=settings.gemini_search_model,
        client_kwargs=_gemini_client_kwargs(settings),
    )
    search_tool = GoogleSearchAgentTool(create_google_search_agent(search_model))
    agent = Agent(
        name=ADK_AGENT_NAME,
        model=model,
        instruction=GEMINI_SYSTEM_INSTRUCTION,
        tools=[search_tool],
    )
    adk_app = App(name=ADK_APP_NAME, root_agent=agent)
    sessions = session_service or InMemorySessionService()
    runner = Runner(app=adk_app, session_service=sessions)
    return GeminiAdkRuntime(
        app=adk_app,
        runner=runner,
        session_service=sessions,
        model_name=settings.gemini_live_model,
        queue_frames=settings.gemini_live_queue_frames,
    )
