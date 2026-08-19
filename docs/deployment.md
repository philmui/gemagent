# Deploy to Google Cloud Run

This tutorial deploys FastAPI and Next.js as separate Cloud Run services. Gemini always runs through Vertex AI with Application Default Credentials. The backend service identity supplies Google authentication. Secret Manager supplies only the OpenAI project key.

![Production deployment with Cloud Run, workload identity, Google ADK, and OpenAI WebRTC](images/dual-provider-architecture.svg)

Cloud Run supports WebSockets and containerized ADK applications. Read the official [Cloud Run WebSocket guidance](https://docs.cloud.google.com/run/docs/triggering/websockets), [Cloud Run service identity guide](https://docs.cloud.google.com/run/docs/securing/service-identity), and [ADK on Cloud Run guide](https://docs.cloud.google.com/run/docs/ai/build-and-deploy-ai-agents/deploy-adk-agent) before operating at scale.

## Production decisions to make first

Choose:

- the Google Cloud project and Cloud Run region;
- the public frontend hostname;
- a maximum instance count that caps concurrent cost exposure;
- whether unauthenticated public access is acceptable;
- user authentication and distributed quota enforcement for a real product;
- logging retention, provider data controls, and incident owners.

This tutorial uses the supported `us-central1` Vertex AI model location. The
model does not accept the `global` endpoint. Check the official
[Gemini 2.5 Flash Live API model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api)
before choosing another supported model region. The Vertex AI model location is
separate from the Cloud Run region where the container executes.

The current model card lists December 13, 2026 as the retirement date. Add a
model lifecycle alert and complete a tested migration before that date. Do not
silently substitute a new model because live audio, transcription, voice,
location, and ADK compatibility can change together.

This sample applies exact origins and process-local limits, but it does not implement user accounts. Do not treat source IP as a reliable user identity behind a public edge.

## 1. Initialize Google Cloud

Authenticate the deployer and select a project:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud config set run/region us-central1
```

Enable the required services:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com
```

## 2. Create the backend service identity

Create a dedicated user-managed service account:

```bash
gcloud iam service-accounts create voice-backend \
  --display-name="Voice Lab backend"
```

Its full identity is:

```text
voice-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Grant the narrowest Vertex AI permission needed by the live model. Vertex AI User is the standard predefined role for this application:

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:voice-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

The deployer also needs permission to attach this identity, commonly Service Account User on this service account. See [configure Cloud Run service identity](https://docs.cloud.google.com/run/docs/configuring/services/service-identity) for the exact IAM relationship.

Cloud Run obtains ADC for the attached identity from the metadata server. Never copy a local ADC JSON file into the repository, Docker build context, image, Secret Manager, or Cloud Run filesystem. Never set `GOOGLE_APPLICATION_CREDENTIALS` on the Cloud Run service. Google explicitly recommends the attached user-managed service identity for this case.

## 3. Store the OpenAI key

Create the secret:

```bash
gcloud secrets create openai-api-key --replication-policy=automatic
```

Add its value without placing it in a command argument:

```bash
gcloud secrets versions add openai-api-key --data-file=-
```

Paste the key, then send end-of-file with Ctrl+D.

Grant the backend identity access to this one secret:

```bash
gcloud secrets add-iam-policy-binding openai-api-key \
  --member="serviceAccount:voice-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Use a numbered version such as `:1` in the service revision. A numbered version makes rollout and rollback predictable.

There is no Google credential secret binding. Vertex AI authentication comes only from the attached service identity.

## 4. Deploy the backend

The repository-root Dockerfile creates a non-root backend image from the reviewed
`backend/uv.lock`. Run the command from the repository root so the build context
includes the backend lockfile and package:

```bash
gcloud run deploy voice-backend \
  --source . \
  --allow-unauthenticated \
  --service-account="voice-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --set-secrets="OPENAI_API_KEY=openai-api-key:1" \
  --set-env-vars="APP_ENV=production,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_LOCATION=us-central1,ALLOWED_ORIGINS=https://frontend.example.com,GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio,GEMINI_SEARCH_MODEL=gemini-2.5-flash,OPENAI_REALTIME_MODEL=gpt-realtime-2.1,OPENAI_SEARCH_MODEL=gpt-5.6,GEMINI_LIVE_MAX_SECONDS=540" \
  --timeout=600 \
  --concurrency=8 \
  --max-instances=5 \
  --cpu=2 \
  --memory=1Gi
```

Replace the project identity, OpenAI secret version, origin, limits, CPU, memory, and instance cap for your environment.

Keep the source argument as `.` because Cloud Run detects the repository-root
Dockerfile there. Python dependency resolution remains isolated to the backend
through `backend/pyproject.toml` and `backend/uv.lock`.

The required Gemini values are:

```dotenv
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
GOOGLE_CLOUD_LOCATION=us-central1
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
GEMINI_SEARCH_MODEL=gemini-2.5-flash
```

Do not add a Google credential file or key environment variable. A revision that lacks the attached service identity or suitable Vertex AI IAM permission must fail instead of falling back to another authentication profile.

Google's [ADK overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk) also describes Agent Runtime and GKE targets. This repository currently exposes a custom FastAPI binary WebSocket, so moving it to Agent Runtime would require an explicit transport integration. The Cloud Run path above runs the existing application unchanged.

## 5. Discover and test the backend URL

Read the deployed URL:

```bash
gcloud run services describe voice-backend \
  --format='value(status.url)'
```

Confirm the attached service account:

```bash
gcloud run services describe voice-backend \
  --format='value(spec.template.spec.serviceAccountName)'
```

Test only the safe health route:

```bash
curl --fail --silent https://YOUR_BACKEND_HOST/health
```

The route should report `google-adk`, `gemini-live-2.5-flash-native-audio`, and `openai-agents-sdk`. It should never reveal a credential or make a provider call.

Do not test `/api/session-token` in a shared console because its successful response contains a short-lived OpenAI client secret.

## 6. Deploy the frontend

`NEXT_PUBLIC_BACKEND_URL` is public and is compiled into the browser bundle during `next build`. Set it as a build environment variable, not only as a Cloud Run runtime variable. This follows the [Next.js environment variable behavior](https://nextjs.org/docs/pages/guides/environment-variables) and the [Cloud Run build environment guide](https://docs.cloud.google.com/run/docs/configuring/services/build-environment-variables).

From the repository root:

```bash
gcloud run deploy voice-frontend \
  --source app \
  --allow-unauthenticated \
  --set-build-env-vars="NEXT_PUBLIC_BACKEND_URL=https://YOUR_BACKEND_HOST" \
  --max-instances=5 \
  --cpu=1 \
  --memory=512Mi
```

Read the frontend URL:

```bash
gcloud run services describe voice-frontend \
  --format='value(status.url)'
```

Update the backend to allow that exact origin:

```bash
gcloud run services update voice-backend \
  --update-env-vars="ALLOWED_ORIGINS=https://YOUR_FRONTEND_HOST"
```

Use the origin only. Do not add a path or trailing slash. A custom frontend domain requires another backend revision with the custom origin.

## 7. Configure WebSocket behavior deliberately

Cloud Run treats a WebSocket as a long-running HTTP request. The service timeout
still applies. This sample limits a Gemini session with
`GEMINI_LIVE_MAX_SECONDS`, which defaults to 540 seconds. The selected model's
documented default conversation boundary is 10 minutes. Because this sample
intentionally disables session resumption, 540 seconds leaves one minute for a
controlled application close before that provider boundary. The 600-second
Cloud Run timeout then leaves the application in control of the normal close.

Keep these values coherent:

```text
Cloud Run --timeout > GEMINI_LIVE_MAX_SECONDS
```

Do not raise the application limit above the model's default conversation
boundary unless you intentionally implement and test the provider's extension
mechanism.

The UI does not silently resume a disconnected Gemini conversation. It reports that the ADK session ended and asks the user to start a new session. That is safer than implying continuity after an in-memory session has been deleted.

Do not enable end-to-end HTTP/2 for this WebSocket service. A connected WebSocket remains on one instance. A new connection can reach another instance, which is safe because every session is isolated and created from scratch.

## 8. Tune limits and scaling

The backend has two groups of process-local controls:

| Environment setting | Purpose |
|---|---|
| `SESSION_TOKEN_RATE_LIMIT` | OpenAI client-secret requests per minute per direct client key |
| `SESSION_TOKEN_CONCURRENCY` | Concurrent OpenAI client-secret requests |
| `WEB_SEARCH_RATE_LIMIT` | OpenAI hosted-search requests per minute per direct client key |
| `WEB_SEARCH_CONCURRENCY` | Concurrent OpenAI hosted-search requests |
| `GEMINI_LIVE_RATE_LIMIT` | New Gemini sockets per minute per direct client key |
| `GEMINI_LIVE_CONCURRENCY` | Active Gemini sockets per process |
| `GEMINI_LIVE_MAX_SECONDS` | Maximum Gemini socket duration |
| `GEMINI_LIVE_QUEUE_FRAMES` | Maximum queued browser PCM frames |
| `GEMINI_LIVE_MAX_FRAME_BYTES` | Maximum bytes in one browser frame |
| `GEMINI_LIVE_AUDIO_BYTES_PER_SECOND` | Sustained accepted byte rate |
| `GEMINI_LIVE_AUDIO_BURST_BYTES` | Initial burst allowance |

These limits reset per instance. `--max-instances` provides an aggregate cost ceiling, but production abuse controls should use an authenticated principal and a shared limiter at a trusted edge.

Set Cloud Run concurrency no higher than the number of simultaneous audio sessions one container can sustain at acceptable latency. Load test with real WebSockets before increasing it. An open WebSocket keeps an instance active and billable.

## 9. Add production authentication

`--allow-unauthenticated` makes this tutorial easy to try. It is not a complete public product boundary.

For production, add:

- user authentication before either `/api/*` route;
- authorization for provider access;
- a privacy-preserving stable hash of the authenticated principal for rate
  controls and the OpenAI `OpenAI-Safety-Identifier` header;
- shared rate and spend limits;
- CSRF and origin controls appropriate to the authentication design;
- budget alerts for Vertex AI and OpenAI usage;
- an incident runbook for identity misuse, OpenAI key exposure, and quota abuse.

The browser WebSocket API cannot add an arbitrary Authorization header. If the frontend and backend remain separate origins, design WebSocket authentication carefully, such as a same-site secure cookie or a short-lived, audience-bound connection ticket. Do not place a long-lived bearer token in the WebSocket query string.

## 10. Observe without leaking

Safe operational signals include:

- count of started and closed sessions;
- provider label and model name;
- generic completion or error category;
- latency and connection duration;
- 403, 429, 502, and 1011 counts;
- queue saturation and dropped session count.

Do not log:

- OAuth access tokens or ADC files;
- the OpenAI standard key or short-lived client secrets;
- Authorization headers;
- SDP offers or answers;
- raw audio or transcript content by default;
- complete ADK events;
- upstream response bodies or exception strings that might carry request detail.

## 11. Roll out and roll back

Deploy the backend first, then the frontend build that references it. Test both providers on a no-traffic revision before shifting users when possible.

For an OpenAI key rotation:

1. Add a new Secret Manager version.
2. Deploy a revision that binds the new numbered version.
3. Verify health and one authorized live session.
4. Move traffic.
5. Disable the old version after the rollback window.

For a Google identity or IAM change:

1. Apply the minimum role change to a test service identity.
2. Deploy a no-traffic revision with that identity.
3. Verify one Vertex AI live session.
4. Move traffic only after the live path succeeds.
5. Remove obsolete role bindings after the rollback window.

For a model change:

1. Change the backend model environment variable.
2. Run backend and frontend compatibility tests.
3. Verify the ready acknowledgement and active model label.
4. Test interruption, captions, and a provider switch.
5. Roll forward only when the complete path passes.

Continue with the [completed adversarial review](adversarial-review.md) before a production release.
