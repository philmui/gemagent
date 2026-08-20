import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  tool,
  type RealtimeSessionConfig,
} from "@openai/agents/realtime";
import { z } from "zod";

import {
  AmbientSoundPlayer,
  assertBrowserMediaSupport,
  ensureRemoteAudioPlayback,
  MediaLevelMeter,
  stopMediaStream,
} from "./audio";
import { mintOpenAISessionCredential, searchOpenAIWeb } from "./backend";
import { DEFAULT_ADVANCED_VOICE_SETTINGS } from "./types";
import {
  transcriptFromOpenAIItem,
  validateOpenAISessionAcknowledgement,
  type OpenAISessionAcknowledgement,
} from "./provider-protocol";
import type {
  AdapterCallbacks,
  AdvancedVoiceSettings,
  VerifiedSessionInfo,
  VoiceSessionAdapter,
} from "./types";

const OPENAI_AGENT_INSTRUCTIONS =
  "You are a warm, concise voice assistant. Speak naturally in the user's language. " +
  "Keep most replies to one or two short sentences. Ask for clarification when audio " +
  "is unclear. Use web_search for current information, recent events, or facts you are " +
  "not confident are current. Briefly identify important sources in your spoken response. " +
  "Never claim to have completed an action you did not complete.";

function instructionsFor(settings: AdvancedVoiceSettings): string {
  const stability = settings.stability >= 75 ? "Keep delivery notably steady and composed." :
    settings.stability <= 35 ? "Allow a more varied, expressive delivery." : "Keep delivery natural with gentle variation.";
  const tone = { warm: "Use a warm, reassuring tone.", balanced: "Use a clear, balanced tone.", bright: "Use a bright, upbeat tone." }[settings.tone];
  const pace = { relaxed: "Speak at a relaxed pace.", natural: "Speak at a natural conversational pace.", brisk: "Speak at a crisp, brisk pace." }[settings.pace];
  return `${OPENAI_AGENT_INSTRUCTIONS} ${stability} ${tone} ${pace}`;
}

interface HistorySnapshot {
  text: string;
  status: "in_progress" | "completed" | "incomplete";
}

const ACKNOWLEDGEMENT_TIMEOUT_MS = 8_000;

function abortError(): DOMException {
  return new DOMException("The session start was cancelled.", "AbortError");
}

function waitFor<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class OpenAIRealtimeAdapter implements VoiceSessionAdapter {
  readonly provider = "openai" as const;

  private stream: MediaStream | null = null;
  private session: RealtimeSession | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private meter = new MediaLevelMeter();
  private outputMeter = new MediaLevelMeter();
  private history = new Map<string, HistorySnapshot>();
  private toolHistory = new Map<string, { returned: boolean }>();
  private stopped = true;
  private muted = false;
  private stopPromise: Promise<void> | null = null;
  private sessionSignal: AbortSignal | null = null;
  private toolController: AbortController | null = null;
  private playbackRecovery: Promise<void> | null = null;
  private removeAudioListeners: (() => void) | null = null;
  private ambience = new AmbientSoundPlayer();

  private readonly settings: AdvancedVoiceSettings;
  private readonly callbacks: AdapterCallbacks;

  constructor(
    private readonly voice: string,
    settingsOrCallbacks: AdvancedVoiceSettings | AdapterCallbacks,
    callbacks?: AdapterCallbacks,
  ) {
    // Keep the two-argument form available for integrations using the adapter directly.
    if (callbacks) {
      this.settings = settingsOrCallbacks as AdvancedVoiceSettings;
      this.callbacks = callbacks;
    } else {
      this.settings = DEFAULT_ADVANCED_VOICE_SETTINGS;
      this.callbacks = settingsOrCallbacks as AdapterCallbacks;
    }
  }

  async start(signal: AbortSignal): Promise<VerifiedSessionInfo> {
    this.stopped = false;
    this.stopPromise = null;
    this.sessionSignal = signal;
    this.toolController = new AbortController();
    this.playbackRecovery = null;
    this.history.clear();
    this.toolHistory.clear();
    signal.addEventListener("abort", () => void this.stop("aborted"), { once: true });
    assertBrowserMediaSupport();

    try {
      // Create the output surface before the first permission or network wait.
      // Keeping it mounted also avoids detached-media quirks in WebKit.
      const audioElement = new Audio();
      audioElement.autoplay = true;
      audioElement.controls = false;
      audioElement.setAttribute("playsinline", "true");
      audioElement.setAttribute("aria-hidden", "true");
      audioElement.style.position = "fixed";
      audioElement.style.width = "1px";
      audioElement.style.height = "1px";
      audioElement.style.opacity = "0";
      audioElement.style.pointerEvents = "none";
      document.body.appendChild(audioElement);
      this.audioElement = audioElement;
      const onPause = () => this.recoverRemoteAudioPlayback();
      const onAudioError = () => {
        if (!this.stopped && audioElement === this.audioElement) {
          this.callbacks.onError(
            "The browser speaker output failed. Check this site's sound and output-device settings.",
          );
        }
      };
      audioElement.addEventListener("pause", onPause);
      audioElement.addEventListener("error", onAudioError);
      this.removeAudioListeners = () => {
        audioElement.removeEventListener("pause", onPause);
        audioElement.removeEventListener("error", onAudioError);
      };

      this.callbacks.onPhase("requesting-permission");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: this.settings.echoCancellation,
          noiseSuppression: this.settings.noiseSuppression,
          autoGainControl: true,
        },
      });
      if (signal.aborted || this.stopped) {
        stopMediaStream(stream);
        throw abortError();
      }
      this.stream = stream;
      await this.ambience.start(this.settings.backgroundSound);
      await this.meter.start(stream, (level) =>
        this.callbacks.onLevel(this.muted ? 0 : level),
      );
      if (signal.aborted || this.stopped) throw abortError();

      this.callbacks.onPhase("connecting");
      const credential = await mintOpenAISessionCredential(this.voice, signal);
      if (signal.aborted || this.stopped) throw abortError();
      if (credential.transport.type !== "webrtc") {
        throw new Error("The backend returned the wrong OpenAI transport.");
      }

      const transport = new OpenAIRealtimeWebRTC({
        mediaStream: stream,
        audioElement,
        baseUrl: credential.transport.url,
      });
      const agent = new RealtimeAgent({
        name: "Voice Lab Assistant",
        voice: this.voice,
        instructions: instructionsFor(this.settings),
        tools: [
          tool({
            name: "web_search",
            description:
              "Search the live web for current information, recent events, or facts that may have changed.",
            parameters: z.object({
              query: z.string().trim().min(1).max(500),
            }),
            timeoutMs: 30_000,
            timeoutBehavior: "error_as_result",
            timeoutErrorFunction: () =>
              "Web search timed out. Tell the user briefly and do not invent an answer.",
            errorFunction: () =>
              "Web search is temporarily unavailable. Tell the user briefly and do not invent an answer.",
            execute: async ({ query }) => {
              const controller = this.toolController;
              if (!controller || controller.signal.aborted || this.stopped) {
                throw abortError();
              }
              const result = await searchOpenAIWeb(query, controller.signal);
              return JSON.stringify(result);
            },
          }),
        ],
      });
      const session = new RealtimeSession(agent, {
        model: credential.model,
        transport,
        config: credential.config as Partial<RealtimeSessionConfig>,
        historyStoreAudio: false,
        tracingDisabled: true,
      });
      this.session = session;

      let resolveAcknowledgement: (value: OpenAISessionAcknowledgement) => void = () => undefined;
      let rejectAcknowledgement: (error: Error) => void = () => undefined;
      const acknowledgement = new Promise<OpenAISessionAcknowledgement>((resolve, reject) => {
        resolveAcknowledgement = resolve;
        rejectAcknowledgement = reject;
      });
      this.wireSession(
        session,
        transport,
        credential.model,
        resolveAcknowledgement,
        rejectAcknowledgement,
      );

      await session.connect({ apiKey: credential.token, model: credential.model });
      if (signal.aborted || this.stopped || session !== this.session) throw abortError();
      // The SDK attaches the remote WebRTC stream, but autoplay failures are
      // otherwise silent. Require a real speaker track and a successful play().
      await ensureRemoteAudioPlayback(audioElement, signal);
      if (signal.aborted || this.stopped || session !== this.session) throw abortError();
      const remoteStream = audioElement.srcObject;
      if (remoteStream instanceof MediaStream) {
        await this.outputMeter
          .start(remoteStream, (level) => this.callbacks.onOutputLevel(level))
          .catch(() => this.callbacks.onOutputLevel(0));
      }
      const acknowledged = await waitFor(
        acknowledgement,
        ACKNOWLEDGEMENT_TIMEOUT_MS,
        "OpenAI did not acknowledge the requested model and voice in time.",
      );
      if (signal.aborted || this.stopped || session !== this.session) throw abortError();

      return {
        provider: "openai",
        model: acknowledged.model,
        voice: acknowledged.voice,
        transport: "webrtc",
        agentRuntime: "openai-agents-sdk",
      };
    } catch (error) {
      await this.stop("start-failed");
      throw error;
    }
  }

  private wireSession(
    session: RealtimeSession,
    transport: OpenAIRealtimeWebRTC,
    expectedModel: string,
    resolveAcknowledgement: (value: OpenAISessionAcknowledgement) => void,
    rejectAcknowledgement: (error: Error) => void,
  ): void {
    let connected = false;
    let outputInterrupted = false;

    session.on("history_updated", (history) => {
      if (this.stopped || session !== this.session) return;
      for (const item of history) {
        if (
          item.type === "function_call" ||
          item.type === "mcp_call" ||
          item.type === "mcp_tool_call"
        ) {
          const previous = this.toolHistory.get(item.itemId);
          if (!previous) this.callbacks.onTelemetry("tool-call");
          const returned = item.status === "completed" && item.output !== null;
          if (
            returned &&
            !previous?.returned
          ) {
            this.callbacks.onTelemetry("tool-return");
          }
          this.toolHistory.set(item.itemId, { returned: Boolean(previous?.returned || returned) });
          continue;
        }
        if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) {
          continue;
        }
        const text = transcriptFromOpenAIItem(item);
        if (!text) continue;
        const status = item.status;
        const final = status === "completed";
        const previous = this.history.get(item.itemId);
        if (previous?.text === text && previous.status === status) continue;
        this.history.set(item.itemId, { text, status });
        this.callbacks.onCaption({
          role: item.role,
          text,
          itemId: item.itemId,
          mode: "replace",
          final,
        });
        if (item.role === "assistant" && status === "incomplete") {
          this.callbacks.onInterrupted(item.itemId);
        }
      }
    });

    session.on("transport_event", (event) => {
      if (this.stopped || session !== this.session) return;
      const type = (event as { type?: string }).type;
      switch (type) {
        case "session.updated":
          try {
            resolveAcknowledgement(
              validateOpenAISessionAcknowledgement(event, expectedModel, this.voice),
            );
          } catch (error) {
            rejectAcknowledgement(
              error instanceof Error ? error : new Error("Invalid OpenAI acknowledgement."),
            );
          }
          break;
        case "input_audio_buffer.speech_started":
          this.callbacks.onTelemetry("speech-start");
          this.callbacks.onPhase("user-speaking");
          break;
        case "input_audio_buffer.speech_stopped":
          this.callbacks.onTelemetry("speech-end");
          this.callbacks.onPhase("assistant-thinking");
          break;
        case "response.created":
          this.callbacks.onPhase("assistant-thinking");
          break;
        case "output_audio_buffer.started":
          outputInterrupted = false;
          // This WebRTC event is emitted when the local output buffer begins,
          // which is the user-visible end boundary for TTFA.
          this.callbacks.onAudioStart(performance.now());
          this.recoverRemoteAudioPlayback();
          this.callbacks.onPhase("assistant-speaking");
          break;
        case "output_audio_buffer.cleared":
          outputInterrupted = true;
          this.callbacks.onInterrupted();
          this.callbacks.onPhase("listening");
          break;
        case "output_audio_buffer.stopped":
          if (!outputInterrupted) {
            // Close the transcript response first, then anchor a possible
            // follow-up response at the end of this reply's local audio.
            this.callbacks.onTurnComplete();
            this.callbacks.onAudioEnd(performance.now());
          }
          outputInterrupted = false;
          this.callbacks.onPhase("listening");
          break;
      }
    });
    transport.on("connection_change", (status) => {
      if (this.stopped || session !== this.session) return;
      if (status === "connected") {
        connected = true;
      } else if (status === "disconnected") {
        const error = new Error("The OpenAI WebRTC connection ended unexpectedly.");
        rejectAcknowledgement(error);
        if (connected) this.callbacks.onError(error.message);
      }
    });
    session.on("agent_start", () => {
      if (!this.stopped && session === this.session) this.callbacks.onPhase("assistant-thinking");
    });
    session.on("error", () => {
      if (this.stopped || session !== this.session) return;
      const error = new Error("OpenAI Realtime reported a session error. Check the backend logs.");
      rejectAcknowledgement(error);
      this.callbacks.onError(error.message);
    });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.session?.mute(muted);
    if (muted) this.callbacks.onLevel(0);
  }

  async stop(reason = "user"): Promise<void> {
    void reason;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private recoverRemoteAudioPlayback(): void {
    const audio = this.audioElement;
    const signal = this.sessionSignal;
    if (
      this.stopped ||
      !audio ||
      !signal ||
      signal.aborted ||
      this.playbackRecovery
    ) {
      return;
    }
    const recovery = ensureRemoteAudioPlayback(audio, signal)
      .catch((error: unknown) => {
        if (this.stopped || signal.aborted || audio !== this.audioElement) return;
        this.callbacks.onError(
          error instanceof Error
            ? error.message
            : "The browser could not resume speaker playback.",
        );
      })
      .finally(() => {
        if (this.playbackRecovery === recovery) this.playbackRecovery = null;
      });
    this.playbackRecovery = recovery;
  }

  private async performStop(): Promise<void> {
    this.stopped = true;
    this.sessionSignal = null;
    this.toolController?.abort();
    this.toolController = null;
    this.playbackRecovery = null;
    const session = this.session;
    this.session = null;
    session?.close();

    const audio = this.audioElement;
    this.audioElement = null;
    this.removeAudioListeners?.();
    this.removeAudioListeners = null;
    if (audio) {
      audio.pause();
      const remoteStream = audio.srcObject;
      if (remoteStream instanceof MediaStream) stopMediaStream(remoteStream);
      audio.srcObject = null;
      audio.removeAttribute("src");
      audio.load();
      audio.remove();
    }

    stopMediaStream(this.stream);
    this.stream = null;
    await Promise.all([this.ambience.stop(), this.meter.stop(), this.outputMeter.stop()]);
    this.history.clear();
    this.toolHistory.clear();
    this.callbacks.onLevel(0);
    this.callbacks.onOutputLevel(0);
  }
}
