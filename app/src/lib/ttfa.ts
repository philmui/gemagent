export interface TtfaMeasurement {
  itemId: string;
  milliseconds: number;
}

interface PendingTurn {
  epoch: number;
  startedAtMs: number;
  assistantItemId?: string;
  elapsedMs?: number;
}

/**
 * Pairs provider VAD and audio events with a transcript item. Audio and
 * captions arrive independently, so either may be observed first.
 */
export class TtfaTracker {
  private pending: PendingTurn[] = [];
  private completed = new Map<string, number>();
  private seenAssistantItemIds = new Set<string>();

  beginTurn(epoch: number, atMs: number): void {
    if (!Number.isFinite(atMs)) return;
    this.pending.push({ epoch, startedAtMs: atMs });
  }

  observeAssistantItem(epoch: number, itemId: string): TtfaMeasurement | null {
    const completedMilliseconds = this.completed.get(itemId);
    if (completedMilliseconds !== undefined) {
      return { itemId, milliseconds: completedMilliseconds };
    }
    const alreadySeen = this.seenAssistantItemIds.has(itemId);
    this.seenAssistantItemIds.add(itemId);

    const existing = this.pending.find(
      (turn) => turn.epoch === epoch && turn.assistantItemId === itemId,
    );
    if (existing) return this.takeMeasurement(existing);
    // A late update to an older response must not claim a newer turn.
    if (alreadySeen) return null;
    const pending = this.pending.find(
      (turn) => turn.epoch === epoch && turn.assistantItemId === undefined,
    );
    if (!pending) return null;
    pending.assistantItemId = itemId;
    return this.takeMeasurement(pending);
  }

  observeAudioStart(epoch: number, atMs: number): TtfaMeasurement | null {
    const pending = this.pending.find(
      (turn) =>
        turn.epoch === epoch &&
        turn.elapsedMs === undefined &&
        Number.isFinite(atMs) &&
        atMs >= turn.startedAtMs,
    );
    if (!pending) return null;
    pending.elapsedMs = atMs - pending.startedAtMs;
    return this.takeMeasurement(pending);
  }

  cancelUnmeasured(): void {
    // Keep audio-first turns until their independently streamed caption arrives.
    // This matters when the user starts a new utterance before the prior output
    // transcript has been delivered.
    this.pending = this.pending.filter((turn) => turn.elapsedMs !== undefined);
  }

  reset(): void {
    this.pending = [];
    this.completed.clear();
    this.seenAssistantItemIds.clear();
  }

  private takeMeasurement(pending: PendingTurn): TtfaMeasurement | null {
    if (!pending.assistantItemId || pending.elapsedMs === undefined) {
      return null;
    }
    return this.complete(pending);
  }

  private complete(pending: PendingTurn): TtfaMeasurement {
    const measurement = {
      itemId: pending.assistantItemId!,
      milliseconds: pending.elapsedMs!,
    };
    this.completed.set(measurement.itemId, measurement.milliseconds);
    this.pending = this.pending.filter((turn) => turn !== pending);
    return measurement;
  }
}

export function formatTtfaSeconds(milliseconds: number | undefined): string | null {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  return (milliseconds / 1_000).toFixed(2);
}
