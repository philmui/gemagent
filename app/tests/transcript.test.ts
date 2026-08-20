import { describe, expect, it } from "vitest";

import {
  attachTtfa,
  finalizeEpoch,
  interruptAssistant,
  interruptPartials,
  upsertCaption,
} from "../src/lib/transcript";
import type { TranscriptItem } from "../src/lib/types";

const context = {
  epoch: 7,
  provider: "openai" as const,
  model: "gpt-realtime-2.1",
  sequence: 1,
};

describe("transcript reconciliation", () => {
  it("appends deltas and replaces them with one final transcript", () => {
    let items: TranscriptItem[] = [];
    items = upsertCaption(
      items,
      { role: "user", text: "Good", itemId: "item-1", mode: "append" },
      context,
    );
    items = upsertCaption(
      items,
      { role: "user", text: "morning", itemId: "item-1", mode: "append" },
      { ...context, sequence: 2 },
    );
    items = upsertCaption(
      items,
      {
        role: "user",
        text: "Good morning.",
        itemId: "item-1",
        mode: "replace",
        final: true,
      },
      { ...context, sequence: 3 },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "Good morning.", status: "final", epoch: 7 });
  });

  it("scopes identical provider item IDs to separate session epochs", () => {
    const first = upsertCaption(
      [],
      { role: "assistant", text: "First", itemId: "same", mode: "append" },
      context,
    );
    const second = upsertCaption(
      first,
      { role: "assistant", text: "Second", itemId: "same", mode: "append" },
      { ...context, epoch: 8, provider: "gemini", model: "gemini-live-2.5-flash-native-audio" },
    );
    expect(second).toHaveLength(2);
    expect(second.map((item) => item.text)).toEqual(["First", "Second"]);
  });

  it("finalizes a completed turn and marks interrupted work explicitly", () => {
    const items: TranscriptItem[] = [
      {
        id: "user",
        epoch: 7,
        provider: "openai",
        model: "gpt-realtime-2.1",
        role: "user",
        text: "Question",
        status: "partial",
        sequence: 1,
      },
      {
        id: "assistant",
        epoch: 7,
        provider: "openai",
        model: "gpt-realtime-2.1",
        role: "assistant",
        text: "Partial answer",
        status: "partial",
        sequence: 2,
      },
    ];
    expect(finalizeEpoch(items, 7).every((item) => item.status === "final")).toBe(true);
    expect(interruptAssistant(items, 7).map((item) => item.status)).toEqual([
      "partial",
      "interrupted",
    ]);
    expect(interruptPartials(items, 7).every((item) => item.status === "interrupted")).toBe(
      true,
    );
  });

  it("keeps an interrupted answer interrupted when a late final caption arrives", () => {
    let items = upsertCaption(
      [],
      { role: "assistant", text: "Partial", itemId: "answer", mode: "replace" },
      context,
    );
    items = interruptAssistant(items, context.epoch);
    items = upsertCaption(
      items,
      {
        role: "assistant",
        text: "Partial answer",
        itemId: "answer",
        mode: "replace",
        final: true,
      },
      { ...context, sequence: 2 },
    );

    expect(items[0]).toMatchObject({ text: "Partial answer", status: "interrupted" });
  });

  it("attaches TTFA only to its assistant response and preserves it through updates", () => {
    let items = upsertCaption(
      [],
      { role: "assistant", text: "Starting", itemId: "answer", mode: "replace" },
      context,
    );
    const assistantId = items[0]!.id;
    items = attachTtfa(items, assistantId, 846.4);
    items = upsertCaption(
      items,
      {
        role: "assistant",
        text: "Complete answer",
        itemId: "answer",
        mode: "replace",
        final: true,
      },
      { ...context, sequence: 2 },
    );

    expect(items[0]).toMatchObject({ text: "Complete answer", ttfaMs: 846.4 });
    expect(attachTtfa(items, assistantId, 999)).toBe(items);

    const user = upsertCaption(
      [],
      { role: "user", text: "Question", itemId: "question", mode: "replace" },
      context,
    );
    expect(attachTtfa(user, user[0]!.id, 500)).toBe(user);
  });

  it("marks a flushed final caption interrupted when the wire event follows it", () => {
    let items = upsertCaption(
      [],
      {
        role: "assistant",
        text: "Cancelled answer",
        itemId: "answer",
        mode: "replace",
        final: true,
      },
      context,
    );
    items = interruptAssistant(items, context.epoch, "answer");

    expect(items[0]).toMatchObject({ text: "Cancelled answer", status: "interrupted" });
  });

  it("does not corrupt a prior final turn when a new item is interrupted before captions", () => {
    const items = upsertCaption(
      [],
      {
        role: "assistant",
        text: "Previous complete answer",
        itemId: "previous-answer",
        mode: "replace",
        final: true,
      },
      context,
    );

    expect(interruptAssistant(items, context.epoch, "new-answer")).toEqual(items);
  });
});
