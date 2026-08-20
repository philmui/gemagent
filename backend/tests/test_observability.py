from __future__ import annotations

import logging

import pytest

from app import observability


@pytest.fixture(autouse=True)
def reset_observability(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(observability, "_configured", False)
    monkeypatch.setattr(observability, "dotenv_values", lambda _path: {})
    for key in ("LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"):
        monkeypatch.delenv(key, raising=False)


def test_tracing_is_not_configured_without_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    def fake_configure(**_kwargs: object) -> bool:
        nonlocal called
        called = True
        return True

    monkeypatch.setattr(observability, "configure_google_adk", fake_configure)
    observability.configure_langsmith_google_adk("test")

    assert called is False
    assert observability._configured is False


def test_optional_mcp_probe_is_filtered_but_other_warnings_remain(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "test-key")
    monkeypatch.setattr(observability, "find_spec", lambda _name: None)
    integration_logger = logging.getLogger("langsmith.integrations.google_adk")

    def fake_configure(**_kwargs: object) -> bool:
        integration_logger.warning(
            "Failed to wrap McpTool.run_async: No module named 'mcp'"
        )
        integration_logger.warning("A real ADK wrapper failed")
        return True

    monkeypatch.setattr(observability, "configure_google_adk", fake_configure)
    with caplog.at_level(logging.WARNING):
        observability.configure_langsmith_google_adk("test")

    messages = [record.getMessage() for record in caplog.records]
    assert not any("McpTool.run_async" in message for message in messages)
    assert "A real ADK wrapper failed" in messages
    assert observability._configured is True


def test_tracing_failure_does_not_break_application_startup(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "test-key")
    monkeypatch.setattr(observability, "find_spec", lambda _name: None)

    def fail_configure(**_kwargs: object) -> bool:
        raise RuntimeError("instrumentation failed")

    monkeypatch.setattr(observability, "configure_google_adk", fail_configure)
    with caplog.at_level(logging.WARNING):
        observability.configure_langsmith_google_adk("test")

    assert observability._configured is False
    assert "LangSmith Google ADK tracing remains disabled." in caplog.text


def test_false_configuration_result_is_not_reported_as_enabled(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "test-key")
    monkeypatch.setattr(observability, "find_spec", lambda _name: None)
    monkeypatch.setattr(observability, "configure_google_adk", lambda **_kwargs: False)

    with caplog.at_level(logging.WARNING):
        observability.configure_langsmith_google_adk("test")

    assert observability._configured is False
    assert "LangSmith Google ADK tracing remains disabled." in caplog.text
