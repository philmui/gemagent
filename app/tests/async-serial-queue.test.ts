import { describe, expect, it } from "vitest";

import { AsyncSerialQueue } from "../src/lib/async-serial-queue";

describe("AsyncSerialQueue", () => {
  it("never overlaps lifecycle work and preserves issue order", async () => {
    const queue = new AsyncSerialQueue();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = queue.run(async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await firstStarted;
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues after a rejected task", async () => {
    const queue = new AsyncSerialQueue();
    await expect(
      queue.run(async () => {
        throw new Error("expected");
      }),
    ).rejects.toThrow("expected");
    await expect(queue.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
