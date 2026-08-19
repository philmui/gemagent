import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterCallbacks } from "../src/lib/types";

type EventHandler = (...args: unknown[]) => void;

const sdkState = vi.hoisted(() => {
  class EventEmitter {
    private readonly handlers = new Map<string, Set<EventHandler>>();

    on(event: string, handler: EventHandler): void {
      const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
      handlers.add(handler);
      this.handlers.set(event, handlers);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  const sessions: FakeRealtimeSession[] = [];
  const transports: FakeOpenAIRealtimeWebRTC[] = [];
  const toolDefinitions: Record<string, unknown>[] = [];
  let remoteStream: unknown = null;

  class FakeOpenAIRealtimeWebRTC extends EventEmitter {
    constructor(readonly options: Record<string, unknown>) {
      super();
      if (remoteStream) {
        (options.audioElement as { srcObject: unknown }).srcObject = remoteStream;
      }
      transports.push(this);
    }
  }

  class FakeRealtimeAgent {
    constructor(readonly options: Record<string, unknown>) {}
  }

  function fakeTool(options: Record<string, unknown>): Record<string, unknown> {
    toolDefinitions.push(options);
    return { type: "function", ...options };
  }

  class FakeRealtimeSession extends EventEmitter {
    readonly close = vi.fn();
    readonly mute = vi.fn();

    constructor(
      readonly agent: FakeRealtimeAgent,
      readonly options: Record<string, unknown>,
    ) {
      super();
      sessions.push(this);
    }

    async connect(): Promise<void> {
      this.emit("transport_event", {
        type: "session.updated",
        session: {
          model: "gpt-realtime-2.1",
          audio: { output: { voice: "marin" } },
        },
      });
    }
  }

  return {
    FakeOpenAIRealtimeWebRTC,
    FakeRealtimeAgent,
    FakeRealtimeSession,
    sessions,
    transports,
    toolDefinitions,
    fakeTool,
    setRemoteStream: (stream: unknown) => {
      remoteStream = stream;
    },
  };
});

const audioState = vi.hoisted(() => ({
  ensureRemoteAudioPlayback: vi.fn(async () => undefined),
  meterStart: vi.fn(async () => undefined),
  meterStop: vi.fn(async () => undefined),
  ambienceStart: vi.fn(async () => undefined),
  ambienceStop: vi.fn(async () => undefined),
}));

const backendState = vi.hoisted(() => ({
  mintCredential: vi.fn(async () => ({
    provider: "openai" as const,
    token: "ephemeral-test-token",
    expires_at: "2099-01-01T00:00:00Z",
    model: "gpt-realtime-2.1",
    transport: { type: "webrtc" as const, url: "https://example.test/realtime" },
    config: {},
  })),
  search: vi.fn(async (query: string, signal: AbortSignal) => {
    void query;
    void signal;
    return {
      answer: "Current answer",
      sources: [{ title: "Official source", url: "https://example.test/source" }],
    };
  }),
}));

vi.mock("@openai/agents/realtime", () => ({
  OpenAIRealtimeWebRTC: sdkState.FakeOpenAIRealtimeWebRTC,
  RealtimeAgent: sdkState.FakeRealtimeAgent,
  RealtimeSession: sdkState.FakeRealtimeSession,
  tool: sdkState.fakeTool,
}));

vi.mock("../src/lib/audio", () => ({
  AmbientSoundPlayer: class {
    start = audioState.ambienceStart;
    stop = audioState.ambienceStop;
  },
  assertBrowserMediaSupport: vi.fn(),
  ensureRemoteAudioPlayback: audioState.ensureRemoteAudioPlayback,
  MediaLevelMeter: class {
    start = audioState.meterStart;
    stop = audioState.meterStop;
  },
  stopMediaStream: (stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  },
}));

vi.mock("../src/lib/backend", () => ({
  mintOpenAISessionCredential: backendState.mintCredential,
  searchOpenAIWeb: backendState.search,
}));

import { OpenAIRealtimeAdapter } from "../src/lib/openai-adapter";

class FakeMediaTrack {
  readonly readyState = "live";
  readonly stop = vi.fn();
}

class FakeMediaStream {
  constructor(readonly tracks = [new FakeMediaTrack()]) {}

  getTracks(): FakeMediaTrack[] {
    return this.tracks;
  }

  getAudioTracks(): FakeMediaTrack[] {
    return this.tracks;
  }
}

const mountedAudio: FakeAudioElement[] = [];

class FakeAudioElement extends EventTarget {
  static readonly instances: FakeAudioElement[] = [];

  autoplay = false;
  controls = true;
  paused = false;
  srcObject: FakeMediaStream | null = null;
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly play = vi.fn(async () => {
    this.paused = false;
  });
  readonly load = vi.fn();
  removed = false;

  constructor() {
    super();
    FakeAudioElement.instances.push(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  remove(): void {
    this.removed = true;
    const index = mountedAudio.indexOf(this);
    if (index >= 0) mountedAudio.splice(index, 1);
  }
}

const originalGlobals = new Map(
  ["Audio", "MediaStream", "document", "navigator", "window"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);

function callbacks(): AdapterCallbacks {
  return {
    onPhase: vi.fn(),
    onCaption: vi.fn(),
    onTurnComplete: vi.fn(),
    onInterrupted: vi.fn(),
    onLevel: vi.fn(),
    onOutputLevel: vi.fn(),
    onTelemetry: vi.fn(),
    onError: vi.fn(),
  };
}

function installBrowser(inputStream: FakeMediaStream): void {
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: FakeAudioElement,
  });
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    value: FakeMediaStream,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: {
        appendChild: (audio: FakeAudioElement) => {
          mountedAudio.push(audio);
          return audio;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: vi.fn(async () => inputStream),
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
}

async function flushPlaybackRecovery(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  sdkState.sessions.length = 0;
  sdkState.transports.length = 0;
  sdkState.toolDefinitions.length = 0;
  sdkState.setRemoteStream(null);
  mountedAudio.length = 0;
  FakeAudioElement.instances.length = 0;
  audioState.ensureRemoteAudioPlayback.mockReset();
  audioState.ensureRemoteAudioPlayback.mockResolvedValue(undefined);
  audioState.meterStart.mockClear();
  audioState.meterStop.mockClear();
  backendState.mintCredential.mockClear();
  backendState.search.mockClear();
});

afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe("OpenAI adapter speaker lifecycle", () => {
  it("recovers playback after a runtime pause and when response audio starts", async () => {
    const remoteStream = new FakeMediaStream();
    installBrowser(new FakeMediaStream());
    sdkState.setRemoteStream(remoteStream);
    const events = callbacks();
    const adapter = new OpenAIRealtimeAdapter("marin", events);

    await adapter.start(new AbortController().signal);
    const audio = FakeAudioElement.instances[0]!;
    const session = sdkState.sessions[0]!;
    expect(audioState.ensureRemoteAudioPlayback).toHaveBeenCalledTimes(1);
    expect(audioState.meterStart).toHaveBeenCalledWith(remoteStream, expect.any(Function));

    audioState.ensureRemoteAudioPlayback.mockClear();
    audio.paused = true;
    audio.dispatchEvent(new Event("pause"));
    await flushPlaybackRecovery();
    expect(audioState.ensureRemoteAudioPlayback).toHaveBeenCalledTimes(1);
    expect(audioState.ensureRemoteAudioPlayback).toHaveBeenLastCalledWith(
      audio,
      expect.any(AbortSignal),
    );

    audioState.ensureRemoteAudioPlayback.mockClear();
    session.emit("transport_event", { type: "output_audio_buffer.started" });
    await flushPlaybackRecovery();
    expect(audioState.ensureRemoteAudioPlayback).toHaveBeenCalledTimes(1);
    expect(events.onPhase).toHaveBeenLastCalledWith("assistant-speaking");

    await adapter.stop("test-complete");
  });

  it("projects provider VAD and sanitized function lifecycle events", async () => {
    installBrowser(new FakeMediaStream());
    const events = callbacks();
    const adapter = new OpenAIRealtimeAdapter("marin", events);
    await adapter.start(new AbortController().signal);
    const session = sdkState.sessions[0]!;

    session.emit("transport_event", { type: "input_audio_buffer.speech_started" });
    session.emit("transport_event", { type: "input_audio_buffer.speech_stopped" });
    session.emit("history_updated", [
      {
        type: "function_call",
        itemId: "private-call-id",
        name: "private_tool_name",
        arguments: "{\"private\":true}",
        output: null,
        status: "in_progress",
      },
    ]);
    session.emit("history_updated", [
      {
        type: "function_call",
        itemId: "private-call-id",
        name: "private_tool_name",
        arguments: "{\"private\":true}",
        output: null,
        status: "completed",
      },
    ]);
    session.emit("history_updated", [
      {
        type: "function_call",
        itemId: "private-call-id",
        name: "private_tool_name",
        arguments: "{\"private\":true}",
        output: "private result",
        status: "completed",
      },
    ]);

    expect(events.onTelemetry).toHaveBeenNthCalledWith(1, "speech-start");
    expect(events.onTelemetry).toHaveBeenNthCalledWith(2, "speech-end");
    expect(events.onTelemetry).toHaveBeenNthCalledWith(3, "tool-call");
    expect(events.onTelemetry).toHaveBeenNthCalledWith(4, "tool-return");
    await adapter.stop("test-complete");
  });

  it("registers and executes web search through the backend", async () => {
    installBrowser(new FakeMediaStream());
    const adapter = new OpenAIRealtimeAdapter("marin", callbacks());
    await adapter.start(new AbortController().signal);

    expect(sdkState.toolDefinitions).toHaveLength(1);
    const definition = sdkState.toolDefinitions[0]!;
    expect(definition.name).toBe("web_search");
    const execute = definition.execute as (input: { query: string }) => Promise<string>;
    await expect(execute({ query: "latest release" })).resolves.toBe(
      JSON.stringify({
        answer: "Current answer",
        sources: [{ title: "Official source", url: "https://example.test/source" }],
      }),
    );
    expect(backendState.search).toHaveBeenCalledWith("latest release", expect.any(AbortSignal));
    const toolSignal = backendState.search.mock.calls[0]![1];

    await adapter.stop("test-complete");
    expect(toolSignal.aborted).toBe(true);
  });

  it("removes the old output surface and ignores stale events during a provider switch", async () => {
    const firstInput = new FakeMediaStream();
    installBrowser(firstInput);
    const firstCallbacks = callbacks();
    const first = new OpenAIRealtimeAdapter("marin", firstCallbacks);
    await first.start(new AbortController().signal);

    const firstAudio = FakeAudioElement.instances[0]!;
    const firstSession = sdkState.sessions[0]!;
    const remote = new FakeMediaStream();
    firstAudio.srcObject = remote;
    audioState.ensureRemoteAudioPlayback.mockClear();

    await first.stop("provider-switch");

    expect(firstSession.close).toHaveBeenCalledTimes(1);
    expect(firstAudio.removed).toBe(true);
    expect(firstAudio.srcObject).toBeNull();
    expect(firstInput.tracks[0]!.stop).toHaveBeenCalledTimes(1);
    expect(remote.tracks[0]!.stop).toHaveBeenCalledTimes(1);
    expect(mountedAudio).toEqual([]);

    firstSession.emit("transport_event", { type: "output_audio_buffer.started" });
    firstAudio.dispatchEvent(new Event("pause"));
    await flushPlaybackRecovery();
    expect(audioState.ensureRemoteAudioPlayback).not.toHaveBeenCalled();

    const second = new OpenAIRealtimeAdapter("marin", callbacks());
    await second.start(new AbortController().signal);
    expect(mountedAudio).toHaveLength(1);
    expect(mountedAudio[0]).not.toBe(firstAudio);
    await second.stop("test-complete");
  });
});
