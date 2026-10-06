// The AudioWorklet that plays an engine's audio ring (AudioRing in src/shared/ring.js; rp_audio_* in native/rangeplay.h).
// host.js loads it once the page has had a user gesture, as browsers require before audio may start.
// processorOptions: { memory, ringOffset }  memory: SharedArrayBuffer or a shared WebAssembly.Memory

import { AudioRing } from './shared/ring.js';

class RangeplayAudio extends AudioWorkletProcessor {
  constructor({ processorOptions: { memory, ringOffset } }) {
    super();
    this.ring = new AudioRing(memory.buffer ?? memory, ringOffset);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (out?.length) this.ring.readPlanar(out, out[0].length);
    return true;
  }
}

registerProcessor('rangeplay-audio', RangeplayAudio);
