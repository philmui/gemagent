import { describe, expect, it } from "vitest";

import { formatTtfaSeconds, TtfaTracker } from "../src/lib/ttfa";

describe("TTFA turn tracking", () => {
  it("pairs end-of-turn and first audio when the caption arrives first", () => {
    const tracker = new TtfaTracker();
    tracker.beginTurn(3, 1_000);

    expect(tracker.observeAssistantItem(3, "assistant-1")).toBeNull();
    expect(tracker.observeAudioStart(3, 2_234)).toEqual({
      itemId: "assistant-1",
      milliseconds: 1_234,
    });
    expect(tracker.observeAudioStart(3, 2_500)).toBeNull();
  });

  it("pairs the same turn when audio arrives before its caption", () => {
    const tracker = new TtfaTracker();
    tracker.beginTurn(3, 4_000);

    expect(tracker.observeAudioStart(3, 4_500)).toBeNull();
    expect(tracker.observeAssistantItem(3, "assistant-2")).toEqual({
      itemId: "assistant-2",
      milliseconds: 500,
    });
    // Re-expose the same immutable measurement so a caption recreated after
    // clearing the transcript can still receive it.
    expect(tracker.observeAssistantItem(3, "assistant-2")).toEqual({
      itemId: "assistant-2",
      milliseconds: 500,
    });
  });

  it("ignores stale epochs, impossible timestamps, and old caption updates", () => {
    const tracker = new TtfaTracker();
    expect(tracker.observeAssistantItem(3, "old-answer")).toBeNull();
    tracker.beginTurn(4, 2_000);

    expect(tracker.observeAssistantItem(4, "old-answer")).toBeNull();
    expect(tracker.observeAudioStart(3, 2_500)).toBeNull();
    expect(tracker.observeAudioStart(4, 1_999)).toBeNull();
    expect(tracker.observeAssistantItem(4, "new-answer")).toBeNull();
    expect(tracker.observeAudioStart(4, 2_750)).toEqual({
      itemId: "new-answer",
      milliseconds: 750,
    });
  });

  it("cancels an unanswered turn and resets session item history", () => {
    const tracker = new TtfaTracker();
    tracker.beginTurn(5, 1_000);
    tracker.observeAssistantItem(5, "cancelled");
    tracker.cancelUnmeasured();
    expect(tracker.observeAudioStart(5, 1_500)).toBeNull();

    tracker.reset();
    tracker.beginTurn(6, 2_000);
    expect(tracker.observeAssistantItem(6, "cancelled")).toBeNull();
    expect(tracker.observeAudioStart(6, 2_250)).toEqual({
      itemId: "cancelled",
      milliseconds: 250,
    });
  });

  it("keeps an audio-first turn while the next user utterance begins", () => {
    const tracker = new TtfaTracker();
    tracker.beginTurn(7, 1_000);
    expect(tracker.observeAudioStart(7, 1_400)).toBeNull();

    // A second utterance can begin before the independently streamed caption
    // for the first response arrives. Both response measurements must survive.
    tracker.cancelUnmeasured();
    tracker.beginTurn(7, 2_000);
    expect(tracker.observeAssistantItem(7, "assistant-1")).toEqual({
      itemId: "assistant-1",
      milliseconds: 400,
    });
    expect(tracker.observeAssistantItem(7, "assistant-2")).toBeNull();
    expect(tracker.observeAudioStart(7, 2_650)).toEqual({
      itemId: "assistant-2",
      milliseconds: 650,
    });
  });

  it("measures a continuation reply from the end of the previous assistant audio", () => {
    const tracker = new TtfaTracker();
    tracker.beginTurn(8, 1_000);
    tracker.observeAssistantItem(8, "filler");
    expect(tracker.observeAudioStart(8, 1_450)).toEqual({
      itemId: "filler",
      milliseconds: 450,
    });

    // The prior audio ends at 2.1s. A tool-backed complete reply begins at
    // 2.9s without another user utterance, so its TTFA is 800ms.
    tracker.beginTurn(8, 2_100);
    tracker.observeAssistantItem(8, "complete-reply");
    expect(tracker.observeAudioStart(8, 2_900)).toEqual({
      itemId: "complete-reply",
      milliseconds: 800,
    });
  });
});

describe("TTFA display formatting", () => {
  it("formats seconds with exactly two decimal places", () => {
    expect(formatTtfaSeconds(0)).toBe("0.00");
    expect(formatTtfaSeconds(500)).toBe("0.50");
    expect(formatTtfaSeconds(846)).toBe("0.85");
    expect(formatTtfaSeconds(1_999)).toBe("2.00");
  });

  it("rejects missing and invalid durations", () => {
    expect(formatTtfaSeconds(undefined)).toBeNull();
    expect(formatTtfaSeconds(-1)).toBeNull();
    expect(formatTtfaSeconds(Number.NaN)).toBeNull();
    expect(formatTtfaSeconds(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
