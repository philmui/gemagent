import { describe, expect, it } from "vitest";

import {
  appendSignalSample,
  EMPTY_ENDPOINT_STATE,
  endpointEventState,
  nextEndpointState,
  signalAreaPath,
  signalEnvelopePath,
  signalLinePath,
  type SignalSample,
} from "../src/lib/signal-timeline";

const emptySample: SignalSample = { user: 0, agent: 0, endpoint: 0, toolMask: 0 };

describe("live signal timeline", () => {
  it("keeps a fixed rolling window", () => {
    let samples: SignalSample[] = [];
    for (let index = 0; index < 8; index += 1) {
      samples = appendSignalSample(samples, { ...emptySample, user: index / 10 }, 5);
    }
    expect(samples).toHaveLength(5);
    expect(samples[0]?.user).toBe(0.3);
    expect(samples[4]?.user).toBe(0.7);
  });

  it("raises endpoint strength through silence and confirms provider end events", () => {
    const speaking = nextEndpointState(EMPTY_ENDPOINT_STATE, 0.4, "user-speaking", 80);
    const pausing = nextEndpointState(speaking, 0, "user-speaking", 425);
    const confirmed = endpointEventState(pausing, "speech-end");

    expect(speaking.strength).toBe(0);
    expect(pausing.strength).toBeCloseTo(0.5);
    expect(confirmed).toMatchObject({ speechActive: false, strength: 1 });
  });

  it("creates a bounded SVG path and clamps invalid samples", () => {
    const path = signalLinePath([-1, 0.5, Number.NaN, 2], 30, 20, 2);
    expect(path).toBe("M0.00 18.00 L10.00 10.00 L20.00 18.00 L30.00 2.00");
  });

  it("creates closed confidence areas and symmetric audio envelopes", () => {
    expect(signalAreaPath([0, 1], 20, 20, 2)).toBe(
      "M0.00 18.00 L20.00 2.00 L20.00 18.00 L0.00 18.00 Z",
    );
    expect(signalEnvelopePath([0, 1], 20, 20, 2)).toBe(
      "M0.00 10.00 L20.00 2.00 L20.00 18.00 L0.00 10.00 Z",
    );
  });
});
