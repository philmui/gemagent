import type { SessionPhase, TelemetryEventKind } from "./types";

export const SIGNAL_SAMPLE_COUNT = 120;

export interface SignalSample {
  user: number;
  agent: number;
  endpoint: number;
  toolMask: number;
}

export interface EndpointEstimatorState {
  speechActive: boolean;
  silenceMs: number;
  strength: number;
}

export const EMPTY_ENDPOINT_STATE: EndpointEstimatorState = {
  speechActive: false,
  silenceMs: 0,
  strength: 0,
};

export function clampSignal(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function appendSignalSample(
  samples: SignalSample[],
  sample: SignalSample,
  limit = SIGNAL_SAMPLE_COUNT,
): SignalSample[] {
  return [...samples.slice(-(limit - 1)), sample];
}

export function endpointEventState(
  state: EndpointEstimatorState,
  kind: TelemetryEventKind,
): EndpointEstimatorState {
  if (kind === "speech-start") {
    return { speechActive: true, silenceMs: 0, strength: 0 };
  }
  if (kind === "speech-end") {
    return { speechActive: false, silenceMs: 0, strength: 1 };
  }
  return state;
}

export function nextEndpointState(
  state: EndpointEstimatorState,
  inputLevel: number,
  phase: SessionPhase,
  elapsedMs: number,
): EndpointEstimatorState {
  const level = clampSignal(inputLevel);
  if (level >= 0.055) {
    return { speechActive: true, silenceMs: 0, strength: 0 };
  }
  if (phase === "assistant-thinking") {
    return { speechActive: false, silenceMs: 0, strength: 1 };
  }
  if (state.speechActive) {
    const silenceMs = state.silenceMs + Math.max(0, elapsedMs);
    return {
      speechActive: true,
      silenceMs,
      strength: Math.min(0.92, silenceMs / 850),
    };
  }
  return {
    speechActive: false,
    silenceMs: 0,
    strength: state.strength * 0.88 < 0.01 ? 0 : state.strength * 0.88,
  };
}

export function signalLinePath(
  values: number[],
  width = 560,
  height = 48,
  inset = 4,
): string {
  if (values.length === 0) return "";
  const drawableHeight = Math.max(1, height - inset * 2);
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = inset + (1 - clampSignal(value)) * drawableHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function signalAreaPath(
  values: number[],
  width = 560,
  height = 48,
  inset = 4,
): string {
  const line = signalLinePath(values, width, height, inset);
  if (!line) return "";
  const floor = (height - inset).toFixed(2);
  return `${line} L${width.toFixed(2)} ${floor} L0.00 ${floor} Z`;
}

export function signalEnvelopePath(
  values: number[],
  width = 560,
  height = 48,
  inset = 4,
): string {
  if (values.length === 0) return "";
  const center = height / 2;
  const amplitude = Math.max(1, center - inset);
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  const point = (value: number, index: number, direction: -1 | 1): string => {
    const x = index * step;
    const y = center + direction * clampSignal(value) * amplitude;
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  const upper = values.map((value, index) => point(value, index, -1));
  const lower = values
    .map((value, index) => point(value, index, 1))
    .reverse();
  return `M${upper.join(" L")} L${lower.join(" L")} Z`;
}
