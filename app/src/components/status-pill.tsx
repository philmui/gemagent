import type { SessionPhase } from "@/lib/types";

const PHASE_LABELS: Record<SessionPhase, string> = {
  idle: "Ready",
  "requesting-permission": "Waiting for microphone",
  connecting: "Connecting",
  switching: "Switching provider",
  listening: "Listening",
  "user-speaking": "You are speaking",
  "assistant-thinking": "Thinking",
  "assistant-speaking": "Speaking",
  stopping: "Stopping",
  error: "Needs attention",
};

export function StatusPill({ phase }: { phase: SessionPhase }) {
  const live = ["listening", "user-speaking", "assistant-thinking", "assistant-speaking"].includes(
    phase,
  );
  return (
    <div className={`status-pill status-${phase}`} role="status" aria-live="polite">
      <span className={`status-dot${live ? " is-live" : ""}`} aria-hidden="true" />
      {PHASE_LABELS[phase]}
    </div>
  );
}
