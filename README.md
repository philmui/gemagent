# Voice Lab

Voice Lab is a polished browser speech-to-speech application with an immediate provider switch. Choose Gemini Live or OpenAI Realtime in Settings, speak naturally, and see the active model and live captions while you talk.

Both providers can search the live web. Gemini uses a Google ADK search function
backed by native Google Search. OpenAI Realtime uses an Agents SDK function that
calls the backend and the Responses API hosted `web_search` tool. The live signal
monitor shows each function call and response without exposing query or result
content in telemetry.

![Voice Lab routes Gemini through a FastAPI Google ADK gateway and connects OpenAI through the browser Agents SDK](docs/images/dual-provider-architecture.svg)

The two providers use deliberately different agent runtimes:

| Provider | Agent runtime | Browser transport | Audio route | Default model |
|---|---|---|---|---|
| Gemini Live | Google ADK 2.6.2 in FastAPI | Binary WebSocket | Browser to backend to Vertex AI | `gemini-live-2.5-flash-native-audio` |
| OpenAI Realtime | OpenAI Agents SDK 0.14.0 in the browser | WebRTC | Browser to OpenAI | `gpt-realtime-2.1` |

Gemini authentication is mandatory Vertex AI Application Default Credentials. Local ADC stays in the Google Cloud CLI credential store outside this repository. Cloud Run uses an attached service identity. The root `.env` contains nonsecret Vertex AI settings and the server-only OpenAI key. The frontend receives no Google credential and only a short-lived OpenAI Realtime client secret. Switching providers closes the old transport, releases its microphone and playback resources, and starts a new isolated conversation.

Model IDs are API-surface specific. Google currently documents
`gemini-3.1-flash-live-preview` for the Gemini Developer API, while this
organization-required Vertex AI and ADC path uses the Vertex-listed GA
`gemini-live-2.5-flash-native-audio`. Do not copy a Developer API model ID into
this configuration unless the current Vertex model card explicitly lists it.

## Start locally

Prerequisites:

- Backend: Python 3.11 through 3.14 and [uv](https://docs.astral.sh/uv/)
- Frontend: Node.js 22.13 or newer and npm
- Google Cloud CLI access to a Vertex AI project
- An OpenAI API key

From the repository root:

```bash
cp .env.example .env
cp app/.env.local.example app/.env.local
```

Authenticate local ADC and select its quota project:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Open `.env`, replace `your_google_cloud_project_id` with the exact Vertex AI
project, and replace the OpenAI placeholder. The placeholder is not a valid
project setting. Restart FastAPI whenever `.env` changes. Then install and test
the backend:

```bash
cd backend
uv sync --extra dev
uv run pytest
```

Start FastAPI in terminal one:

```bash
cd backend
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Install and start Next.js in terminal two:

```bash
cd app
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), allow microphone access, and press the center orb. Settings lets you switch providers immediately.

## Documentation

- [Installation and local setup](docs/installation.md)
- [Step-by-step user guide](docs/user-guide.md)
- [Architecture and protocol](docs/architecture.md)
- [Cloud Run deployment](docs/deployment.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Codex adversarial review record](docs/adversarial-review.md)

## Verify the repository

```bash
cd backend
uv run pytest
cd ../app
npm run check
```

`npm run check` runs linting, TypeScript checking, unit tests, and a production build.

## Official references

- [Vertex AI Live API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api)
- [Gemini 2.5 Flash Live model regions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api)
- [Gemini Developer API Live overview](https://ai.google.dev/gemini-api/docs/live-api)
- [Vertex AI release notes for Gemini 2.5 Flash Native Audio](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes)
- [Google Agent Development Kit](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk)
- [ADK streaming configuration](https://adk.dev/streaming/configuration/)
- [OpenAI voice agents](https://developers.openai.com/api/docs/guides/voice-agents)
- [OpenAI Realtime over WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
