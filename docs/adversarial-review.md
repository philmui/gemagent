# Codex adversarial review

This record captures the hostile source review and local verification performed
for Voice Lab on August 5, 2026. It replaces a release checklist with the actual
evidence, defects, fixes, and remaining limits from the reviewed working tree.

## Review result

The local implementation gate passes. The Google lane is a Google ADK runtime
that authenticates only to Vertex AI with Application Default Credentials. The
OpenAI lane is a browser OpenAI Agents SDK session that receives a short-lived
client secret from FastAPI. Provider and voice changes use a serialized teardown
and replacement lifecycle.

This result does not certify an internet-facing production service. A complete
physical-microphone turn with audible browser output, the OpenAI live media
turn, the manual browser matrix, a Cloud Run deployment, and load testing were
not performed in this environment. The sample is also intentionally unauthenticated. Those
limits are release blockers for a public production deployment, as described in
[Validation still required](#validation-still-required).

| Review field | Recorded value |
|---|---|
| Review date | August 5, 2026, America/Los_Angeles |
| Source identity | Working-tree snapshot; this repository does not have a commit yet |
| Gemini runtime | Google ADK 2.6.2, locked by `backend/uv.lock` |
| Gemini model and auth | `gemini-live-2.5-flash-native-audio`, Vertex AI ADC only |
| OpenAI runtime | OpenAI Agents SDK 0.14.0, locked by `app/package-lock.json` |
| OpenAI model and transport | `gpt-realtime-2.1`, browser WebRTC |
| Review method | Independent hostile source pass, protocol tests, builds, dependency audit, container smoke test, documentation and SVG review |

## Executed evidence

These commands were reproduced against the working-tree snapshot. A future
change invalidates the evidence and requires another run.

| Command or inspection | Result |
|---|---|
| `cd backend && uv run pytest` | 56 tests passed; six dependency deprecation warnings |
| `npm run check` in `app` | ESLint and TypeScript passed; 10 Vitest files and 47 tests passed; Next.js 16.2.12 production build passed |
| `npm audit --omit=dev` in `app` | 0 vulnerabilities |
| `docker build --check .` | Dockerfile check completed with no warnings |
| `docker build -t gemini-voice-backend:verify .` | Full image build completed from the frozen backend lockfile |
| Container import smoke test | Process ran as UID 65532 and imported `app.main` successfully |
| Container `/health` smoke test | HTTP 200; reported `google-adk`, `openai-agents-sdk`, and the expected models without making a provider call |
| Vertex AI location probe | A Live handshake at `global` closed with code 1008; after correcting the endpoint, an ADC and ADK Live handshake at `us-central1` succeeded for an explicitly selected authorized project |
| Gemini audio projection probe | A credentialed ADK Live turn produced bare `audio/pcm`; the corrected gateway forwarded all 10 chunks and 109,034 bytes, then observed `turn_complete` |
| OpenAI client-secret probe | The live broker returned HTTP 200 for `gpt-realtime-2.1` and WebRTC; a token and expiry were present, the response was `no-store`, and the token value was not printed |
| `xmllint --noout docs/images/*.svg` | All six SVG files passed XML validation |
| SVG render and visual inspection | All six illustrations rendered; text, connectors, grouping, titles, and descriptions were legible |
| Production browser-asset scan | No key-shaped Google or OpenAI value and no server credential variable name found in the production static assets |
| Documentation terminology scan | No instructional Gemini API-key path, Developer API fallback, legacy preview model in active configuration, or em dash remained; explanatory API-boundary notes retain old terms intentionally |

The backend warnings come from Starlette's current TestClient integration,
`google-genai` use of a Python type scheduled for later removal, and ADK's
deprecated `BaseAgentConfig`. They did not fail the suite. Recheck them when
upgrading FastAPI, Starlette, Google ADK, `google-genai`, or Python.

The ignored local `.env` initially contained a placeholder Google Cloud project,
and the active ADC credential reported no quota project. The account exposed
more than 1,600 projects, so the review did not guess. After an authorized
project was explicitly selected, the endpoint was changed to `us-central1`, and
ADC was corrected, an ADK Live handshake succeeded. A later credentialed turn
confirmed real 24 kHz PCM generation and gateway forwarding, without recording
or printing content. No physical-microphone browser turn was completed. The installation guide now makes project replacement,
quota-project verification, supported model region, and backend restart
explicit.

## Adversarial findings and resolutions

The review assumed that displayed readiness, transcript state, browser protocol
handling, dependency reproducibility, and credential boundaries were wrong until
the source and tests showed otherwise.

| Severity | Finding | Resolution and evidence |
|---|---|---|
| High | Real ADK Live output used the canonical `audio/pcm` MIME type, but the gateway accepted only `audio/pcm;rate=24000`. Every valid response chunk was rejected before the browser WebSocket, so the agent could produce captions without audible speech. | The gateway now accepts both documented fixed-rate forms and still rejects an explicitly conflicting rate. A credentialed turn forwarded 10 real chunks totaling 109,034 bytes. Backend regression tests cover bare MIME, explicit 24 kHz, and conflicting rates. |
| High | The environment templates and docs selected the Vertex AI `global` endpoint even though `gemini-live-2.5-flash-native-audio` does not support it. A real Live handshake closed with code 1008. | The templates, sample configuration, deployment command, tutorials, troubleshooting, and diagrams now use `us-central1`. The docs link the current model card and require checking its supported regions before choosing another location. |
| High | Gemini could report `ready` before the ADK live generator had opened its upstream flow. A provider setup failure could therefore appear as an Active session. | The gateway now queues a short silence probe, starts `Runner.run_live(...)`, waits until ADK consumes the probe, and gates model events until the browser receives `ready`. The setup-failure test proves that a failed flow returns only a generic error and never reports ready. |
| High | The original backend container installation did not consume the backend's lockfile, so a deployment could resolve a dependency graph different from the reviewed one. | The repository-root Dockerfile consumes `backend/uv.lock` with `uv sync --frozen --no-dev`. A full image build, non-root import smoke test, and health request passed. Deployment uses `gcloud run deploy ... --source .`. |
| High | The production npm graph contained advisories in transitive `fast-uri` and `hono` versions. | The lockfile now resolves `fast-uri` 3.1.5 and `hono` 4.13.0. A fresh production audit reports zero vulnerabilities. |
| High | Configuration and copy still allowed or described Gemini API-key authentication after the design changed to mandatory Vertex AI ADC. This could encourage an accidental fallback or credential leak. | The Gemini key and backend-mode settings were removed. Runtime construction requires `GOOGLE_GENAI_USE_VERTEXAI=true`, project, and location, then passes explicit Google Cloud client options to ADK. Templates, UI privacy copy, installation, deployment, and troubleshooting now describe ADC only. |
| Medium | The ignored local environment had copied `gemini-3.1-flash-live-preview` from Gemini Developer API guidance into a Vertex AI configuration. Google model IDs are not guaranteed across those API surfaces. | The Vertex path now uses the GA model listed by the current Cloud model card. Documentation explains the API-surface boundary and forbids copying a Developer API ID unless the Vertex model card explicitly lists it. |
| Medium | ADK's finished transcription is cumulative, but the gateway treated every transcription as an appended delta. Final captions could repeat earlier text. | Partial transcription uses `mode: append`; a finished transcription uses `mode: replace`. Backend and reducer tests cover the cumulative-final case. |
| Medium | The AudioWorklet resampler could subtract more source samples from its phase accumulator than were actually removed when a block boundary was crossed. The fractional phase then reset and the output stream ran fast. | The processor keeps one interpolation sample, caps removal to the samples actually available, and subtracts only that count from `readOffset`. Tests now require exactly 25 40-millisecond chunks for one second of both 44.1 kHz and 48 kHz input. |
| Medium | The application allowed a 900-second Gemini session even though the model's default conversation boundary is 10 minutes and session resumption is intentionally disabled. The provider could end first. | The default is now 540 seconds, leaving one minute for a controlled close. The Cloud Run example uses a 600-second request timeout. Raising the limit now requires an intentionally implemented and tested session-extension design. |
| Medium | An interruption control did not reliably identify the affected assistant item. ADK can emit a finished transcript and its interruption in separate responses, after the numeric caption cursor has advanced. A late event could relabel the wrong answer. | The cursor now retains the active assistant ID until `turn_complete`, the gateway sends that exact ID, the browser schema requires it, and the reducer targets only that item. A regression test uses separate finished-transcript and interruption events. |
| Medium | An interrupted ADK event could send its cancellation control and then forward PCM content from the same event. The browser cleared playback and immediately received the cancelled tail again. | The gateway now ignores all content parts on an interrupted event. The separate-event regression test includes valid PCM on the interruption and proves that no audio is forwarded. |
| Medium | Browser code attempted to send WebSocket close code 1008. Browsers reserve that code and can throw `InvalidAccessError` when an application sends it. | Client protocol failures now send application code 4002. A protocol test constrains the value to the browser-permitted 3000 through 4999 range. The browser can still receive and interpret backend code 1008. |
| Medium | Gemini playback reported success while its `AudioContext` was suspended, and OpenAI trusted autoplay without checking for a remote media track or the `play()` result. Either browser policy could leave a healthy-looking but silent session. | Gemini now resumes output playback and surfaces resume failure. OpenAI mounts the output element early, requires a live audio track, bounds and awaits `play()`, retries after a runtime pause, and reports a browser sound-policy error before marking the session ready. Nine focused playback and adapter-lifecycle tests cover resume, failure, missing media, abort, timeout, autoplay rejection, runtime recovery, cleanup, and provider replacement. |
| Medium | The 1080-pixel breakpoint moved the conversation beneath the microphone, and `scrollIntoView()` could move an outer page ancestor or miss updates received while the tab was hidden. Long transcripts could also determine the panel height. | The workspace keeps a bounded two-column layout at every viewport. The phone layout reduces the microphone to a compact dock so the right transcript rail remains readable. Transcript-local layout and mutation observers keep the latest turn visible without changing the card height. A hydrated 390-pixel browser stress test with 30 turns confirmed a same-row layout, a fixed 736-pixel card height, and the final turn at the scroll boundary. |
| Medium | A telemetry display could imply that the providers expose continuous endpoint confidence, or leak tool names and payloads into the browser. Speaker activity based only on response phase would also misrepresent silence as audio. | The monitor labels endpointing as a local estimate, then combines microphone silence with sanitized provider VAD transitions. Agent amplitude comes from the actual Gemini playback graph or OpenAI remote media track. Tool telemetry contains only call and return transitions. Responsive browser inspection confirmed four distinct lanes at desktop, tablet, and 390-pixel phone widths. |
| Medium | The Gemini browser adapter rejected a legitimate sanitized backend error received before `ready`, hiding an ADC or provider setup failure behind a protocol message. | The strict control schema now permits the bounded error shape during setup and surfaces its generic message. Other pre-ready control data remains a protocol violation. |
| Medium | The OpenAI client-secret request did not attach a safety identifier. | FastAPI now generates an opaque `anonymous_...` identifier for each unauthenticated session, sends it in `OpenAI-Safety-Identifier`, and tests its format and 64-character bound. A production service should replace it with a stable, privacy-preserving hash of its authenticated user ID, following [OpenAI safety guidance](https://developers.openai.com/api/docs/guides/safety-best-practices#implement-safety-identifiers). |
| Medium | An initial frontend type error prevented the verification build from completing. | The audio implementation was corrected and the complete lint, typecheck, unit-test, and production-build chain now passes. |
| Low | Early documentation and backend package notes drifted from the implemented model, ADC requirement, transcript modes, and readiness contract. | The package README and user documentation now match the runtime. Cross-project terminology scans and the current docs review found no legacy Gemini authentication path. |
| Low | A client-only color preference could flash the dark default, fail when browser storage is blocked, overflow the phone header, or leave keyboard users with an unlabeled icon group. | A pre-interactive bootstrap applies the saved or operating-system preference before hydration. The compact radio group has labels, roving focus, arrow, Home, and End controls. Storage failure leaves immediate switching intact, cross-tab changes synchronize, and a fresh 390-pixel page restored Study mode with no horizontal overflow. Light, Dark, and Study screenshots were inspected, and primary text and accent token contrast was checked against each panel palette. |

No Critical finding remained in the locally reviewed snapshot.

## OpenAI Agents SDK comparison with `realagent`

The review also traced the OpenAI Assist implementation in
`/Users/pmui/dev/realagent`. Its strongest patterns were retained:

- create a new `RealtimeAgent` and `RealtimeSession` for a browser conversation;
- use `OpenAIRealtimeWebRTC` with an explicitly owned microphone stream and
  audio element;
- mint a short-lived client credential on a backend that holds the permanent
  key;
- register SDK and transport listeners before `session.connect(...)`;
- guard late callbacks with a connection generation;
- close the session and release media on errors, disconnect, replacement, and
  component unmount;
- use stable Realtime item IDs to reconcile streaming history.

Voice Lab narrows several boundaries that were broader in the reference app:

- there is one FastAPI token broker instead of a Python broker plus an optional
  Next.js broker;
- upstream response bodies and SDK error objects are replaced with generic
  public errors;
- token responses are `no-store`, and value, expiry, transport, and effective
  model are validated;
- the backend attaches `OpenAI-Safety-Identifier` on the client-secret request;
- `historyStoreAudio` is false and Agents SDK tracing is disabled;
- the browser waits for a matching `session.updated` model and voice before it
  labels the OpenAI session Active;
- provider and voice replacement starts a new isolated conversation instead of
  replaying text across runtimes;
- microphone permission is obtained before minting the paid short-lived
  credential, avoiding a token request when permission is denied.

These are deliberate hardening choices, not claims that the reference project
is interchangeable with this smaller dual-provider application.

## Trust-boundary conclusions

### Gemini and Google Cloud

The backend has no Gemini key field or Developer API branch. Gemini readiness
requires Vertex AI enabled, a project, and a region supported by the selected
model. The sample uses `us-central1`. Local ADC stays in the Google Cloud CLI
credential store. Cloud Run must use an
attached user-managed service identity, never a copied ADC file or downloaded
service-account key.

Every accepted socket receives a random ADK user ID, random session ID, fresh
bounded queue, and server-controlled `RunConfig`. Input frame size, byte rate,
burst, queue depth, active sessions, start rate, and duration are bounded. The
gateway forwards only allowlisted audio and control fields, closes and awaits
both streaming tasks, and deletes the in-memory ADK session in `finally`.

### OpenAI

The permanent OpenAI key remains in FastAPI. It is used only to create a
60-second client secret at a fixed OpenAI URL. The browser receives the
short-lived value and uses the OpenAI Agents SDK over WebRTC. FastAPI checks the
effective model before returning it and does not expose an upstream body,
authorization header, standard key, or safety identifier.

The short-lived credential is not an authorization policy. A public product
still needs authenticated user authorization, distributed principal-based
limits, spend controls, and tool-specific authorization.

### Browser switching and UI truthfulness

The selected provider and acknowledged active provider are separate states.
Switches are serialized, abort in-flight setup, await old adapter cleanup, and
ignore callbacks from stale epochs. The UI reports the provider, runtime, model,
transport, and current phase. It does not copy conversation context between
Gemini and OpenAI.

The Settings controls are native radio groups with disabled-state explanations,
visible checked state, and an explicit Active tag. Privacy copy distinguishes
backend-relayed Gemini media from direct OpenAI WebRTC media. Captions are
documented as fallible rather than an authoritative transcript.

## Validation still required

The following work needs real credentials, a supported browser, or a deployed
environment and was not simulated by the local test suites:

1. Complete one physical-microphone Gemini turn through Vertex AI ADC. A
   credentialed Live turn already generated and forwarded 109,034 bytes of real
   output PCM at `us-central1`, but audible browser output, spoken input,
   barge-in, caption finalization, provider errors, and the session time limit
   still need a browser test.
2. Complete one live OpenAI Agents SDK turn with the production account. The
   client-secret broker already returned a validated 200 response, but WebRTC
   connection, `session.updated` acknowledgement, remote audio, interruption,
   and client-secret expiry behavior still need a browser test.
3. Run Gemini to OpenAI and OpenAI to Gemini rapid-switch tests with a physical
   microphone. Confirm exactly one microphone owner and no stale remote audio.
4. Run the keyboard, screen-reader, 200 percent zoom, reduced-motion,
   permission-denial, and autoplay matrix in current Chrome, Firefox, and
   Safari.
5. Deploy both services to Cloud Run with the intended service identity, exact
   frontend origin, numbered OpenAI secret version, timeout, concurrency, and
   instance cap. Verify the live WebSocket across the public edge.
6. Load test concurrent audio sessions and size CPU, memory, concurrency,
   timeouts, distributed rate limits, budgets, and alerts from measurements.
7. Add product authentication and authorization before exposing the tutorial
   with `--allow-unauthenticated` to untrusted users.
8. Track the model card's December 13, 2026 retirement date. Select and test a
   supported replacement before that date, including regions, ADK `RunConfig`,
   voices, transcription events, audio rates, interruption, and limits.

## Release decision

The reviewed snapshot is suitable for local installation and credentialed live
smoke testing. It is suitable as the implementation behind the documented Cloud
Run tutorial after the deployment-specific checks above are performed.

It is not approved as an unauthenticated public production service. Promotion to
that state remains blocked on identity, distributed abuse and spend controls,
live provider validation, browser accessibility validation, deployment
verification, load testing, and operational ownership.
