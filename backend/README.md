# Voice gateway backend

This FastAPI service runs Gemini speech sessions through Google ADK 2.6.2 and
keeps the long-lived Gemini credential on the server. OpenAI Realtime remains a
browser-to-provider WebRTC connection. The backend gives the browser only an
OpenAI short-lived client secret. It also runs the protected OpenAI hosted-search
request so the permanent key never enters browser code.

## Run locally

Create the repository-root `.env`, then run:

```bash
cd backend
uv sync --extra dev
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The settings loader always reads `<repository>/.env`, independent of the current
working directory. Shell environment variables take precedence.

## LangSmith observability

Google ADK sessions are automatically traced when the existing root `.env` has
LangSmith enabled. The setup runs before the ADK agent is created, so traces
include the live agent, Gemini model calls, and Google Search tool activity.

```dotenv
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=your_langsmith_api_key
LANGSMITH_PROJECT=voice-lab
# Set this only for a non-US LangSmith deployment.
# LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
```

The backend loads these variables for the LangSmith SDK without overriding
deployment-provided environment variables. Review LangSmith trace retention and
apply its input/output masking controls if voice or transcript content must not
be retained.

## Endpoints

`GET /health` reports each provider's configured state, model, and runtime.

`POST /api/session-token` accepts only OpenAI requests such as:

```json
{"provider": "openai", "voice": "marin"}
```

`POST /api/tools/web-search` accepts a strict OpenAI function request such as:

```json
{"query": "current release notes"}
```

`WS /api/live/gemini?voice=Kore` is the Gemini audio gateway. The browser sends
binary mono PCM16 at 16 kHz. The server returns binary mono PCM16 at 24 kHz.
The only client JSON control is `{"type":"end"}`.

Server JSON messages use this small allowlist:

- `ready` includes provider, model, voice, sample rates, and `google-adk` runtime.
- `caption` includes role, text, item ID, append mode, and final state.
- `interrupted` names the exact assistant item and tells the browser to clear queued audio.
- `tool_activity` contains only a function call or response transition.
- `turn_complete` advances the conversation turn.
- `error` contains a generic, browser-safe message.

Raw ADK events are never serialized to the browser. Each connection receives a
fresh bounded `LiveRequestQueue`, a voice-scoped `RunConfig`, random server IDs,
and an ephemeral ADK session. Audio persistence is disabled and the session is
deleted on every exit path.

## Gemini configuration

Gemini uses Google Cloud Application Default Credentials. No Gemini API key is
accepted or required. Authenticate the local application separately from the
ordinary gcloud CLI session:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Then configure the non-secret Google Cloud routing values in the root `.env`:

```dotenv
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
GEMINI_SEARCH_MODEL=gemini-2.5-flash
```

ADC itself stays in the operating system credential store. Never copy the local
ADC JSON file into `.env`, this repository, or a container image. On Cloud Run,
attach a dedicated service account with Vertex AI User permissions.

Optional live-session controls and their defaults are:

```dotenv
GEMINI_LIVE_RATE_LIMIT=8
GEMINI_LIVE_CONCURRENCY=8
GEMINI_LIVE_MAX_SECONDS=540
GEMINI_LIVE_QUEUE_FRAMES=16
GEMINI_LIVE_MAX_FRAME_BYTES=8192
GEMINI_LIVE_AUDIO_BYTES_PER_SECOND=40000
GEMINI_LIVE_AUDIO_BURST_BYTES=64000
```

The existing `ALLOWED_ORIGINS`, `APP_ENV`, `OPENAI_API_KEY`,
`OPENAI_REALTIME_MODEL`, `OPENAI_SEARCH_MODEL`, `SESSION_TOKEN_RATE_LIMIT`,
`SESSION_TOKEN_CONCURRENCY`, `WEB_SEARCH_RATE_LIMIT`, and
`WEB_SEARCH_CONCURRENCY` settings remain supported.

## Provider-native web search

The Gemini ADK parent agent exposes `google_search_agent`, which delegates to a
dedicated `gemini-2.5-flash` agent with ADK native Google Search. This wrapper
produces a parent function call and response that the gateway can project to the
UI without exposing its arguments or grounded result in telemetry.

OpenAI Realtime exposes a browser Agents SDK function. Its executor calls
`POST /api/tools/web-search`; FastAPI then uses the server-only OpenAI key with
the Responses API hosted `web_search` tool. The endpoint has a 500-character
query limit, exact-origin checks, independent rate and concurrency limits,
bounded results, safe URL filtering, no-store responses, and generic errors.

## Verify

Tests use fake ADK events and mocked HTTP responses, so they make no paid API
calls:

```bash
uv run --extra dev pytest -q
```

## Deployment notes

The container uses one Uvicorn worker and caps incoming WebSocket frames and the
server's WebSocket receive queue. The in-memory ADK session service and abuse
guards are process-local. For a public multi-instance service, use authenticated
callers, a distributed rate limit, and a persistent ADK session backend if
reconnection across instances is required. Configure the Cloud Run request
timeout to exceed `GEMINI_LIVE_MAX_SECONDS`; WebSockets are long-running HTTP
requests. Do not treat the browser `Origin` header as user authentication.
