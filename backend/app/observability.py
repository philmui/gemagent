"""Optional, process-wide observability setup.

LangSmith's Google ADK integration must be configured before any ADK agent is
created. Configuration is intentionally opt-in: a missing key or an explicitly
disabled ``LANGSMITH_TRACING`` value leaves the voice gateway unchanged.
"""

from __future__ import annotations

import logging
import os

from dotenv import dotenv_values
from langsmith.integrations.google_adk import configure_google_adk

from .config import ENV_FILE


logger = logging.getLogger(__name__)
_configured = False


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
    configure_google_adk(
        project_name=project_name,
        name="voice-lab.gemini-live",
        metadata={"service": "gemvoice-backend", "environment": app_env},
        tags=["voice-lab", "gemini-live", "google-adk"],
    )
    _configured = True
    logger.info("LangSmith Google ADK tracing is enabled.")
