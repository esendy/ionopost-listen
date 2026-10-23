// worklet.js — copies the microphone input out of the audio thread in ~85 ms chunks.
//
// Each chunk carries the AudioContext frame number of its first sample, so the page can stamp
// it with wall-clock time and the worker can tell a continuous stream from one with a hole in it.
// It never writes to its output, so even where the page has to connect it onward (some browsers
// only run a node that reaches the speakers) all it can ever produce is silence.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.start = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      if (this.n === 0) this.start = currentFrame + i;
      const take = Math.min(ch.length - i, this.size - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take; i += take;
      if (this.n === this.size) {
        this.port.postMessage({ frame: this.start, data: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("tap", Tap);
