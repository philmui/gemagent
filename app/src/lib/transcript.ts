import { appendTranscriptText } from "./audio";
import type { CaptionEvent, Provider, TranscriptItem } from "./types";

export interface CaptionContext {
  epoch: number;
  provider: Provider;
  model: string;
  sequence: number;
}

export function upsertCaption(
  items: TranscriptItem[],
  event: CaptionEvent,
  context: CaptionContext,
): TranscriptItem[] {
  const id = `${context.epoch}:${context.provider}:${event.role}:${event.itemId}`;
  const existingIndex = items.findIndex((item) => item.id === id);
  if (existingIndex < 0) {
    return [
      ...items,
      {
        id,
        epoch: context.epoch,
        provider: context.provider,
        model: context.model,
        role: event.role,
        text: event.text,
        status: event.final ? "final" : "partial",
        sequence: context.sequence,
      },
    ];
  }

  const existing = items[existingIndex];
  if (!existing) return items;
  const text =
    event.mode === "replace" ? event.text : appendTranscriptText(existing.text, event.text);
  if (text === existing.text && (!event.final || existing.status === "final")) return items;
  const next = [...items];
  next[existingIndex] = {
    ...existing,
    text,
    // An interruption is terminal. Late provider transcript events may improve
    // the text, but they must not relabel cancelled speech as completed.
    status:
      existing.status === "interrupted"
        ? "interrupted"
        : event.final
          ? "final"
          : existing.status,
  };
  return next;
}

export function finalizeEpoch(items: TranscriptItem[], epoch: number): TranscriptItem[] {
  const latestByRole = new Map<TranscriptItem["role"], string>();
  for (const item of items) {
    if (item.epoch === epoch && item.status === "partial" && item.role !== "system") {
      latestByRole.set(item.role, item.id);
    }
  }
  return items.map((item) =>
    latestByRole.get(item.role) === item.id ? { ...item, status: "final" } : item,
  );
}

export function interruptAssistant(
  items: TranscriptItem[],
  epoch: number,
  itemId?: string,
): TranscriptItem[] {
  const latest = items.findLast(
    (item) =>
      item.epoch === epoch &&
      item.role === "assistant" &&
      item.status !== "interrupted" &&
      (itemId
        ? item.id === `${epoch}:${item.provider}:assistant:${itemId}`
        : item.status === "partial"),
  );
  if (!latest) return items;
  return items.map((item) =>
    item.id === latest.id ? { ...item, status: "interrupted" } : item,
  );
}

export function interruptPartials(items: TranscriptItem[], epoch: number): TranscriptItem[] {
  return items.map((item) =>
    item.epoch === epoch && item.status === "partial"
      ? { ...item, status: "interrupted" }
      : item,
  );
}
