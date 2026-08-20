import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendTranscriptText,
  base64ToBytes,
  bytesToBase64,
  ensureRemoteAudioPlayback,
  floatToPcm16Bytes,
  PcmAudioPlayer,
  pcm16Base64ToFloat32,
} from "../src/lib/audio";

const originalAudioContext = globalThis.AudioContext;
const originalMediaStream = globalThis.MediaStream;

class FakeMediaStream {
  constructor(
    private readonly tracks: Array<{ readyState: "live" | "ended" }> = [
      { readyState: "live" },
    ],
  ) {}

  getAudioTracks() {
    return this.tracks;
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;

  state: "running" | "suspended" | "closed" = "running";
  currentTime = 1;
  destination = {};
  resumeCalls = 0;
  rejectResume = false;
  sampleRates: number[] = [];
  starts: number[] = [];
  analyserSamples = new Float32Array([0.25, -0.25, 0.25, -0.25]);

  constructor() {
    FakeAudioContext.latest = this;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.rejectResume) throw new Error("blocked");
    this.state = "running";
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    this.sampleRates.push(sampleRate);
    const samples = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => samples,
    };
  }

  createBufferSource() {
    return {
      buffer: null,
      connect: () => undefined,
      disconnect: () => undefined,
      stop: () => undefined,
      addEventListener: () => undefined,
      start: (when: number) => this.starts.push(when),
    };
  }

  createAnalyser() {
    return {
      fftSize: 4,
      smoothingTimeConstant: 0,
      connect: () => undefined,
      disconnect: () => undefined,
      getFloatTimeDomainData: (samples: Float32Array) => {
        samples.set(this.analyserSamples.subarray(0, samples.length));
      },
    };
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

function installFakeAudioContext(): void {
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
}

function installFakeMediaStream(): void {
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    value: FakeMediaStream,
  });
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: originalAudioContext,
  });
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    value: originalMediaStream,
  });
  FakeAudioContext.latest = null;
});

describe("PCM16 conversion", () => {
  it("clamps samples and writes little-endian signed values", () => {
    const bytes = floatToPcm16Bytes(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(Array.from({ length: 7 }, (_, index) => view.getInt16(index * 2, true))).toEqual([
      -32768,
      -32768,
      -16384,
      0,
      16384,
      32767,
      32767,
    ]);
    expect(view.getInt16(2, false)).not.toBe(-32768);
  });

  it("round trips binary audio through base64", () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    expect(base64ToBytes(bytesToBase64(original))).toEqual(original);
  });

  it("decodes output PCM16 into normalized floats", () => {
    const pcm = floatToPcm16Bytes(new Float32Array([-1, -0.25, 0, 0.25, 1]));
    const decoded = pcm16Base64ToFloat32(bytesToBase64(pcm));
    expect(Array.from(decoded)).toEqual([
      -1,
      -0.25,
      0,
      expect.closeTo(0.25, 4),
      1,
    ]);
  });
});

describe("caption text merging", () => {
  it("adds natural spacing to deltas without duplicating cumulative text", () => {
    expect(appendTranscriptText("Hello", "world")).toBe("Hello world");
    expect(appendTranscriptText("Hello", ", friend")).toBe("Hello, friend");
    expect(appendTranscriptText("Hello", "Hello there")).toBe("Hello there");
    expect(appendTranscriptText("Hello there", "there")).toBe("Hello there");
  });
});

describe("speaker playback", () => {
  it("reports Gemini TTFA at the scheduled audio graph start", async () => {
    installFakeAudioContext();
    const starts: number[] = [];
    const before = performance.now();
    const player = new PcmAudioPlayer((playing, startsAtMs) => {
      if (playing && startsAtMs !== undefined) starts.push(startsAtMs);
    });
    await player.prime();

    player.playBytes(new Uint8Array([0, 0, 255, 127]));

    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeGreaterThanOrEqual(before + 24);
    await player.close();
  });

  it("measures the actual Gemini speaker output graph", async () => {
    vi.useFakeTimers();
    installFakeAudioContext();
    const levels: number[] = [];
    const player = new PcmAudioPlayer(
      () => undefined,
      () => undefined,
      (level) => levels.push(level),
    );
    await player.prime();
    player.playBytes(new Uint8Array([0, 0, 255, 127]));

    vi.advanceTimersByTime(60);

    expect(levels.at(-1)).toBeGreaterThan(0);
    await player.close();
    expect(levels.at(-1)).toBe(0);
  });

  it("resumes a suspended Gemini output context and schedules 24 kHz PCM", async () => {
    installFakeAudioContext();
    const errors: string[] = [];
    const player = new PcmAudioPlayer(() => undefined, (message) => errors.push(message));
    await player.prime();
    const context = FakeAudioContext.latest!;
    context.state = "suspended";

    expect(player.playBytes(new Uint8Array([0, 0, 255, 127]))).toBe(true);
    await Promise.resolve();

    expect(context.resumeCalls).toBe(1);
    expect(context.sampleRates).toEqual([24_000]);
    expect(context.starts).toHaveLength(1);
    expect(errors).toEqual([]);
    await player.close();
  });

  it("surfaces a Gemini speaker-resume failure instead of remaining silent", async () => {
    installFakeAudioContext();
    const errors: string[] = [];
    const player = new PcmAudioPlayer(() => undefined, (message) => errors.push(message));
    await player.prime();
    const context = FakeAudioContext.latest!;
    context.state = "suspended";
    context.rejectResume = true;

    player.playBytes(new Uint8Array([0, 0]));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual([expect.stringMatching(/suspended speaker playback/i)]);
    expect(player.isPlaying).toBe(false);
    await player.close();
  });

  it("requires OpenAI remote media and a successful play promise", async () => {
    installFakeMediaStream();
    let plays = 0;
    const audio = {
      srcObject: new FakeMediaStream() as unknown as MediaStream,
      paused: false,
      play: async () => {
        plays += 1;
      },
    } as unknown as HTMLAudioElement;

    await ensureRemoteAudioPlayback(audio, new AbortController().signal, 10);
    expect(plays).toBe(1);
  });

  it("turns an OpenAI autoplay rejection into an actionable error", async () => {
    installFakeMediaStream();
    const audio = {
      srcObject: new FakeMediaStream() as unknown as MediaStream,
      paused: true,
      play: async () => {
        throw new DOMException("blocked", "NotAllowedError");
      },
    } as unknown as HTMLAudioElement;

    await expect(
      ensureRemoteAudioPlayback(audio, new AbortController().signal, 10),
    ).rejects.toThrow(/blocked speaker playback/i);
  });

  it("rejects an OpenAI data-only connection with no speaker track", async () => {
    installFakeMediaStream();
    const audio = {
      srcObject: new FakeMediaStream([]) as unknown as MediaStream,
      paused: true,
      play: async () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLAudioElement;

    await expect(
      ensureRemoteAudioPlayback(audio, new AbortController().signal, 1),
    ).rejects.toThrow(/did not provide a speaker track/i);
  });

  it("cancels an OpenAI play promise that remains pending", async () => {
    installFakeMediaStream();
    const controller = new AbortController();
    const audio = {
      srcObject: new FakeMediaStream() as unknown as MediaStream,
      paused: true,
      play: () => new Promise<void>(() => undefined),
    } as unknown as HTMLAudioElement;

    const playback = ensureRemoteAudioPlayback(audio, controller.signal, 1_000);
    controller.abort();

    await expect(playback).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds an OpenAI play promise that never starts", async () => {
    installFakeMediaStream();
    const audio = {
      srcObject: new FakeMediaStream() as unknown as MediaStream,
      paused: true,
      play: () => new Promise<void>(() => undefined),
    } as unknown as HTMLAudioElement;

    await expect(
      ensureRemoteAudioPlayback(audio, new AbortController().signal, 1),
    ).rejects.toThrow(/blocked speaker playback/i);
  });
});
