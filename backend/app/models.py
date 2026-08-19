"""Validated public API models."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator


class Provider(StrEnum):
    GEMINI = "gemini"
    OPENAI = "openai"


class SessionTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Provider
    voice: str = Field(min_length=1, max_length=64)

    @field_validator("voice")
    @classmethod
    def strip_voice(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("voice cannot be blank")
        return value


class SessionTransport(BaseModel):
    type: Literal["websocket", "webrtc"]
    url: str


class SessionTokenResponse(BaseModel):
    provider: Provider
    token: str
    expires_at: datetime
    model: str
    transport: SessionTransport
    config: dict[str, Any]

    @field_serializer("expires_at")
    def serialize_expiry(self, value: datetime) -> str:
        return value.isoformat().replace("+00:00", "Z")


class WebSearchRequest(BaseModel):
    """Narrow public input accepted from the browser-side Realtime tool."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=500)

    @field_validator("query")
    @classmethod
    def strip_query(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("query cannot be blank")
        return value


class WebSearchSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=2_048)


class WebSearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: str = Field(min_length=1, max_length=12_000)
    sources: list[WebSearchSource] = Field(max_length=8)


class ProviderHealth(BaseModel):
    configured: bool
    model: str
    runtime: Literal["google-adk", "openai-agents-sdk"]


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    providers: dict[Provider, ProviderHealth]
