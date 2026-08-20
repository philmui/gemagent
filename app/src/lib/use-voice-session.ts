"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AsyncSerialQueue } from "./async-serial-queue";
import { fetchHealth } from "./backend";
import { GeminiLiveAdapter } from "./gemini-adapter";
import { OpenAIRealtimeAdapter } from "./openai-adapter";
import {
  attachTtfa,
  captionItemId,
  finalizeEpoch,
  interruptAssistant,
  interruptPartials,
  transcriptItemId,
  upsertCaption,
} from "./transcript";
import { TtfaTracker } from "./ttfa";
import {
  DEFAULT_VOICE,
  DEFAULT_ADVANCED_VOICE_SETTINGS,
  PROVIDERS,
  VOICES,
  type AdapterCallbacks,
  type AdvancedVoiceSettings,
  type BackendHealth,
  type Provider,
  type SessionPhase,
  type TelemetryEvent,
  type TranscriptItem,
  type VerifiedSessionInfo,
  type VoiceSessionAdapter,
} from "./types";

const PROVIDER_STORAGE_KEY = "voice-lab.provider";
const VOICE_STORAGE_KEY = "voice-lab.voices";
const ADVANCED_SETTINGS_STORAGE_KEY = "voice-lab.advanced-voice-settings";

const DEFAULT_HEALTH: BackendHealth = {
  status: "unknown",
  providers: {
    gemini: {
      configured: false,
      model: PROVIDERS.gemini.defaultModel,
      runtime: "google-adk",
    },
    openai: {
      configured: false,
      model: PROVIDERS.openai.defaultModel,
      runtime: "openai-agents-sdk",
    },
  },
};

interface ActiveSession extends VerifiedSessionInfo {
  epoch: number;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The voice session could not start.";
}

async function stopAdapterFully(adapter: VoiceSessionAdapter | null, reason: string): Promise<void> {
  if (!adapter) return;
  // A new provider must never open while the old provider might still own the
  // microphone or playback device. Both adapters make stop idempotent.
  await adapter.stop(reason);
}

export function useVoiceSession() {
  const [selectedProvider, setSelectedProvider] = useState<Provider>("gemini");
  const [voices, setVoices] = useState<Record<Provider, string>>(DEFAULT_VOICE);
  const [advancedSettings, setAdvancedSettings] = useState<AdvancedVoiceSettings>(
    DEFAULT_ADVANCED_VOICE_SETTINGS,
  );
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [monitorEpoch, setMonitorEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [health, setHealth] = useState<BackendHealth>(DEFAULT_HEALTH);

  const epochRef = useRef(0);
  const sequenceRef = useRef(0);
  const telemetrySequenceRef = useRef(0);
  const adapterRef = useRef<VoiceSessionAdapter | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const engagedRef = useRef(false);
  const providerRef = useRef<Provider>("gemini");
  const voicesRef = useRef<Record<Provider, string>>(DEFAULT_VOICE);
  const advancedSettingsRef = useRef<AdvancedVoiceSettings>(DEFAULT_ADVANCED_VOICE_SETTINGS);
  const lifecycleRef = useRef(new AsyncSerialQueue());
  const ttfaTrackerRef = useRef(new TtfaTracker());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const storedProvider = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
        if (storedProvider === "gemini" || storedProvider === "openai") {
          providerRef.current = storedProvider;
          setSelectedProvider(storedProvider);
        }
        const storedVoices = JSON.parse(
          window.localStorage.getItem(VOICE_STORAGE_KEY) || "{}",
        ) as Partial<Record<Provider, string>>;
        const nextVoices = { ...DEFAULT_VOICE };
        for (const provider of ["gemini", "openai"] as const) {
          if (VOICES[provider].some((voice) => voice.id === storedVoices[provider])) {
            nextVoices[provider] = storedVoices[provider]!;
          }
        }
        voicesRef.current = nextVoices;
        setVoices(nextVoices);
        const storedAdvanced = JSON.parse(
          window.localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY) || "{}",
        ) as Partial<AdvancedVoiceSettings>;
        const legacyBackgroundFilter = storedAdvanced.backgroundSound as string | undefined;
        const nextAdvanced: AdvancedVoiceSettings = {
          ...DEFAULT_ADVANCED_VOICE_SETTINGS,
          ...storedAdvanced,
          backgroundSound: ["none", "rain", "ocean", "fireplace"].includes(
            legacyBackgroundFilter as string,
          )
            ? legacyBackgroundFilter as AdvancedVoiceSettings["backgroundSound"]
            : "none",
          noiseSuppression:
            typeof storedAdvanced.noiseSuppression === "boolean"
              ? storedAdvanced.noiseSuppression
              : legacyBackgroundFilter !== "off",
        };
        if (
          typeof nextAdvanced.stability !== "number" ||
          nextAdvanced.stability < 0 ||
          nextAdvanced.stability > 100 ||
          !["warm", "balanced", "bright"].includes(nextAdvanced.tone) ||
          !["relaxed", "natural", "brisk"].includes(nextAdvanced.pace) ||
          !["none", "rain", "ocean", "fireplace"].includes(nextAdvanced.backgroundSound) ||
          typeof nextAdvanced.noiseSuppression !== "boolean" ||
          typeof nextAdvanced.echoCancellation !== "boolean"
        ) throw new Error("Invalid advanced settings");
        advancedSettingsRef.current = nextAdvanced;
        setAdvancedSettings(nextAdvanced);
      } catch {
        // Storage may be unavailable in private browsing. Defaults remain usable.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal)
      .then(setHealth)
      .catch((healthError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          healthError instanceof Error
            ? healthError.message
            : "The backend health check failed.",
        );
        setPhase("error");
      });
    return () => controller.abort();
  }, []);

  const failEpoch = useCallback((epoch: number, message: string) => {
    if (epoch !== epochRef.current) return;
    epochRef.current += 1;
    ttfaTrackerRef.current.reset();
    abortRef.current?.abort();
    abortRef.current = null;
    engagedRef.current = false;
    setEngaged(false);
    setActive(null);
    setPhase("error");
    setError(message);
    setLevel(0);
    setOutputLevel(0);
    setTelemetryEvents([]);
    void lifecycleRef.current
      .run(async () => {
        const adapter = adapterRef.current;
        adapterRef.current = null;
        await stopAdapterFully(adapter, "error");
      })
      .catch(() => undefined);
  }, []);

  const transition = useCallback(
    async (provider: Provider, voice: string, switching: boolean) => {
      const previousEpoch = epochRef.current;
      const epoch = previousEpoch + 1;
      epochRef.current = epoch;
      ttfaTrackerRef.current.reset();
      setMonitorEpoch(epoch);
      abortRef.current?.abort();
      setError(null);
      setMuted(false);
      setLevel(0);
      setOutputLevel(0);
      setTelemetryEvents([]);
      setActive(null);
      setPhase(switching ? "switching" : "requesting-permission");
      engagedRef.current = true;
      setEngaged(true);
      if (previousEpoch > 0) {
        setTranscript((items) => interruptPartials(items, previousEpoch));
      }

      return lifecycleRef.current.run(async () => {
        const previousAdapter = adapterRef.current;
        adapterRef.current = null;
        await stopAdapterFully(
          previousAdapter,
          switching ? "provider-switch" : "restart",
        );
        if (epoch !== epochRef.current) return;

        const controller = new AbortController();
        abortRef.current = controller;
        let effectiveModel =
          health.providers[provider].model || PROVIDERS[provider].defaultModel;
        const isCurrent = () => epoch === epochRef.current && !controller.signal.aborted;
        const callbacks: AdapterCallbacks = {
          onPhase: (nextPhase) => {
            if (isCurrent()) setPhase(nextPhase);
          },
          onCaption: (event) => {
            if (!isCurrent()) return;
            const sequence = ++sequenceRef.current;
            const context = { epoch, provider, model: effectiveModel, sequence };
            const measurement =
              event.role === "assistant"
                ? ttfaTrackerRef.current.observeAssistantItem(
                    epoch,
                    captionItemId(event, context),
                  )
                : null;
            setTranscript((items) => {
              const next = upsertCaption(items, event, context);
              return measurement
                ? attachTtfa(next, measurement.itemId, measurement.milliseconds)
                : next;
            });
          },
          onTurnComplete: () => {
            if (isCurrent()) {
              ttfaTrackerRef.current.cancelUnmeasured();
              setTranscript((items) => finalizeEpoch(items, epoch));
            }
          },
          onInterrupted: (itemId) => {
            if (isCurrent()) {
              const measurement = itemId
                ? ttfaTrackerRef.current.observeAssistantItem(
                    epoch,
                    transcriptItemId(epoch, provider, "assistant", itemId),
                  )
                : null;
              ttfaTrackerRef.current.cancelUnmeasured();
              setTranscript((items) => {
                const next = interruptAssistant(items, epoch, itemId);
                return measurement
                  ? attachTtfa(next, measurement.itemId, measurement.milliseconds)
                  : next;
              });
            }
          },
          onLevel: (nextLevel) => {
            if (isCurrent()) setLevel(nextLevel);
          },
          onOutputLevel: (nextLevel) => {
            if (isCurrent()) setOutputLevel(nextLevel);
          },
          onAudioStart: (atMs) => {
            if (!isCurrent()) return;
            const measurement = ttfaTrackerRef.current.observeAudioStart(
              epoch,
              atMs,
            );
            if (measurement) {
              setTranscript((items) =>
                attachTtfa(items, measurement.itemId, measurement.milliseconds),
              );
            }
          },
          onAudioEnd: (atMs) => {
            if (!isCurrent()) return;
            // Tool-backed and other multi-part answers may create a second
            // assistant transcript item without another user utterance. Its
            // TTFA starts when the preceding assistant audio finishes.
            ttfaTrackerRef.current.beginTurn(epoch, atMs);
          },
          onTelemetry: (kind) => {
            if (!isCurrent()) return;
            if (kind === "speech-start") ttfaTrackerRef.current.cancelUnmeasured();
            if (kind === "speech-end") {
              ttfaTrackerRef.current.beginTurn(epoch, performance.now());
            }
            const event = { sequence: ++telemetrySequenceRef.current, kind };
            setTelemetryEvents((events) => [...events.slice(-31), event]);
          },
          onError: (message) => {
            if (isCurrent()) failEpoch(epoch, message);
          },
        };

        const adapter: VoiceSessionAdapter =
          provider === "gemini"
            ? new GeminiLiveAdapter(voice, advancedSettingsRef.current, callbacks)
            : new OpenAIRealtimeAdapter(voice, advancedSettingsRef.current, callbacks);
        adapterRef.current = adapter;

        try {
          const info = await adapter.start(controller.signal);
          if (!isCurrent()) {
            await adapter.stop("stale-start");
            return;
          }
          if (info.provider !== provider) {
            throw new Error(
              `${PROVIDERS[provider].label} acknowledged an unexpected provider. The session was closed.`,
            );
          }
          effectiveModel = info.model;
          setActive({ ...info, epoch });
          setPhase("listening");
          setTranscript((items) => [
            ...items,
            {
              id: `${epoch}:${provider}:system`,
              epoch,
              provider,
              model: info.model,
              role: "system",
              text: `${PROVIDERS[provider].label} session started`,
              status: "final",
              sequence: ++sequenceRef.current,
            },
          ]);
        } catch (startError) {
          if (!isCurrent() || isAbort(startError)) return;
          failEpoch(epoch, errorMessage(startError));
        }
      });
    },
    [failEpoch, health],
  );

  const start = useCallback(async () => {
    const provider = providerRef.current;
    if (!health.providers[provider].configured) {
      setError(
        health.status === "unknown"
          ? "The backend is not ready yet. Check that FastAPI is running."
          : `${PROVIDERS[provider].label} is not configured on the backend.`,
      );
      setPhase("error");
      return;
    }
    await transition(provider, voicesRef.current[provider], false);
  }, [health, transition]);

  const stop = useCallback(async () => {
    const interruptedEpoch = epochRef.current;
    const stopEpoch = interruptedEpoch + 1;
    epochRef.current = stopEpoch;
    ttfaTrackerRef.current.reset();
    abortRef.current?.abort();
    abortRef.current = null;
    engagedRef.current = false;
    setEngaged(false);
    setPhase("stopping");
    setError(null);
    setMuted(false);
    setLevel(0);
    setOutputLevel(0);
    setTelemetryEvents([]);
    setActive(null);
    setTranscript((items) => interruptPartials(items, interruptedEpoch));
    await lifecycleRef.current.run(async () => {
      const adapter = adapterRef.current;
      adapterRef.current = null;
      await stopAdapterFully(adapter, "user");
      if (stopEpoch !== epochRef.current) return;
      setPhase("idle");
    });
  }, []);

  const selectProvider = useCallback(
    (provider: Provider) => {
      if (provider === providerRef.current) return;
      if (!health.providers[provider].configured) {
        setError(`${PROVIDERS[provider].label} is not configured on the backend.`);
        return;
      }
      providerRef.current = provider;
      setSelectedProvider(provider);
      setError(null);
      try {
        window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
      } catch {
        // Selection still works without persistence.
      }
      if (engagedRef.current) {
        void transition(provider, voicesRef.current[provider], true);
      }
    },
    [health, transition],
  );

  const selectVoice = useCallback(
    (voice: string) => {
      const provider = providerRef.current;
      if (!VOICES[provider].some((option) => option.id === voice)) return;
      const nextVoices = { ...voicesRef.current, [provider]: voice };
      voicesRef.current = nextVoices;
      setVoices(nextVoices);
      try {
        window.localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(nextVoices));
      } catch {
        // Voice selection still works without persistence.
      }
      if (engagedRef.current) void transition(provider, voice, true);
    },
    [transition],
  );

  const updateAdvancedSettings = useCallback(
    (update: Partial<AdvancedVoiceSettings>) => {
      const next = { ...advancedSettingsRef.current, ...update };
      advancedSettingsRef.current = next;
      setAdvancedSettings(next);
      try {
        window.localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Advanced choices still work without persistence.
      }
      if (engagedRef.current) {
        void transition(providerRef.current, voicesRef.current[providerRef.current], true);
      }
    },
    [transition],
  );

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    adapterRef.current?.setMuted(nextMuted);
    if (nextMuted) setLevel(0);
  }, [muted]);

  const clearTranscript = useCallback(() => setTranscript([]), []);

  useEffect(
    () => () => {
      epochRef.current += 1;
      ttfaTrackerRef.current.reset();
      abortRef.current?.abort();
      void lifecycleRef.current
        .run(async () => {
          const adapter = adapterRef.current;
          adapterRef.current = null;
          await stopAdapterFully(adapter, "unmount");
        })
        .catch(() => undefined);
    },
    [],
  );

  return {
    selectedProvider,
    selectedVoice: voices[selectedProvider],
    voices,
    advancedSettings,
    phase,
    active,
    engaged,
    muted,
    level,
    outputLevel,
    telemetryEvents,
    monitorEpoch,
    error,
    transcript,
    health,
    start,
    stop,
    selectProvider,
    selectVoice,
    updateAdvancedSettings,
    toggleMute,
    clearTranscript,
  };
}
