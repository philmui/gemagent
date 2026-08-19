"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  appendSignalSample,
  clampSignal,
  EMPTY_ENDPOINT_STATE,
  endpointEventState,
  nextEndpointState,
  SIGNAL_SAMPLE_COUNT,
  signalAreaPath,
  signalEnvelopePath,
  signalLinePath,
  type EndpointEstimatorState,
  type SignalSample,
} from "@/lib/signal-timeline";
import type { SessionPhase, TelemetryEvent } from "@/lib/types";
import { StopIcon } from "./icons";

const SAMPLE_INTERVAL_MS = 80;
const PLOT_WIDTH = 560;
const PLOT_HEIGHT = 48;
const PLOT_TICKS = [140, 280, 420];

const EMPTY_SAMPLE: SignalSample = { user: 0, agent: 0, endpoint: 0, toolMask: 0 };

interface SignalMonitorProps {
  phase: SessionPhase;
  inputLevel: number;
  outputLevel: number;
  telemetryEvents: TelemetryEvent[];
  stopping: boolean;
  onStop: () => void;
}

interface SignalLaneProps {
  className: string;
  code: string;
  label: string;
  compactLabel: string;
  detail: string;
  value: number;
  variant: "amplitude" | "confidence";
  fillPath: string;
  linePath?: string;
}

const PHASE_SIGNAL_LABEL: Record<SessionPhase, string> = {
  idle: "Standby",
  "requesting-permission": "Permission",
  connecting: "Connecting",
  switching: "Switching",
  listening: "Listening",
  "user-speaking": "Input active",
  "assistant-thinking": "Processing",
  "assistant-speaking": "Output active",
  stopping: "Closing",
  error: "Attention",
};

function SignalLane({
  className,
  code,
  label,
  compactLabel,
  detail,
  value,
  variant,
  fillPath,
  linePath,
}: SignalLaneProps) {
  const rawId = useId();
  const gradientId = `signal-fill-${rawId.replaceAll(":", "")}`;
  const current = clampSignal(value);
  const currentY = variant === "amplitude"
    ? PLOT_HEIGHT / 2 - current * (PLOT_HEIGHT / 2 - 4)
    : 4 + (1 - current) * (PLOT_HEIGHT - 8);

  return (
    <div className={`signal-lane ${className}`}>
      <div className="signal-lane-copy">
        <span className="signal-lane-heading">
          <i className="signal-lane-code" aria-hidden="true">{code}</i>
          <span>
            <b className="signal-label-full">{label}</b>
            <b className="signal-label-compact">{compactLabel}</b>
            <small>{detail}</small>
          </span>
        </span>
      </div>
      <div className="signal-chart">
        <svg
          className="signal-plot"
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}: ${Math.round(current * 100)} percent`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              {variant === "amplitude" ? (
                <>
                  <stop offset="0" stopColor="var(--lane-color)" stopOpacity=".08" />
                  <stop offset=".48" stopColor="var(--lane-color)" stopOpacity=".42" />
                  <stop offset=".52" stopColor="var(--lane-color)" stopOpacity=".42" />
                  <stop offset="1" stopColor="var(--lane-color)" stopOpacity=".08" />
                </>
              ) : (
                <>
                  <stop offset="0" stopColor="var(--lane-color)" stopOpacity=".48" />
                  <stop offset=".58" stopColor="var(--lane-color)" stopOpacity=".18" />
                  <stop offset="1" stopColor="var(--lane-color)" stopOpacity=".03" />
                </>
              )}
            </linearGradient>
          </defs>
          {PLOT_TICKS.map((x) => (
            <line key={x} className="signal-grid signal-grid-vertical" x1={x} y1="0" x2={x} y2={PLOT_HEIGHT} />
          ))}
          {variant === "amplitude" ? (
            <line className="signal-centerline" x1="0" y1="24" x2={PLOT_WIDTH} y2="24" />
          ) : (
            <>
              <line className="signal-grid" x1="0" y1="24" x2={PLOT_WIDTH} y2="24" />
              <line className="signal-grid" x1="0" y1="36" x2={PLOT_WIDTH} y2="36" />
              <line className="signal-threshold" x1="0" y1="12" x2={PLOT_WIDTH} y2="12" />
            </>
          )}
          <path
            className={variant === "amplitude" ? "signal-envelope" : "signal-area"}
            d={fillPath}
            fill={`url(#${gradientId})`}
            vectorEffect="non-scaling-stroke"
          />
          {linePath ? (
            <path className="signal-line" d={linePath} vectorEffect="non-scaling-stroke" />
          ) : null}
          <line className="signal-now-rail" x1="558" y1="2" x2="558" y2="46" />
          <circle className="signal-current-halo" cx="554" cy={currentY} r="5" />
          <circle className="signal-current-dot" cx="554" cy={currentY} r="2.2" />
        </svg>
      </div>
      <div className="signal-value" aria-hidden="true">
        <strong>{Math.round(current * 100)}</strong><span>%</span>
      </div>
    </div>
  );
}

export function SignalMonitor({
  phase,
  inputLevel,
  outputLevel,
  telemetryEvents,
  stopping,
  onStop,
}: SignalMonitorProps) {
  const [samples, setSamples] = useState<SignalSample[]>(() =>
    Array.from({ length: SIGNAL_SAMPLE_COUNT }, () => ({ ...EMPTY_SAMPLE })),
  );
  const liveRef = useRef({ inputLevel, outputLevel, phase });
  const endpointRef = useRef<EndpointEstimatorState>({ ...EMPTY_ENDPOINT_STATE });
  const pendingToolMaskRef = useRef(0);
  const lastTelemetrySequenceRef = useRef(0);

  useEffect(() => {
    liveRef.current = { inputLevel, outputLevel, phase };
  }, [inputLevel, outputLevel, phase]);

  useEffect(() => {
    for (const event of telemetryEvents) {
      if (event.sequence <= lastTelemetrySequenceRef.current) continue;
      if (event.kind === "tool-call") pendingToolMaskRef.current |= 1;
      else if (event.kind === "tool-return") pendingToolMaskRef.current |= 2;
      else endpointRef.current = endpointEventState(endpointRef.current, event.kind);
      lastTelemetrySequenceRef.current = event.sequence;
    }
  }, [telemetryEvents]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const live = liveRef.current;
      endpointRef.current = nextEndpointState(
        endpointRef.current,
        live.inputLevel,
        live.phase,
        SAMPLE_INTERVAL_MS,
      );
      const toolMask = pendingToolMaskRef.current;
      pendingToolMaskRef.current = 0;
      setSamples((history) =>
        appendSignalSample(history, {
          user: live.inputLevel,
          agent: live.outputLevel,
          endpoint: endpointRef.current.strength,
          toolMask,
        }),
      );
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const userPath = useMemo(
    () => signalEnvelopePath(samples.map((sample) => sample.user)),
    [samples],
  );
  const agentPath = useMemo(
    () => signalEnvelopePath(samples.map((sample) => sample.agent)),
    [samples],
  );
  const endpointPath = useMemo(
    () => signalLinePath(samples.map((sample) => sample.endpoint)),
    [samples],
  );
  const endpointArea = useMemo(
    () => signalAreaPath(samples.map((sample) => sample.endpoint)),
    [samples],
  );
  const current = samples.at(-1) ?? EMPTY_SAMPLE;
  const latestTool = [...telemetryEvents]
    .reverse()
    .find((event) => event.kind === "tool-call" || event.kind === "tool-return");
  const toolState = latestTool?.kind === "tool-call"
    ? "calling"
    : latestTool?.kind === "tool-return"
      ? "response"
      : "ready";
  const toolLabel = toolState === "calling"
    ? "Calling"
    : toolState === "response"
      ? "Response"
      : "Ready";

  return (
    <section className="signal-monitor" aria-label="Live audio and agent signal monitor">
      <div className="signal-monitor-header">
        <div>
          <div className="signal-monitor-title-row">
            <p className="signal-monitor-kicker"><i aria-hidden="true" />Live signal monitor</p>
            <span className="signal-phase-chip" data-phase={phase}>{PHASE_SIGNAL_LABEL[phase]}</span>
          </div>
          <p>Audio, function calls, and endpointing synchronized on one timeline</p>
        </div>
        <div className="signal-monitor-actions">
          <span className="signal-window-chip" aria-hidden="true"><small>Window</small><strong>10s</strong></span>
          <button
            type="button"
            className="signal-end-button"
            onClick={onStop}
            disabled={stopping}
            aria-label={stopping ? "Voice session is stopping" : "End voice session"}
          >
            <StopIcon />
            <span>{stopping ? "Closing" : "End"}</span>
          </button>
        </div>
      </div>

      <div className="signal-lanes">
        <SignalLane
          className="signal-user"
          code="IN"
          label="Your audio"
          compactLabel="You"
          detail="Microphone input"
          value={current.user}
          variant="amplitude"
          fillPath={userPath}
        />
        <SignalLane
          className="signal-agent"
          code="OUT"
          label="Agent audio"
          compactLabel="Agent"
          detail="Synthesized output"
          value={current.agent}
          variant="amplitude"
          fillPath={agentPath}
        />
        <div className="signal-lane signal-tools" data-state={toolState}>
          <div className="signal-lane-copy">
            <span className="signal-lane-heading">
              <i className="signal-lane-code" aria-hidden="true">FX</i>
              <span>
                <b className="signal-label-full">Function activity</b>
                <b className="signal-label-compact">Tools</b>
                <small>Call above · response below</small>
              </span>
            </span>
          </div>
          <div className="signal-chart signal-tool-chart">
            <svg
              className="signal-plot tool-plot"
              viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`Web search function activity: ${toolLabel}`}
            >
              <rect className="tool-call-zone" x="0" y="2" width={PLOT_WIDTH} height="20" rx="5" />
              <rect className="tool-return-zone" x="0" y="26" width={PLOT_WIDTH} height="20" rx="5" />
              {PLOT_TICKS.map((x) => (
                <line key={x} className="signal-grid signal-grid-vertical" x1={x} y1="0" x2={x} y2={PLOT_HEIGHT} />
              ))}
              <line className="tool-baseline" x1="0" y1="24" x2={PLOT_WIDTH} y2="24" />
              {samples.map((sample, index) => {
                if (!sample.toolMask) return null;
                const x = 8 + (index / (samples.length - 1)) * (PLOT_WIDTH - 16);
                return (
                  <g key={`${index}-${sample.toolMask}`}>
                    {sample.toolMask & 1 ? (
                      <>
                        <line className="tool-call-mark" x1={x} y1="24" x2={x} y2="8" />
                        <circle className="tool-call-halo" cx={x} cy="8" r="7" />
                        <circle className="tool-call-dot" cx={x} cy="8" r="3" />
                      </>
                    ) : null}
                    {sample.toolMask & 2 ? (
                      <>
                        <line className="tool-return-mark" x1={x} y1="24" x2={x} y2="40" />
                        <circle className="tool-return-halo" cx={x} cy="40" r="7" />
                        <circle className="tool-return-dot" cx={x} cy="40" r="3" />
                      </>
                    ) : null}
                  </g>
                );
              })}
              <line className="signal-now-rail" x1="558" y1="2" x2="558" y2="46" />
            </svg>
          </div>
          <div className="signal-value signal-tool-value" role="status" aria-live="polite">
            <i aria-hidden="true" />{toolLabel}
          </div>
        </div>
        <SignalLane
          className="signal-endpoint"
          code="EOT"
          label="Endpointing detection"
          compactLabel="Endpoint"
          detail="Local end-of-turn estimate"
          value={current.endpoint}
          variant="confidence"
          fillPath={endpointArea}
          linePath={endpointPath}
        />
      </div>

      <div className="signal-time-axis" aria-hidden="true">
        <span>−10s</span>
        <i><b /><b /><b /><b /><b /></i>
        <span>Live</span>
      </div>
    </section>
  );
}
