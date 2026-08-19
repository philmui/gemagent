from __future__ import annotations

from pathlib import Path

import pytest

from app.config import ENV_FILE, REPOSITORY_ROOT, Settings


def test_env_file_is_deterministically_the_repository_root() -> None:
    assert REPOSITORY_ROOT == Path(__file__).resolve().parents[2]
    assert ENV_FILE == REPOSITORY_ROOT / ".env"


def test_settings_repr_masks_openai_key() -> None:
    settings = Settings(
        _env_file=None,
        openai_api_key="openai-secret-value",
    )

    rendered = repr(settings)
    assert "openai-secret-value" not in rendered


def test_documented_openai_placeholder_is_not_treated_as_configured() -> None:
    settings = Settings(_env_file=None, openai_api_key="your_openai_api_key")

    assert settings.openai_configured is False


def test_google_cloud_backend_uses_adc_project_and_location_readiness() -> None:
    incomplete = Settings(
        _env_file=None,
        google_cloud_project="voice-project",
    )
    configured = Settings(
        _env_file=None,
        google_cloud_project=" voice-project ",
        google_cloud_location=" us-central1 ",
    )

    assert incomplete.gemini_configured is False
    assert configured.gemini_configured is True
    assert configured.google_cloud_project == "voice-project"
    assert configured.google_cloud_location == "us-central1"


def test_documented_project_placeholder_is_not_treated_as_configured() -> None:
    settings = Settings(
        _env_file=None,
        google_cloud_project="your_google_cloud_project_id",
        google_cloud_location="us-central1",
    )

    assert settings.gemini_configured is False


def test_disabling_vertex_ai_disables_gemini_even_with_project() -> None:
    settings = Settings(
        _env_file=None,
        google_genai_use_vertexai=False,
        google_cloud_project="voice-project",
        google_cloud_location="us-central1",
    )

    assert settings.gemini_configured is False


def test_origins_are_trimmed_deduplicated_and_exact() -> None:
    settings = Settings(
        _env_file=None,
        allowed_origins_csv=" http://localhost:3000/,https://example.test,http://localhost:3000 ",
    )

    assert settings.allowed_origins == (
        "http://localhost:3000",
        "https://example.test",
    )


def test_wildcard_origin_is_rejected() -> None:
    settings = Settings(_env_file=None, allowed_origins_csv="*")

    with pytest.raises(ValueError, match="wildcard"):
        _ = settings.allowed_origins


@pytest.mark.parametrize(
    "origin",
    ["https://example.test/path", "https://user@example.test", "null", "javascript:alert(1)"],
)
def test_non_origin_urls_are_rejected(origin: str) -> None:
    settings = Settings(_env_file=None, allowed_origins_csv=origin)

    with pytest.raises(ValueError, match="exact HTTP"):
        _ = settings.allowed_origins
