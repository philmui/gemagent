"""Application settings loaded from the repository-root ``.env`` file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# config.py -> app -> backend -> repository root. This deliberately avoids
# find_dotenv(), whose search result changes with the process working directory.
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPOSITORY_ROOT / ".env"


class Settings(BaseSettings):
    """Server-only configuration.

    SecretStr keeps long-lived credentials out of reprs, validation errors, and
    accidental structured logging.
    """

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        populate_by_name=True,
    )

    app_env: Literal["development", "test", "production"] = Field(
        default="development", validation_alias="APP_ENV"
    )
    openai_api_key: SecretStr | None = Field(default=None, validation_alias="OPENAI_API_KEY")

    google_genai_use_vertexai: bool = Field(
        default=True, validation_alias="GOOGLE_GENAI_USE_VERTEXAI"
    )
    google_cloud_project: str | None = Field(
        default=None, validation_alias="GOOGLE_CLOUD_PROJECT"
    )
    google_cloud_location: str | None = Field(
        default=None, validation_alias="GOOGLE_CLOUD_LOCATION"
    )

    gemini_live_model: str = Field(
        default="gemini-live-2.5-flash-native-audio", validation_alias="GEMINI_LIVE_MODEL"
    )
    gemini_search_model: str = Field(
        default="gemini-2.5-flash", validation_alias="GEMINI_SEARCH_MODEL"
    )
    openai_realtime_model: str = Field(
        default="gpt-realtime-2.1", validation_alias="OPENAI_REALTIME_MODEL"
    )
    openai_search_model: str = Field(
        default="gpt-5.6", validation_alias="OPENAI_SEARCH_MODEL"
    )
    allowed_origins_csv: str = Field(
        default="http://localhost:3000", validation_alias="ALLOWED_ORIGINS"
    )
    session_token_rate_limit: int = Field(
        default=12, ge=1, le=10_000, validation_alias="SESSION_TOKEN_RATE_LIMIT"
    )
    session_token_concurrency: int = Field(
        default=4, ge=1, le=1_000, validation_alias="SESSION_TOKEN_CONCURRENCY"
    )
    web_search_rate_limit: int = Field(
        default=30, ge=1, le=10_000, validation_alias="WEB_SEARCH_RATE_LIMIT"
    )
    web_search_concurrency: int = Field(
        default=8, ge=1, le=1_000, validation_alias="WEB_SEARCH_CONCURRENCY"
    )
    gemini_live_rate_limit: int = Field(
        default=8, ge=1, le=10_000, validation_alias="GEMINI_LIVE_RATE_LIMIT"
    )
    gemini_live_concurrency: int = Field(
        default=8, ge=1, le=1_000, validation_alias="GEMINI_LIVE_CONCURRENCY"
    )
    gemini_live_max_seconds: int = Field(
        default=540, ge=15, le=3_600, validation_alias="GEMINI_LIVE_MAX_SECONDS"
    )
    gemini_live_queue_frames: int = Field(
        default=16, ge=1, le=256, validation_alias="GEMINI_LIVE_QUEUE_FRAMES"
    )
    gemini_live_max_frame_bytes: int = Field(
        default=8_192,
        ge=640,
        le=65_536,
        validation_alias="GEMINI_LIVE_MAX_FRAME_BYTES",
    )
    gemini_live_audio_bytes_per_second: int = Field(
        default=40_000,
        ge=32_000,
        le=256_000,
        validation_alias="GEMINI_LIVE_AUDIO_BYTES_PER_SECOND",
    )
    gemini_live_audio_burst_bytes: int = Field(
        default=64_000,
        ge=8_192,
        le=1_000_000,
        validation_alias="GEMINI_LIVE_AUDIO_BURST_BYTES",
    )

    @field_validator(
        "gemini_live_model",
        "gemini_search_model",
        "openai_realtime_model",
        "openai_search_model",
    )
    @classmethod
    def validate_model_name(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("model names must contain between 1 and 200 characters")
        return value

    @field_validator("google_cloud_project", "google_cloud_location")
    @classmethod
    def normalize_optional_google_setting(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value or len(value) > 200:
            raise ValueError("Google Cloud settings must contain between 1 and 200 characters")
        return value

    @property
    def allowed_origins(self) -> tuple[str, ...]:
        origins = tuple(
            dict.fromkeys(origin.strip().rstrip("/") for origin in self.allowed_origins_csv.split(","))
        )
        origins = tuple(origin for origin in origins if origin)
        if not origins:
            raise ValueError("ALLOWED_ORIGINS must contain at least one exact origin")
        if "*" in origins:
            raise ValueError("ALLOWED_ORIGINS cannot use a wildcard")
        for origin in origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError(
                    "ALLOWED_ORIGINS entries must be exact HTTP(S) origins without paths"
                )
        return origins

    @property
    def gemini_configured(self) -> bool:
        project = self.google_cloud_project
        return bool(
            self.google_genai_use_vertexai
            and project
            and project.casefold() not in {"your_google_cloud_project_id", "your-project-id"}
            and self.google_cloud_location
        )

    @property
    def openai_configured(self) -> bool:
        return _has_secret(self.openai_api_key)


def _has_secret(value: SecretStr | None) -> bool:
    if value is None:
        return False
    candidate = value.get_secret_value().strip()
    return bool(
        candidate
        and candidate.casefold() not in {"your_openai_api_key", "your-openai-api-key"}
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
