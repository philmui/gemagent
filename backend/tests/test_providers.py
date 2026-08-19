from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from app import providers
from app.config import Settings
from app.models import Provider


@pytest.mark.asyncio
async def test_openai_payload_headers_and_normalized_response(settings: Settings) -> None:
    captured: dict[str, Any] = {}
    expiry = int(datetime(2026, 8, 5, 12, 1, tzinfo=UTC).timestamp())

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["payload"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "value": "openai-ephemeral-token",
                "expires_at": expiry,
                "session": {"model": "gpt-realtime-2.1"},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await providers.mint_openai_token(settings, "marin", client)

    assert captured["url"] == "https://api.openai.com/v1/realtime/client_secrets"
    assert captured["headers"]["authorization"] == "Bearer openai-long-lived-test-key"
    safety_identifier = captured["headers"]["openai-safety-identifier"]
    assert safety_identifier.startswith("anonymous_")
    assert len(safety_identifier) <= 64
    assert all(character.isalnum() or character in "-_" for character in safety_identifier)
    payload = captured["payload"]
    assert payload["expires_after"] == {"anchor": "created_at", "seconds": 60}
    session = payload["session"]
    assert session["type"] == "realtime"
    assert session["model"] == "gpt-realtime-2.1"
    assert session["output_modalities"] == ["audio"]
    assert session["reasoning"] == {"effort": "low"}
    assert session["audio"]["input"]["transcription"] == {
        "model": "gpt-live-transcribe",
        "delay": "low",
    }
    assert session["audio"]["input"]["turn_detection"] == {
        "type": "server_vad",
        "create_response": True,
        "interrupt_response": True,
    }
    assert session["audio"]["output"] == {"voice": "marin"}
    assert "concise voice assistant" in session["instructions"]

    assert result.provider is Provider.OPENAI
    assert result.token == "openai-ephemeral-token"
    assert result.expires_at == datetime.fromtimestamp(expiry, tz=UTC)
    assert result.model == "gpt-realtime-2.1"
    assert result.transport.type == "webrtc"
    assert result.transport.url == "https://api.openai.com/v1/realtime/calls"
    assert "instructions" not in result.config


@pytest.mark.asyncio
async def test_openai_effective_model_mismatch_fails_closed(settings: Settings) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "value": "openai-ephemeral-token",
                "expires_at": 1_800_000_000,
                "session": {"model": "unexpected-model"},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(providers.UpstreamTokenError):
            await providers.mint_openai_token(settings, "marin", client)


@pytest.mark.asyncio
async def test_openai_web_search_is_forced_and_results_are_bounded(settings: Settings) -> None:
    captured: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["payload"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "web_search_call",
                        "action": {
                            "sources": [
                                {"title": "Primary", "url": "https://example.test/a"},
                                {"title": "Duplicate", "url": "https://example.test/a"},
                                {"title": "Unsafe", "url": "file:///private/result"},
                            ]
                        },
                    },
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "A current, grounded answer.",
                                "annotations": [
                                    {"title": "Second", "url": "https://example.test/b"}
                                ],
                            }
                        ],
                    },
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await providers.search_openai_web(settings, "current answer", client)

    assert captured["url"] == "https://api.openai.com/v1/responses"
    assert captured["headers"]["authorization"] == "Bearer openai-long-lived-test-key"
    assert captured["payload"]["model"] == "gpt-5.6"
    assert captured["payload"]["tools"] == [{"type": "web_search"}]
    assert captured["payload"]["tool_choice"] == "required"
    assert captured["payload"]["input"] == "current answer"
    assert captured["payload"]["store"] is False
    assert result.answer == "A current, grounded answer."
    assert [source.url for source in result.sources] == [
        "https://example.test/a",
        "https://example.test/b",
    ]


@pytest.mark.asyncio
async def test_openai_web_search_rejects_malformed_provider_output(settings: Settings) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(200, json={"output": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(providers.UpstreamSearchError):
            await providers.search_openai_web(settings, "current answer", client)
