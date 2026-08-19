import { MicIcon } from "./icons";
import type { Provider, SessionPhase, TelemetryEvent } from "@/lib/types";
import { SignalMonitor } from "./signal-monitor";

const PHASE_COPY: Record<SessionPhase, { title: string; detail: string }> = {
  idle: { title: "Start a conversation", detail: "Your microphone stays off until you choose Start" },
  "requesting-permission": { title: "Allow microphone access", detail: "Your browser may be waiting for a permission choice" },
  connecting: { title: "Opening your voice session", detail: "Connecting to the selected voice provider" },
  switching: { title: "Changing voice engine", detail: "The previous audio path is closing first" },
  listening: { title: "I’m listening", detail: "Speak naturally, and interrupt whenever you want" },
  "user-speaking": { title: "I can hear you", detail: "Pause when you are ready for a response" },
  "assistant-thinking": { title: "Thinking it through", detail: "A spoken response is on the way" },
  "assistant-speaking": { title: "Responding", detail: "Start speaking at any time to interrupt" },
  stopping: { title: "Closing the session", detail: "Releasing microphone and audio resources" },
  error: { title: "The session needs attention", detail: "Review the message below, then try again" },
};

interface VoiceOrbProps {
  phase: SessionPhase;
  provider: Provider;
  level: number;
  outputLevel: number;
  telemetryEvents: TelemetryEvent[];
  sessionEpoch: number;
  engaged: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function VoiceOrb({
  phase,
  provider,
  level,
  outputLevel,
  telemetryEvents,
  sessionEpoch,
  engaged,
  onStart,
  onStop,
}: VoiceOrbProps) {
  const copy = phase === "connecting"
    ? {
        ...PHASE_COPY.connecting,
        detail: provider === "gemini"
          ? "Connecting your browser to this application's Google ADK audio gateway"
          : "Using a short-lived client secret to open a direct OpenAI WebRTC session",
      }
    : PHASE_COPY[phase];
  const normalizedLevel = Math.max(0.05, Math.min(1, level));
  const isStopping = phase === "stopping";
  const showStopState = engaged || isStopping;
  if (showStopState) {
    return (
      <div className={`voice-stage signal-stage provider-${provider}`}>
        <SignalMonitor
          key={`${provider}-${sessionEpoch}`}
          phase={phase}
          inputLevel={level}
          outputLevel={outputLevel}
          telemetryEvents={telemetryEvents}
          stopping={isStopping}
          onStop={onStop}
        />
      </div>
    );
  }
  return (
    <div className={`voice-stage provider-${provider}`}>
      <div className="orb-wrap" aria-hidden="true">
        <div className="orb-aura" style={{ transform: `scale(${1 + normalizedLevel * 0.14})` }} />
        <div className="level-ring">
          {Array.from({ length: 28 }, (_, index) => {
            const variation = 0.42 + ((index * 7) % 11) / 18;
            const height = 7 + normalizedLevel * variation * 29;
            return (
              <span
                key={index}
                style={{
                  height: `${height}px`,
                  transform: `rotate(${index * (360 / 28)}deg) translateY(-84px)`,
                }}
              />
            );
          })}
        </div>
      </div>

      <button
        type="button"
        className="orb-button"
        onClick={onStart}
        disabled={isStopping}
        aria-label="Start voice session"
      >
        <MicIcon />
        <span>Start</span>
      </button>
      <div className="stage-copy">
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
      </div>
    </div>
  );
}
