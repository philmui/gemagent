import {
  AmbientSoundPlayer,
  assertGeminiAudioSupport,
  GeminiAudioCapture,
  PcmAudioPlayer,
  stopMediaStream,
} from "./audio";
import { geminiLiveWebSocketUrl } from "./backend";
import { DEFAULT_ADVANCED_VOICE_SETTINGS } from "./types";
import {
  parseGeminiControlMessage,
  validateGeminiReady,
  type GeminiControlMessage,
  type GeminiReadyMessage,
} from "./provider-protocol";
import type {
  AdapterCallbacks,
  AdvancedVoiceSettings,
  VerifiedSessionInfo,
  VoiceSessionAdapter,
} from "./types";

const MAX_BUFFERED_BYTES = 1_000_000;
// The backend gives upstream ADK setup 15 seconds. The browser starts its clock
// earlier, so it needs extra time for the WebSocket and session-creation work.
export const GEMINI_SETUP_TIMEOUT_MS = 20_000;
// Browser code may send 1000 or an application-defined code from 3000 to
// 4999. Reserved codes such as 1008 may be received, but not passed to close().
export const CLIENT_PROTOCOL_ERROR_CLOSE_CODE = 4002;

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

export class GeminiLiveAdapter implements VoiceSessionAdapter {
  readonly provider = "gemini" as const;

  private stream: MediaStream | null = null;
  private capture = new GeminiAudioCapture();
  private player: PcmAudioPlayer;
  private socket: WebSocket | null = null;
  private stopped = true;
  private muted = false;
  private ready = false;
  private stopPromise: Promise<void> | null = null;
  private ambience = new AmbientSoundPlayer();

  private readonly settings: AdvancedVoiceSettings;
  private readonly callbacks: AdapterCallbacks;

  constructor(
    private readonly voice: string,
    settingsOrCallbacks: AdvancedVoiceSettings | AdapterCallbacks,
    callbacks?: AdapterCallbacks,
  ) {
    if (callbacks) {
      this.settings = settingsOrCallbacks as AdvancedVoiceSettings;
      this.callbacks = callbacks;
    } else {
      this.settings = DEFAULT_ADVANCED_VOICE_SETTINGS;
      this.callbacks = settingsOrCallbacks as AdapterCallbacks;
    }
    this.player = new PcmAudioPlayer((playing) => {
      if (!this.stopped) this.callbacks.onPhase(playing ? "assistant-speaking" : "listening");
    }, (message) => {
      if (!this.stopped) this.callbacks.onError(message);
    }, (level) => {
      if (!this.stopped) this.callbacks.onOutputLevel(level);
    });
  }

  async start(signal: AbortSignal): Promise<VerifiedSessionInfo> {
    this.stopped = false;
    this.stopPromise = null;
    this.ready = false;
    signal.addEventListener("abort", () => void this.stop("aborted"), { once: true });
    assertGeminiAudioSupport();

    try {
      this.callbacks.onPhase("requesting-permission");
      await this.player.prime();
      if (signal.aborted || this.stopped) throw abortError();
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
      await this.capture.start(
        stream,
        (bytes) => this.sendAudio(bytes),
        (level) => this.callbacks.onLevel(this.muted ? 0 : level),
      );
      if (signal.aborted || this.stopped) throw abortError();

      this.callbacks.onPhase("connecting");
      return await this.connect(signal);
    } catch (error) {
      await this.stop("start-failed");
      throw error;
    }
  }

  private async connect(signal: AbortSignal): Promise<VerifiedSessionInfo> {
    let resolveReady: (info: VerifiedSessionInfo) => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const readyPromise = new Promise<VerifiedSessionInfo>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const socket = new WebSocket(geminiLiveWebSocketUrl(this.voice));
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      if (this.stopped || socket !== this.socket) return;
      if (event.data instanceof ArrayBuffer) {
        if (!this.ready) {
          rejectReady(new Error("The Gemini ADK gateway sent audio before it was ready."));
          socket.close(CLIENT_PROTOCOL_ERROR_CLOSE_CODE, "invalid-server-protocol");
          return;
        }
        if (!this.player.playBytes(new Uint8Array(event.data))) {
          this.callbacks.onError("Gemini produced more queued audio than the browser can hold.");
        }
        return;
      }
      if (typeof event.data !== "string") {
        const error = new Error("The Gemini ADK gateway sent an invalid message.");
        if (this.ready) this.callbacks.onError(error.message);
        else rejectReady(error);
        socket.close(CLIENT_PROTOCOL_ERROR_CLOSE_CODE, "invalid-server-protocol");
        return;
      }
      const message = parseGeminiControlMessage(event.data);
      if (!message) {
        const error = new Error("The Gemini ADK gateway sent malformed control data.");
        if (this.ready) this.callbacks.onError(error.message);
        else rejectReady(error);
        socket.close(CLIENT_PROTOCOL_ERROR_CLOSE_CODE, "invalid-server-protocol");
        return;
      }
      if (message.type === "ready") {
        if (this.ready) {
          this.callbacks.onError("The Gemini ADK gateway sent a duplicate acknowledgement.");
          socket.close(CLIENT_PROTOCOL_ERROR_CLOSE_CODE, "invalid-server-protocol");
          return;
        }
        try {
          const info = validateGeminiReady(message, this.voice);
          this.ready = true;
          resolveReady(info);
        } catch (error) {
          rejectReady(error instanceof Error ? error : new Error("Invalid Gemini acknowledgement."));
          socket.close(CLIENT_PROTOCOL_ERROR_CLOSE_CODE, "invalid-server-protocol");
        }
        return;
      }
      // A provider or ADC failure can legitimately arrive before the ready
      // acknowledgement. Surface the backend's sanitized error instead of
      // misclassifying it as a protocol violation and hiding the root cause.
      if (!this.ready && message.type === "error") {
        rejectReady(
          new Error(message.message || "Gemini Live could not start this session."),
        );
        return;
      }
      if (!this.ready) {
        rejectReady(new Error("The Gemini ADK gateway sent control data before it was ready."));
        socket.close(CLIENT_PROTOCOL_ERROR_CLOSE_CODE, "invalid-server-protocol");
        return;
      }
      this.handleControl(message);
    });

    socket.addEventListener("error", () => {
      if (!this.ready) rejectReady(new Error("The Gemini ADK gateway could not be reached."));
    });
    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      if (this.stopped) return;
      if (!this.ready) {
        rejectReady(new Error("The Gemini ADK gateway closed before the session was ready."));
        return;
      }
      this.callbacks.onError(
        event.code === 1008
          ? "The Gemini session was rejected by the backend security policy."
          : "The Gemini ADK session ended. Start a new session to reconnect.",
      );
    });

    if (signal.aborted || this.stopped) {
      socket.close(1000, "cancelled");
      throw abortError();
    }
    return waitFor(
      readyPromise,
      GEMINI_SETUP_TIMEOUT_MS,
      "The Gemini ADK gateway did not acknowledge the session in time.",
    );
  }

  private sendAudio(bytes: Uint8Array): void {
    const socket = this.socket;
    if (
      this.stopped ||
      !this.ready ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      return;
    }
    // Continue the realtime clock while muted so server VAD receives silence
    // and can close an utterance that began just before the mute action.
    socket.send(this.muted ? new Uint8Array(bytes.length) : bytes);
  }

  private handleControl(message: Exclude<GeminiControlMessage, GeminiReadyMessage>): void {
    switch (message.type) {
      case "caption":
        if (!message.text || !message.item_id) return;
        this.callbacks.onCaption({
          role: message.role,
          text: message.text,
          itemId: message.item_id,
          mode: message.mode ?? "append",
          final: message.final,
        });
        this.callbacks.onPhase(message.role === "user" ? "user-speaking" : "assistant-speaking");
        break;
      case "interrupted":
        this.player.clear();
        this.callbacks.onInterrupted(message.item_id);
        break;
      case "turn_complete":
        this.callbacks.onTurnComplete();
        // ADK can finish the logical turn while Web Audio still has scheduled
        // PCM buffers. Keep the visible phase truthful until playback ends.
        this.callbacks.onPhase(this.player.isPlaying ? "assistant-speaking" : "listening");
        break;
      case "tool_activity":
        this.callbacks.onTelemetry(message.kind === "call" ? "tool-call" : "tool-return");
        break;
      case "endpoint":
        this.callbacks.onTelemetry(message.kind);
        break;
      case "error":
        this.callbacks.onError(
          message.message || "Gemini Live reported a safe upstream session error.",
        );
        break;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (muted) this.callbacks.onLevel(0);
  }

  async stop(reason = "user"): Promise<void> {
    void reason;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "end" }));
      socket.close(1000, "session-ended");
    } else if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "session-ended");
    }
    stopMediaStream(this.stream);
    this.stream = null;
    await Promise.all([this.capture.stop(), this.player.close(), this.ambience.stop()]);
    this.callbacks.onLevel(0);
    this.callbacks.onOutputLevel(0);
  }
}
