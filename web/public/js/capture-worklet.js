// AudioWorklet that forwards microphone samples to the main thread in blocks of ~1024 samples.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        this.block[this.fill++] = ch[i];
        if (this.fill === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(1024);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
