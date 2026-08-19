import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

interface WorkletMessage {
  type: string;
  buffer?: ArrayBuffer;
  value?: number;
}

interface RecorderProcessor {
  process(inputs: Float32Array[][]): boolean;
}

function runRecorder(sourceRate: number): WorkletMessage[] {
  const messages: WorkletMessage[] = [];
  let Processor: (new (options: object) => RecorderProcessor) | null = null;
  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null,
      postMessage: (message: WorkletMessage) => messages.push(message),
    };
  }
  const context = {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name: string, candidate: new (options: object) => RecorderProcessor) => {
      Processor = candidate;
    },
    sampleRate: sourceRate,
    currentTime: 0,
    ArrayBuffer,
    DataView,
    Float32Array,
    Math,
  };
  const source = readFileSync(new URL("../public/audio-recorder.worklet.js", import.meta.url), "utf8");
  runInNewContext(source, context);
  if (!Processor) throw new Error("The worklet did not register its processor.");
  const Recorder = Processor as new (options: object) => RecorderProcessor;
  const processor = new Recorder({
    processorOptions: { targetSampleRate: 16000, chunkSamples: 640 },
  });

  const durationSeconds = 1;
  const totalSamples = sourceRate * durationSeconds;
  for (let offset = 0; offset < totalSamples; offset += 128) {
    const length = Math.min(128, totalSamples - offset);
    const channel = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      channel[index] = Math.sin(((offset + index) / sourceRate) * Math.PI * 2 * 440) * 0.5;
    }
    context.currentTime = offset / sourceRate;
    processor.process([[channel]]);
  }
  return messages;
}

describe.each([44100, 48000])("AudioWorklet resampling at %i Hz", (sourceRate) => {
  it("emits 40 ms little-endian PCM16 chunks at 16 kHz", () => {
    const chunks = runRecorder(sourceRate).filter(
      (message): message is WorkletMessage & { buffer: ArrayBuffer } =>
        message.type === "chunk" && message.buffer instanceof ArrayBuffer,
    );
    expect(chunks).toHaveLength(25);
    expect(chunks.every((chunk) => chunk.buffer.byteLength === 640 * 2)).toBe(true);
    const first = new DataView(chunks[0]!.buffer);
    expect(Math.abs(first.getInt16(2, true))).toBeGreaterThan(500);
    expect(first.getInt16(2, false)).not.toBe(first.getInt16(2, true));
  });
});
