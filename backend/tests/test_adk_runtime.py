from __future__ import annotations

import asyncio

import pytest
from google.adk.agents import LiveRequestQueue
from google.adk.agents.run_config import StreamingMode
from google.adk.models import Gemini
from google.adk.tools.google_search_agent_tool import GoogleSearchAgentTool
from google.adk.tools.google_search_tool import GoogleSearchTool
from google.genai import types

from app.adk_runtime import (
    BoundedLiveRequestQueue,
    build_gemini_adk_runtime,
    build_run_config,
)
from app.config import Settings


def test_run_config_is_audio_only_private_and_voice_scoped() -> None:
    config = build_run_config("Kore")

    assert config.streaming_mode is StreamingMode.BIDI
    assert config.response_modalities == [types.Modality.AUDIO]
    assert config.speech_config.voice_config.prebuilt_voice_config.voice_name == "Kore"
    assert config.input_audio_transcription is not None
    assert config.output_audio_transcription is not None
    assert config.context_window_compression.trigger_tokens == 25_000
    assert config.context_window_compression.sliding_window.target_tokens == 8_000
    assert config.save_live_blob is False


@pytest.mark.asyncio
async def test_bounded_live_queue_applies_backpressure_and_closes() -> None:
    queue = BoundedLiveRequestQueue(maxsize=1)
    assert isinstance(queue, LiveRequestQueue)
    first_blob = types.Blob(data=b"\x00\x00", mime_type="audio/pcm;rate=16000")
    second_blob = types.Blob(data=b"\x01\x00", mime_type="audio/pcm;rate=16000")

    await queue.send_realtime_wait(first_blob)
    blocked_send = asyncio.create_task(queue.send_realtime_wait(second_blob))
    await asyncio.sleep(0)
    assert blocked_send.done() is False

    first = await queue.get()
    await blocked_send
    assert first.blob == first_blob
    assert queue.maxsize == 1

    # The queue is full here. close() must still insert its terminal request.
    queue.close()
    terminal = await queue.get()
    assert terminal.close is True
    assert queue.closed is True


@pytest.mark.asyncio
async def test_google_cloud_runtime_uses_adc_project_location_and_ga_model() -> None:
    settings = Settings(
        _env_file=None,
        google_cloud_project="voice-project",
        google_cloud_location="us-central1",
    )
    runtime = build_gemini_adk_runtime(settings)
    try:
        model = runtime.app.root_agent.model
        assert isinstance(model, Gemini)
        assert model.model == "gemini-live-2.5-flash-native-audio"
        assert model.client_kwargs == {
            "enterprise": True,
            "project": "voice-project",
            "location": "us-central1",
        }
        assert runtime.runner.app is runtime.app
        assert len(runtime.app.root_agent.tools) == 1
        search_tool = runtime.app.root_agent.tools[0]
        assert isinstance(search_tool, GoogleSearchAgentTool)
        assert search_tool.name == "google_search_agent"
        assert isinstance(search_tool.agent.model, Gemini)
        assert search_tool.agent.model.model == "gemini-2.5-flash"
        assert search_tool.agent.model.client_kwargs == model.client_kwargs
        assert len(search_tool.agent.tools) == 1
        assert isinstance(search_tool.agent.tools[0], GoogleSearchTool)
    finally:
        await runtime.close()


def test_google_cloud_runtime_rejects_missing_adc_configuration() -> None:
    settings = Settings(_env_file=None, google_cloud_project="voice-project")

    with pytest.raises(ValueError, match="GOOGLE_CLOUD_LOCATION"):
        build_gemini_adk_runtime(settings)
