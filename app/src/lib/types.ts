export type Provider = "gemini" | "openai";

export type SessionPhase =
  | "idle"
  | "requesting-permission"
  | "connecting"
  | "switching"
  | "listening"
  | "user-speaking"
  | "assistant-thinking"
  | "assistant-speaking"
  | "stopping"
  | "error";

export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptStatus = "partial" | "final" | "interrupted";

export interface TranscriptItem {
  id: string;
  epoch: number;
  provider: Provider;
  model: string;
  role: TranscriptRole;
  text: string;
  status: TranscriptStatus;
  sequence: number;
}

export interface ProviderOption {
  id: Provider;
  label: string;
  company: string;
  description: string;
  defaultModel: string;
  accent: "violet" | "mint";
}

export interface VoiceOption {
  id: string;
  label: string;
  tone: string;
}

export type VoiceTone = "warm" | "balanced" | "bright";
export type BackgroundSound = "none" | "rain" | "ocean" | "fireplace";

export interface AdvancedVoiceSettings {
  /** Higher values favor an even, less animated delivery. */
  stability: number;
  tone: VoiceTone;
  pace: "relaxed" | "natural" | "brisk";
  /** A locally generated ambient bed played alongside the voice agent. */
  backgroundSound: BackgroundSound;
  noiseSuppression: boolean;
  echoCancellation: boolean;
}

export const DEFAULT_ADVANCED_VOICE_SETTINGS: AdvancedVoiceSettings = {
  stability: 65,
  tone: "balanced",
  pace: "natural",
  backgroundSound: "none",
  noiseSuppression: true,
  echoCancellation: true,
};

export const PROVIDERS: Record<Provider, ProviderOption> = {
  gemini: {
    id: "gemini",
    label: "Gemini Live",
    company: "Google",
    description: "Gemini Live orchestrated by Google ADK",
    defaultModel: "gemini-live-2.5-flash-native-audio",
    accent: "violet",
  },
  openai: {
    id: "openai",
    label: "OpenAI Realtime",
    company: "OpenAI",
    description: "OpenAI Agents SDK over browser WebRTC",
    defaultModel: "gpt-realtime-2.1",
    accent: "mint",
  },
};

export const VOICES: Record<Provider, VoiceOption[]> = {
  gemini: [
    { id: "Kore", label: "Kore", tone: "Clear and firm" },
    { id: "Puck", label: "Puck", tone: "Bright and upbeat" },
    { id: "Aoede", label: "Aoede", tone: "Relaxed and breezy" },
    { id: "Fenrir", label: "Fenrir", tone: "Energetic and expressive" },
  ],
  openai: [
    { id: "marin", label: "Marin", tone: "Natural and polished" },
    { id: "cedar", label: "Cedar", tone: "Warm and grounded" },
    { id: "coral", label: "Coral", tone: "Friendly and conversational" },
    { id: "sage", label: "Sage", tone: "Calm and measured" },
  ],
};

export const DEFAULT_VOICE: Record<Provider, string> = {
  gemini: "Kore",
  openai: "marin",
};

export interface SessionCredential {
  provider: Provider;
  token: string;
  expires_at: string;
  model: string;
  transport: {
    type: "websocket" | "webrtc";
    url: string;
  };
  config: Record<string, unknown>;
}

export interface VerifiedSessionInfo {
  provider: Provider;
  model: string;
  voice: string;
  transport: "websocket" | "webrtc";
  agentRuntime: "google-adk" | "openai-agents-sdk";
}

export interface CaptionEvent {
  role: Exclude<TranscriptRole, "system">;
  text: string;
  itemId: string;
  mode: "append" | "replace";
  final?: boolean;
}

export type TelemetryEventKind =
  | "speech-start"
  | "speech-end"
  | "tool-call"
  | "tool-return";

export interface TelemetryEvent {
  sequence: number;
  kind: TelemetryEventKind;
}

export interface AdapterCallbacks {
  onPhase: (phase: SessionPhase) => void;
  onCaption: (event: CaptionEvent) => void;
  onTurnComplete: () => void;
  onInterrupted: (itemId?: string) => void;
  onLevel: (level: number) => void;
  onOutputLevel: (level: number) => void;
  onTelemetry: (kind: TelemetryEventKind) => void;
  onError: (message: string) => void;
}

export interface VoiceSessionAdapter {
  readonly provider: Provider;
  start(signal: AbortSignal): Promise<VerifiedSessionInfo>;
  stop(reason?: string): Promise<void>;
  setMuted(muted: boolean): void;
}

export interface ProviderHealth {
  configured: boolean;
  model: string;
  runtime: "google-adk" | "openai-agents-sdk";
}

export interface BackendHealth {
  status: string;
  providers: Record<Provider, ProviderHealth>;
}
