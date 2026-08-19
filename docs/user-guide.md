# User guide

Voice Lab is designed to feel like one conversation surface even though its two providers use different transports and agent frameworks. This guide explains what every control does and what to expect when you switch.

## Choose a comfortable color scheme

Use the compact sun, moon, and book control in the header to switch between Light, Dark, and Study color schemes. The change applies immediately across the workspace and is remembered in this browser. Study uses a warm, lower-glare palette for longer reading and review sessions. You can use the arrow keys, Home, and End while the control is focused.

## Before you speak

For the clearest result:

- Use headphones.
- Move to a quiet room.
- Place the microphone a comfortable speaking distance away.
- Close another meeting or recording app if it has exclusive microphone access.
- Use `localhost`, `127.0.0.1`, or HTTPS so the browser can grant microphone permission.

## Read the screen at a glance

The main console shows four pieces of session state:

1. The status pill says whether Voice Lab is idle, connecting, listening, thinking, speaking, switching, or stopping.
2. The model badge says Selected model before connection and Active model after the chosen runtime acknowledges a session.
3. The center orb starts the live session. While connected, it becomes a four-lane signal monitor with a clear End button.
4. The route summary names the selected or connected provider.

The right panel has Conversation and Settings tabs. Conversation shows live captions. Settings contains the provider and voice controls.

## Start a conversation

1. Open Settings.
2. Select Gemini Live or OpenAI Realtime.
3. Pick a voice. Gemini and OpenAI have separate voice lists.
4. Press the center orb.
5. Select Allow when the browser requests microphone permission.
6. Wait for the status to become Listening.
7. Ask a question in a normal speaking voice.

The first click is important because browsers require a user gesture before they allow microphone capture and audio playback.

## Read the live signal monitor

The microphone panel changes into a rolling 10-second monitor as soon as session startup begins. The four lanes share one time axis, with the newest signal at the right edge.

| Lane | What it shows |
|---|---|
| Your audio | Amplitude measured from the local microphone capture path |
| Agent audio | Amplitude measured from Gemini's Web Audio playback graph or OpenAI's remote WebRTC audio track |
| Function activity | A web-search call above the center line and its response below it |
| Endpointing detection | A local end-of-turn strength estimate, reinforced by start and end markers from provider voice activity detection |

Endpointing strength is not a provider confidence score. Gemini Live and OpenAI Realtime expose speech-start and speech-end transitions, not a continuous confidence value. Voice Lab combines those transitions with the local microphone amplitude so you can see silence accumulating toward an endpoint without overstating what the provider reports.

Audio appears as a mirrored oscilloscope envelope around each lane’s center line. The endpoint lane rises from the bottom and includes a subtle threshold guide. A bright rail at the right edge marks the live sample, while the vertical grid divides the rolling window into equal time intervals. The phase chip identifies which part of the conversation is active without relying on waveform color alone.

The lane starts at Ready. It changes to Calling when the agent requests web search, then to Response when the result returns. Function markers are deliberately content-free. The Gemini gateway does not send tool IDs, arguments, or results. On the OpenAI path, the browser Agents SDK holds the tool item required by that runtime, but the adapter does not copy its query or payload into signal-monitor state.

### Try live web search

Ask a question that clearly needs current information, such as “What changed in the latest release of Next.js?” or “What is today’s weather alert for San Francisco?” The selected voice agent decides when search is needed.

- Gemini calls an ADK function agent backed by native Google Search.
- OpenAI Realtime calls a function registered by the OpenAI Agents SDK. That function asks FastAPI to run the hosted Responses API `web_search` tool, so the permanent API key stays on the server.

Ordinary conversation does not call search, so a quiet Function activity lane is normal for greetings, arithmetic, and stable questions. The agent summarizes a grounded result in speech and in the conversation thread.

Press End in the monitor header to stop. On a narrow phone, the monitor becomes a compact left-side signal dock so the conversation remains readable on the right.

### Gemini Live session

When Gemini is active, the settings card shows:

- Runtime: Google ADK
- Transport: WebSocket
- Model: `gemini-live-2.5-flash-native-audio`

Your browser converts microphone audio to signed PCM16 at 16 kHz and sends binary frames to the FastAPI WebSocket. The backend gives those frames to a fresh ADK live queue. Gemini audio comes back through the same backend and is played as PCM16 at 24 kHz.

### OpenAI Realtime session

When OpenAI is active, the settings card shows:

- Runtime: OpenAI Agents SDK
- Transport: WebRTC
- Default model: `gpt-realtime-2.1`

FastAPI creates a short-lived client secret. The browser gives that secret to `RealtimeSession`, and `OpenAIRealtimeWebRTC` manages the peer connection, microphone stream, and remote audio. This matches OpenAI's recommendation to use WebRTC for browser speech applications in the [Realtime WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc).

## Switch providers immediately

![Immediate provider switching closes every old resource before opening the replacement session](images/session-switch-lifecycle.svg)

You do not need to stop before switching:

1. Keep the current conversation running.
2. Open Settings.
3. Select the other provider.
4. Watch the state change to Switching.
5. Wait for the new Active badge.

Voice Lab closes the old session before it reports the new one as active. It stops the old microphone path, clears old playback, opens the new transport, and adds a session divider to the transcript. Conversation context does not cross the provider boundary.

This behavior is deliberate:

- A Gemini prompt is never copied into OpenAI history.
- An OpenAI prompt is never copied into ADK session state.
- A failed switch does not silently reconnect to the old provider.
- There is no automatic provider fallback.
- Selecting the already selected provider does not create a duplicate session.

Changing the voice during a live conversation also starts a fresh session so the active voice and displayed session always agree.

## Understand Selected and Active

Selected describes your current control choice. Active describes an adapter that completed its readiness contract. For Gemini, this is the backend ADK gateway session and event stream becoming ready. It is not proof that Vertex AI already processed audio. For OpenAI, it follows `RealtimeSession.connect(...)`.

| Display | Meaning |
|---|---|
| Selected model | This model will be requested when you press Start |
| Switching | The old session is closing and the replacement is being created |
| Active model | The selected runtime is ready to exchange session audio |
| Backend key missing | That provider is not configured and cannot be selected |
| Error | The attempted session ended and no provider is secretly active |

The active provider card also displays its agent runtime. This makes the framework boundary visible instead of treating both providers as the same implementation.

## Mute and unmute

Press Mute to stop sending meaningful microphone audio without ending the session. Press Unmute to continue.

The control has an `aria-pressed` state for assistive technology. Muting also sets the local activity level to zero. Stop the session if you want the provider connection and microphone track released completely.

## Interrupt a response

Start speaking while the assistant is speaking. Both provider configurations enable server-side voice activity detection and interruption behavior. Voice Lab clears Gemini audio that should no longer play and listens for the OpenAI Agents SDK interruption event on the OpenAI path.

Headphones make interruption more reliable because the microphone is less likely to hear the assistant's own voice.

## Use live captions

The Conversation tab shows user and assistant captions, each labeled with the provider model. Partial captions update as the provider sends more text. An interrupted response is marked Interrupted.

Captions are a convenience, not a verbatim record. They can differ from what you said, what the model understood, or what was spoken. Do not use them as a legal, clinical, or safety-critical transcript.

Press the trash button to clear captions from the current browser view. Clearing the view does not rewrite a provider session that is already in progress.

## Stop cleanly

Press End in the signal monitor while connected. Voice Lab enters Stopping and releases:

- the active adapter;
- microphone tracks;
- the Gemini AudioWorklet and PCM playback context, when applicable;
- the Gemini WebSocket and its ADK session;
- the OpenAI `RealtimeSession`, WebRTC transport, remote audio element, and level meter, when applicable.

Closing or navigating away from the page also triggers best-effort cleanup.

## Privacy boundary

![Provider credentials stay outside the browser while the audio routes differ](images/secret-boundary.svg)

Provider credentials follow one rule: they never belong in the browser.

The audio routes do not follow one identical path:

- Gemini audio travels through your FastAPI service, then through Google ADK to the Gemini Live API. Your backend is inside the Gemini audio data path.
- OpenAI audio travels directly between the browser and OpenAI over WebRTC after FastAPI creates a short-lived client secret. Your backend initializes the session but is not the media relay.

Gemini authenticates to Vertex AI through Application Default Credentials. Local ADC stays outside the repository. Cloud Run obtains ADC from its attached service identity. The backend uses an in-memory ADK session and deletes it when the Gemini WebSocket ends. `save_live_blob=False` prevents ADK from saving live audio blobs to the session service. Application code intentionally avoids logging raw audio, credentials, short-lived secrets, upstream bodies, and full ADK events.

Your provider account policies still apply. Review the relevant Google and OpenAI data controls before processing sensitive audio.

## Keyboard and motion preferences

- Use Tab and Shift+Tab to move through controls.
- Press Space or Enter to activate the focused control.
- Provider and voice choices expose radio semantics and a checked state.
- Status changes and live captions use accessible live regions.
- Selection never relies on color alone.
- The interface respects reduced-motion preferences for nonessential animation.

At high zoom, use the normal page scroll rather than reducing browser zoom. Report any control that becomes clipped or unreachable as an accessibility defect.

If anything does not work, continue with [troubleshooting](troubleshooting.md).
