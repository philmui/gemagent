# Troubleshooting

Start with the first symptom that matches what you see. The application intentionally returns generic provider errors, so combine browser state, safe health metadata, and backend error categories without printing credentials or raw provider bodies.

## Fast triage

Check that both processes answer:

```bash
curl --fail --silent http://127.0.0.1:8000/health
curl --fail --silent http://localhost:3000/ > /dev/null
```

Then verify the configured provider and runtime in `/health`:

```json
{
  "configured": true,
  "model": "gemini-live-2.5-flash-native-audio",
  "runtime": "google-adk"
}
```

The health route does not call a provider. `configured: true` proves only that required local settings are present.

## The backend does not start

Run it from the backend directory:

```bash
cd backend
uv sync --extra dev
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Common causes:

- Python is older than 3.11 or newer than the declared range.
- Dependencies were installed outside the backend's uv environment.
- Another service owns port 8000.
- An environment value fails validation.
- Vertex AI mode, project, location, or model is missing or invalid.
- `ALLOWED_ORIGINS` contains `*`, a path, credentials, or an invalid scheme.

Check the port without stopping an unrelated process:

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
```

## The frontend does not start

```bash
cd app
npm install
npm run dev
```

Node.js must be 22.13 or newer. If port 3000 is occupied, Next.js may select another port. Add that exact origin to `ALLOWED_ORIGINS`, then restart FastAPI.

If the browser still targets the wrong backend, confirm `app/.env.local` contains:

```dotenv
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
```

Restart Next.js after editing the file. For a production build, rebuild and redeploy because `NEXT_PUBLIC_` values are compiled into browser JavaScript at build time.

## A provider says backend configuration is missing

Read `/health` and check the matching root `.env` setting.

Gemini requires these exact Vertex AI settings:

```dotenv
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your_project
GOOGLE_CLOUD_LOCATION=us-central1
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
```

It also requires Application Default Credentials and a quota project. Locally:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project your_project
```

OpenAI requires:

```dotenv
OPENAI_API_KEY=your_real_key
```

The backend reads the repository-root `.env` through a deterministic path. It does not read `backend/.env` or `app/.env.local` for provider configuration. Google credentials come from standard ADC lookup outside the repository. Restart FastAPI after a change.

Confirm that `GOOGLE_CLOUD_PROJECT` is a real project ID, not
`your_google_cloud_project_id`, `YOUR_PROJECT_ID`, or a project display name.
The project must have Vertex AI enabled, and your ADC principal and quota
project must be authorized for it. Restart FastAPI after correcting the value.

## Origin is not allowed

Origins match scheme, hostname, and port exactly:

- `http://localhost:3000` differs from `http://127.0.0.1:3000`.
- `https://voice.example.com` differs from `http://voice.example.com`.
- `https://voice.example.com` differs from `https://voice.example.com:8443`.
- An origin never contains `/path`.

Use a root `.env` value such as:

```dotenv
ALLOWED_ORIGINS=http://localhost:3000
```

Multiple production origins are comma separated:

```dotenv
ALLOWED_ORIGINS=https://voice.example.com,https://voice-staging.example.com
```

Do not use a wildcard. In production, an API request or WebSocket without exactly one allowed `Origin` is rejected.

## Microphone permission is denied

1. Use `localhost`, `127.0.0.1`, or HTTPS.
2. Open the site permission control beside the address bar.
3. Set Microphone to Allow.
4. Check operating-system microphone privacy settings.
5. Reload and press the orb again.

`NotAllowedError` usually means permission was denied. `NotFoundError` usually means no input device is available. Close conferencing software if it owns the microphone exclusively.

## Gemini WebSocket fails before Ready

The Gemini browser path does not call `/api/session-token`. It opens:

```text
/api/live/gemini?voice=Kore
```

Check, in order:

1. `/health` says Gemini is configured.
2. The browser request uses `ws://` for local HTTP or `wss://` for HTTPS.
3. The `Origin` is exact.
4. The query contains exactly one supported voice.
5. A proxy or firewall allows WebSocket upgrade.
6. The rate or concurrency limit has not been reached.
7. The selected model is enabled for the Google project and endpoint.
8. The backend can reach Google over the network.

The gateway sends `ready` only after ADK consumes its short silence setup probe. If upstream setup cannot reach that point before the setup timeout, the socket ends without becoming Active.

Handshake outcomes have useful meanings:

| Status | Likely cause |
|---|---|
| 403 | Origin policy failed |
| 422 | Voice query is missing, repeated, or unsupported |
| 429 | New-session rate or live concurrency limit reached |
| 503 | Gemini configuration is missing |

After the socket is accepted, close code 1008 means the browser violated the audio or control protocol. Close code 1011 means the ADK or provider path could not continue safely.

## Vertex AI ADC authentication fails

Confirm:

- `GOOGLE_GENAI_USE_VERTEXAI=true`;
- `GOOGLE_CLOUD_PROJECT` names the intended quota and Vertex AI project;
- `GOOGLE_CLOUD_LOCATION=us-central1`, or another region listed for the model;
- `GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio`;
- local ADC is current, or the Cloud Run service identity is attached;
- the identity has suitable Vertex AI permission;
- the ADC quota project matches `GOOGLE_CLOUD_PROJECT`;
- billing and quota are available;
- `aiplatform.googleapis.com` is enabled.

Do not use `global` for `gemini-live-2.5-flash-native-audio`. A Live handshake
can be accepted locally and then close with policy code 1008 when the model is
unavailable at the selected endpoint. Check the current
[model-supported regions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api).

If an older local file contains `gemini-3.1-flash-live-preview`, do not assume it
is the latest model for this path. Google documents that ID for the Gemini
Developer API. This application requires Vertex AI with ADC, so use only a
model and region explicitly listed by the current Vertex model card.

Reset and verify local ADC:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
gcloud auth application-default print-access-token > /dev/null
cd backend
uv run python -c \
  'import google.auth; c,_=google.auth.default(); print(getattr(c, "quota_project_id", None))'
```

The last command should print `YOUR_PROJECT_ID`. It does not print a token.

On Cloud Run, inspect which service account the revision actually uses:

```bash
gcloud run services describe voice-backend \
  --format='value(spec.template.spec.serviceAccountName)'
```

Do not solve this by copying local ADC JSON or a downloaded service-account key into `.env`, the frontend, Docker context, image, or Cloud Run. On Cloud Run, do not set `GOOGLE_APPLICATION_CREDENTIALS`. Attach the intended user-managed service account instead.

## Gemini connects but hears nothing

The browser must send binary, signed PCM16 little-endian frames at 16 kHz. The current AudioWorklet performs the conversion.

Check:

- the microphone track remains `live`;
- Mute is not active;
- the worklet script loaded successfully;
- frames are binary, not base64 JSON;
- every frame has an even nonzero byte length;
- one frame stays below `GEMINI_LIVE_MAX_FRAME_BYTES`;
- the average stream stays within the configured byte rate;
- the browser socket `bufferedAmount` is not saturated.

The default 40 ms frame contains 640 PCM samples, or 1280 bytes. A custom recorder that sends Float32, WAV headers, stereo data, or 48 kHz samples will not satisfy the protocol.

## Gemini response audio is fast, slow, clipped, or silent

Gemini input and output rates differ:

- input: PCM16 at 16 kHz;
- output: PCM16 at 24 kHz.

Playing output at 16 kHz changes pitch and speed. Also check signed conversion, little-endian order, clipping, chunk order, a closed `AudioContext`, and stale playback from an earlier session.

Google ADK may label valid output as either `audio/pcm` or
`audio/pcm;rate=24000`. The Live API fixes output at 24 kHz, so the gateway
accepts both forms and rejects an explicitly conflicting rate. If captions
arrive and the session then closes before audio, check this MIME boundary first.

If the user interrupts Gemini, the browser should clear queued playback. Failure to clear it can make an old answer continue after the UI says Listening.

## Gemini final captions repeat earlier words

ADK live transcription sends partial text during the turn and a cumulative finished transcription. The gateway must label partial text with `mode: "append"` and the finished value with `mode: "replace"` for the same item ID. If the finished value is appended, the final caption repeats everything already shown.

Run the backend transcript and round-trip tests, then confirm the browser protocol parser preserves the `mode` field.

## Gemini session ends after a fixed duration

The backend intentionally ends the socket at `GEMINI_LIVE_MAX_SECONDS`, which
defaults to 540 seconds. The selected model documents a default 10-minute
conversation boundary. This application does not enable session resumption, so
the one-minute headroom lets it close the socket cleanly before the provider
boundary. Cloud Run also applies its request timeout to WebSockets.

Ensure:

```text
Cloud Run request timeout > GEMINI_LIVE_MAX_SECONDS
```

The deployment tutorial uses a 600-second Cloud Run timeout with the 540-second
application limit. Do not increase the application limit past the model boundary
without implementing and testing the provider's session-extension mechanism.

Voice Lab reports the disconnect and asks the user to start a new session. It does not claim to resume deleted in-memory conversation state.

## Function activity stays Ready

Ready means the selected agent has a search function available, not that every turn
must call it. Greetings, arithmetic, and stable facts usually produce no markers. Ask
something unambiguously current, such as “What changed in today’s major browser
releases?”

Expected lifecycle:

```text
Ready -> Calling -> Response
```

The upper timeline dot is the function call. The lower dot is its response. The UI
intentionally does not display the query, tool result, call ID, or provider payload.
The assistant’s speech and caption are the user-facing result.

For Gemini, verify:

1. `GEMINI_SEARCH_MODEL=gemini-2.5-flash` is valid in the configured Vertex AI
   project and location.
2. The attached identity or local ADC principal has Vertex AI permission.
3. Startup constructs `GoogleSearchAgentTool` named `google_search_agent` with one
   native `GoogleSearchTool`.
4. The parent Live model is allowed to call functions. ADK then emits a function
   call and function response for the gateway to sanitize.

For OpenAI, verify:

1. The OpenAI project key can use both Realtime and the Responses API.
2. `OPENAI_SEARCH_MODEL=gpt-5.6` is available to the project.
3. Browser developer tools show `POST /api/tools/web-search` after Realtime emits
   the function call.
4. The endpoint returns 200. Status 429 means its independent search limit was
   reached, 502 means the hosted search failed, and 503 means OpenAI is not
   configured.

Test only the endpoint status without printing a search result:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  -X POST http://127.0.0.1:8000/api/tools/web-search \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  --data '{"query":"current OpenAI API documentation"}'
```

Expected status is 200. This makes a billable hosted search request. Unit tests use
mocked provider responses and make no paid API calls.

## OpenAI client-secret request fails

The browser posts only an allowed provider and voice to `/api/session-token`:

```json
{"provider":"openai","voice":"marin"}
```

Gemini is intentionally rejected on this route because Gemini uses the ADK WebSocket.

To test the OpenAI route without printing its successful credential:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  -X POST http://127.0.0.1:8000/api/session-token \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  --data '{"provider":"openai","voice":"marin"}'
```

Expected status is 200. Common failures:

| Status | Meaning |
|---|---|
| 403 | Origin is not allowed |
| 422 | Body or voice validation failed |
| 429 | Rate or concurrency limit reached |
| 502 | OpenAI rejected or failed the client-secret request |
| 503 | OpenAI key is not configured |

The application deliberately does not expose the OpenAI upstream response body.

## OpenAI connects but no audio plays

Check:

1. The browser supports WebRTC and `getUserMedia`.
2. The custom media stream was passed to `OpenAIRealtimeWebRTC`.
3. The remote audio element is allowed to play after the user's click. Voice Lab
   now verifies the remote track and awaits `audio.play()` before reporting the
   session ready, so a browser block appears as an actionable error.
4. The short-lived client secret did not expire before connection.
5. A corporate network is not blocking required WebRTC traffic.
6. The selected output device and tab are not muted.

The browser implementation uses `RealtimeAgent`, `RealtimeSession`, and `OpenAIRealtimeWebRTC` from `@openai/agents/realtime`. Do not replace the client secret with the standard OpenAI key.

## OpenAI captions are missing or duplicated

Captions come from Agents SDK `history_updated` events. Voice Lab deduplicates by item ID, text, and final state.

Confirm the session configuration enables input transcription and that `gpt-live-transcribe` is available. A caption can lag audio and can differ from what the model heard. Missing captions do not necessarily mean the audio transport is silent.

## The provider switch gets stuck

Expected sequence:

```text
Switching -> old adapter closed -> new adapter connecting -> Active
```

Check:

1. The old microphone tracks have `readyState: ended`.
2. The old Gemini WebSocket or OpenAI `RealtimeSession` closed.
3. Gemini queued playback was cleared.
4. Only the latest session epoch can update the UI.
5. The replacement provider is configured.
6. A late error from the old session is ignored.

Stop the session if a network or browser fault prevents complete cleanup, then start again. The implementation intentionally awaits old adapter cleanup before opening the new provider, so a hung browser media API can delay the switch instead of creating two microphone owners.

## Selected model never becomes Active model

Selected means the UI choice is ready to be used. Active appears only after the adapter completes its readiness contract. On Gemini, it means the backend ADK gateway session and event stream are ready. It does not prove that Vertex AI has already processed audio.

For Gemini, validate the backend `ready` message includes the expected provider, voice, sample rates, and `agent_runtime: "google-adk"`.

For OpenAI, `RealtimeSession.connect(...)` must complete using the returned model and client secret. If connection fails, the UI should enter Error with no active provider.

## Tests fail after an SDK upgrade

The backend includes compatibility coverage around the bounded subclass of ADK `LiveRequestQueue`. Google ADK currently creates an internal queue whose public send methods do not await backpressure, so this application replaces that internal queue with a bounded one and adds an awaited send method.

After changing `google-adk` or `google-genai`:

```bash
cd backend
uv lock
uv sync --extra dev
uv run pytest
```

Review `LiveRequestQueue`, `Runner.run_live`, `RunConfig`, transcription events, and multi-part live events against current [ADK streaming documentation](https://adk.dev/streaming/configuration/). A passing import is not enough.

After changing `@openai/agents`:

```bash
cd app
npm install
npm run check
```

Review `RealtimeSession` events, transport options, history items, and client-secret setup against the current [OpenAI voice-agent documentation](https://developers.openai.com/api/docs/guides/voice-agents).

## Safe diagnostic rules

- Do not print `.env`.
- Do not paste keys into commands or issue descriptions.
- Do not log complete headers.
- Do not print a successful `/api/session-token` body.
- Do not log binary audio, full transcripts, full ADK events, SDP, or provider response bodies.
- Record error type and sanitized category, not exception text that might carry request data.

If the problem remains, collect browser version, selected provider, safe health response, HTTP or WebSocket status, close code, and sanitized backend error category. That is usually enough to reproduce the failure without collecting speech or credentials.
