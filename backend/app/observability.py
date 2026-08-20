"""Optional, process-wide observability setup.

LangSmith's Google ADK integration must be configured before any ADK agent is
created. Configuration is intentionally opt-in: a missing key or an explicitly
disabled ``LANGSMITH_TRACING`` value leaves the voice gateway unchanged.
"""

from __future__ import annotations

import logging
import os
from importlib.util import find_spec

from dotenv import dotenv_values
from langsmith.integrations.google_adk import configure_google_adk

from .config import ENV_FILE

logger = logging.getLogger(__name__)
_configured = False


class _OptionalMcpProbeFilter(logging.Filter):
    """Hide only LangSmith's probe for ADK's intentionally optional MCP tool."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            record.name == "langsmith.integrations.google_adk"
            and message.startswith("Failed to wrap McpTool.run_async:")
            and "No module named 'mcp" in message
        )


def _configure_google_adk_safely(**kwargs: object) -> bool:
    """Configure tracing without treating an unused ADK extra as a failure.

    LangSmith currently attempts to wrap ``McpTool`` even when the application
    installs base Google ADK and does not use MCP. ADK correctly keeps ``mcp``
    behind its optional extra. Suppress that one known probe only when the MCP
    package is absent; all other integration warnings remain visible.
    """

    integration_logger = logging.getLogger("langsmith.integrations.google_adk")
    optional_mcp_filter = _OptionalMcpProbeFilter()
    suppress_optional_probe = find_spec("mcp") is None
    if suppress_optional_probe:
        integration_logger.addFilter(optional_mcp_filter)
    try:
        return configure_google_adk(**kwargs)
    except Exception:
        # Tracing is explicitly optional and must not prevent the voice gateway
        # from serving traffic. Keep the failure diagnosable without exposing
        # environment values or credentials.
        logger.exception("LangSmith Google ADK tracing could not be configured.")
        return False
    finally:
        if suppress_optional_probe:
            integration_logger.removeFilter(optional_mcp_filter)


def _tracing_enabled() -> bool:
    return os.getenv("LANGSMITH_TRACING", "").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


def configure_langsmith_google_adk(app_env: str) -> None:
    """Enable LangSmith's ADK instrumentation once when it is configured.

    ``BaseSettings`` reads ``.env`` without exporting values to ``os.environ``;
    LangSmith reads its standard variables from the process environment. Copy
    only LangSmith's values from the repository file, without overriding
    deployment-provided variables or making provider credentials global.
    """

    global _configured
    if _configured:
        return

    for key, value in dotenv_values(ENV_FILE).items():
        if key.startswith("LANGSMITH_") and value is not None:
            os.environ.setdefault(key, value)
    if not _tracing_enabled():
        return
    if not os.getenv("LANGSMITH_API_KEY", "").strip():
        logger.warning("LANGSMITH_TRACING is enabled but LANGSMITH_API_KEY is missing.")
        return

    project_name = os.getenv("LANGSMITH_PROJECT", "").strip() or None
    configured = _configure_google_adk_safely(
        project_name=project_name,
        name="voice-lab.gemini-live",
        metadata={"service": "gemvoice-backend", "environment": app_env},
        tags=["voice-lab", "gemini-live", "google-adk"],
    )
    if not configured:
        logger.warning("LangSmith Google ADK tracing remains disabled.")
        return
    _configured = True
    logger.info("LangSmith Google ADK tracing is enabled.")
