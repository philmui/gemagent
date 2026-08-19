const PCM16_SCALE = 0x8000;
export const REMOTE_AUDIO_TRACK_TIMEOUT_MS = 5_000;

const SPEAKER_PLAYBACK_ERROR =
  "The browser blocked speaker playback. Allow sound for this site, then start the session again.";

export function clampAudioSample(sample: number): number {
  return Math.max(-1, Math.min(1, sample));
}

export function floatToPcm16Bytes(samples: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampAudioSample(samples[index] ?? 0);
    const value = sample < 0 ? Math.round(sample * PCM16_SCALE) : Math.round(sample * 0x7fff);
    view.setInt16(index * 2, value, true);
  }
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function pcm16Base64ToFloat32(base64: string): Float32Array {
  return pcm16BytesToFloat32(base64ToBytes(base64));
}

export function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    const value = view.getInt16(index * 2, true);
    samples[index] = value < 0 ? value / PCM16_SCALE : value / 0x7fff;
  }
  return samples;
}

export function appendTranscriptText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;

  const needsSpace =
    !/\s$/.test(current) &&
    !/^\s/.test(incoming) &&
    !/^[.,!?;:'\u2019]/.test(incoming);
  return `${current}${needsSpace ? " " : ""}${incoming}`;
}

export function assertBrowserMediaSupport(): void {
  if (typeof window === "undefined") return;
  if (!window.isSecureContext) {
    throw new Error("Microphone access requires HTTPS or localhost.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone capture.");
  }
  if (!("AudioContext" in window)) {
    throw new Error("This browser does not support the Web Audio features required for voice chat.");
  }
}

export function assertGeminiAudioSupport(): void {
  assertBrowserMediaSupport();
  if (typeof window !== "undefined" && !("AudioWorkletNode" in window)) {
    throw new Error("This browser does not support the audio worklet required by Gemini Live.");
  }
}

export function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** A subtle, locally synthesized ambience shared by both voice transports. */
export class AmbientSoundPlayer {
  private context: AudioContext | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private gain: GainNode | null = null;

  async start(kind: "none" | "rain" | "ocean" | "fireplace"): Promise<void> {
    if (kind === "none") return;
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    const gain = context.createGain();
    gain.gain.value = kind === "fireplace" ? 0.035 : 0.045;
    gain.connect(context.destination);
    this.gain = gain;

    const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.random() * 2 - 1;
    }
    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const filter = context.createBiquadFilter();
    if (kind === "rain") {
      filter.type = "highpass";
      filter.frequency.value = 1_100;
    } else if (kind === "ocean") {
      filter.type = "lowpass";
      filter.frequency.value = 420;
    } else {
      filter.type = "bandpass";
      filter.frequency.value = 700;
      filter.Q.value = 0.65;
    }
    source.connect(filter);
    filter.connect(gain);
    source.start();
    this.sources.push(source);

    if (kind === "ocean") {
      const swell = context.createOscillator();
      const swellGain = context.createGain();
      swell.frequency.value = 0.12;
      swellGain.gain.value = 0.018;
      swell.connect(swellGain);
      swellGain.connect(gain);
      swell.start();
      this.sources.push(swell);
    }
    if (context.state === "suspended") await context.resume();
  }

  async stop(): Promise<void> {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source may already be stopped.
      }
      source.disconnect();
    }
    this.sources = [];
    this.gain?.disconnect();
    this.gain = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

function playbackAbortError(): DOMException {
  return new DOMException("Speaker playback was cancelled.", "AbortError");
}

function hasLiveAudioTrack(audio: HTMLAudioElement): boolean {
  const source = audio.srcObject;
  return (
    typeof MediaStream !== "undefined" &&
    source instanceof MediaStream &&
    source.getAudioTracks().some((track) => track.readyState === "live")
  );
}

async function playWithDeadline(
  audio: HTMLAudioElement,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  let playPromise: Promise<void>;
  try {
    playPromise = audio.play();
  } catch (error) {
    throw new Error(SPEAKER_PLAYBACK_ERROR, { cause: error });
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(playbackAbortError());
    const timer = setTimeout(
      () => finish(new Error("Speaker playback did not start in time.")),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    playPromise.then(() => finish(), (error) => finish(error));
    if (signal.aborted) onAbort();
  });
}

export async function ensureRemoteAudioPlayback(
  audio: HTMLAudioElement,
  signal: AbortSignal,
  timeoutMs = REMOTE_AUDIO_TRACK_TIMEOUT_MS,
): Promise<void> {
  if (signal.aborted) throw playbackAbortError();
  if (!hasLiveAudioTrack(audio)) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener("loadedmetadata", onMediaReady);
        audio.removeEventListener("canplay", onMediaReady);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onMediaReady = () => {
        if (hasLiveAudioTrack(audio)) finish();
      };
      const onAbort = () => finish(playbackAbortError());
      const timer = setTimeout(
        () => finish(new Error("The realtime connection did not provide a speaker track.")),
        timeoutMs,
      );
      audio.addEventListener("loadedmetadata", onMediaReady);
      audio.addEventListener("canplay", onMediaReady);
      signal.addEventListener("abort", onAbort, { once: true });
      onMediaReady();
    });
  }
  if (signal.aborted) throw playbackAbortError();
  if (!hasLiveAudioTrack(audio)) {
    throw new Error("The realtime connection did not provide a live speaker track.");
  }
  try {
    await playWithDeadline(audio, signal, timeoutMs);
  } catch (error) {
    if (signal.aborted) throw playbackAbortError();
    throw new Error(SPEAKER_PLAYBACK_ERROR, { cause: error });
  }
  if (audio.paused) throw new Error(SPEAKER_PLAYBACK_ERROR);
}

export class GeminiAudioCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;

  async start(
    stream: MediaStream,
    onChunk: (bytes: Uint8Array) => void,
    onLevel: (level: number) => void,
  ): Promise<void> {
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    await context.audioWorklet.addModule("/audio-recorder.worklet.js");
    if (this.context !== context) return;
    if (context.state === "suspended") await context.resume();
    if (this.context !== context) return;

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "pcm-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetSampleRate: 16000, chunkSamples: 640 },
    });
    const sink = context.createGain();
    sink.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "chunk" && event.data.buffer instanceof ArrayBuffer) {
        onChunk(new Uint8Array(event.data.buffer));
      } else if (event.data?.type === "level" && typeof event.data.value === "number") {
        onLevel(Math.max(0, Math.min(1, event.data.value)));
      }
    };
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(context.destination);
    this.source = source;
    this.worklet = worklet;
    this.sink = sink;
  }

  async stop(): Promise<void> {
    this.worklet?.port.postMessage({ type: "stop" });
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.worklet = null;
    this.source = null;
    this.sink = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

export class PcmAudioPlayer {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private playing = false;
  private resumePromise: Promise<void> | null = null;

  constructor(
    private readonly onPlayingChange: (playing: boolean) => void,
    private readonly onPlaybackError: (message: string) => void = () => undefined,
    private readonly onLevel: (level: number) => void = () => undefined,
  ) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  async prime(): Promise<void> {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext({ latencyHint: "interactive" });
    }
    const context = this.context;
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") {
      throw new Error("The browser could not activate speaker playback.");
    }
    if (!this.analyser) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.68;
      analyser.connect(context.destination);
      const samples = new Float32Array(analyser.fftSize);
      this.analyser = analyser;
      this.levelTimer = setInterval(() => {
        if (this.analyser !== analyser) return;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        this.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4.5));
      }, 60);
    }
  }

  play(base64: string): boolean {
    return this.playBytes(base64ToBytes(base64));
  }

  playBytes(bytes: Uint8Array): boolean {
    const context = this.context;
    if (!context || context.state === "closed") return false;
    if (context.state !== "running" && !this.resumePromise) {
      this.resumePromise = context
        .resume()
        .then(() => {
          if (this.context === context && context.state !== "running") {
            throw new Error("Speaker playback remained suspended.");
          }
        })
        .catch(() => {
          if (this.context === context) {
            this.clear();
            this.onPlaybackError(
              "The browser suspended speaker playback. Allow sound for this site, then start again.",
            );
          }
        })
        .finally(() => {
          this.resumePromise = null;
        });
    }
    const samples = pcm16BytesToFloat32(bytes);
    if (!samples.length) return true;

    const startAt = Math.max(context.currentTime + 0.025, this.nextStartTime);
    const queuedSeconds = startAt - context.currentTime;
    if (queuedSeconds > 45) return false;

    const buffer = context.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser ?? context.destination);
    source.addEventListener("ended", () => {
      this.sources.delete(source);
      if (this.sources.size === 0 && this.playing) {
        this.playing = false;
        this.onPlayingChange(false);
      }
    });
    this.sources.add(source);
    this.nextStartTime = startAt + buffer.duration;
    if (!this.playing) {
      this.playing = true;
      this.onPlayingChange(true);
    }
    source.start(startAt);
    return true;
  }

  clear(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended.
      }
      source.disconnect();
    }
    this.sources.clear();
    this.nextStartTime = this.context?.currentTime ?? 0;
    if (this.playing) {
      this.playing = false;
      this.onPlayingChange(false);
    }
  }

  async close(): Promise<void> {
    this.clear();
    this.resumePromise = null;
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.onLevel(0);
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

export class MediaLevelMeter {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sink: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  async start(stream: MediaStream, onLevel: (level: number) => void): Promise<void> {
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    if (context.state === "suspended") await context.resume();
    if (this.context !== context || context.state === "closed") return;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    const source = context.createMediaStreamSource(stream);
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(context.destination);
    const samples = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4.5));
    }, 60);
    this.source = source;
    this.analyser = analyser;
    this.sink = sink;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.sink?.disconnect();
    this.source = null;
    this.analyser = null;
    this.sink = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}
