class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const configuredRate = options.processorOptions?.targetSampleRate;
    const configuredChunk = options.processorOptions?.chunkSamples;
    this.targetSampleRate = Number.isFinite(configuredRate) ? configuredRate : 16000;
    this.chunkSamples = Number.isFinite(configuredChunk) ? configuredChunk : 640;
    this.ratio = sampleRate / this.targetSampleRate;
    this.sourceSamples = [];
    this.readOffset = 0;
    this.outputChunk = new Float32Array(this.chunkSamples);
    this.outputOffset = 0;
    this.lastLevelAt = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === "stop") this.running = false;
    };
  }

  emitChunk() {
    const pcm = new ArrayBuffer(this.chunkSamples * 2);
    const view = new DataView(pcm);
    for (let index = 0; index < this.chunkSamples; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.outputChunk[index] || 0));
      const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(index * 2, value, true);
    }
    this.port.postMessage({ type: "chunk", buffer: pcm }, [pcm]);
    this.outputOffset = 0;
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    const channel = input?.[0];
    if (!channel?.length) return true;

    let sumSquares = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = channel[index] || 0;
      this.sourceSamples.push(sample);
      sumSquares += sample * sample;
    }

    while (this.readOffset + 1 < this.sourceSamples.length) {
      const lowerIndex = Math.floor(this.readOffset);
      const fraction = this.readOffset - lowerIndex;
      const lower = this.sourceSamples[lowerIndex] || 0;
      const upper = this.sourceSamples[lowerIndex + 1] || lower;
      this.outputChunk[this.outputOffset] = lower + (upper - lower) * fraction;
      this.outputOffset += 1;
      this.readOffset += this.ratio;
      if (this.outputOffset === this.chunkSamples) this.emitChunk();
    }

    // Keep one source sample for interpolation across AudioWorklet blocks. If
    // readOffset has stepped past this block, subtract only what splice can
    // actually remove or the fractional phase resets and the stream runs fast.
    const consumed = Math.min(
      Math.floor(this.readOffset),
      Math.max(0, this.sourceSamples.length - 1),
    );
    if (consumed > 0) {
      this.sourceSamples.splice(0, consumed);
      this.readOffset -= consumed;
    }

    if (currentTime - this.lastLevelAt >= 0.05) {
      const rms = Math.sqrt(sumSquares / channel.length);
      this.port.postMessage({ type: "level", value: Math.min(1, rms * 4.5) });
      this.lastLevelAt = currentTime;
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
