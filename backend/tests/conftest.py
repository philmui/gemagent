from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        app_env="test",
        google_cloud_project="voice-test-project",
        google_cloud_location="us-central1",
        openai_api_key="openai-long-lived-test-key",
        allowed_origins_csv="http://localhost:3000,https://voice.example.test",
        session_token_rate_limit=20,
        session_token_concurrency=4,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client
