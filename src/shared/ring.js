// Lock-free rings over shared memory: one producer, one consumer each. See docs/protocol.md.
import {
  COMMAND_RING_MAGIC, OP_PAD, RECORD_HEADER_BYTES,
  RING_CAP_W, RING_FRAMES_DONE_W, RING_FRAMES_SUBMITTED_W, RING_HEADER_WORDS, RING_MAGIC_W, RING_READ_W, RING_WRITE_W,
  RECORD_RING_MAGIC, RR_CAP_W, RR_DROPPED_W, RR_HEADER_WORDS, RR_MAGIC_W, RR_READ_W, RR_RECORD_WORDS_W, RR_WRITE_W,
  AUDIO_RING_MAGIC, AU_CAP_W, AU_CHANNELS_W, AU_HEADER_WORDS, AU_MAGIC_W, AU_PEAK_W, AU_RATE_W, AU_READ_W, AU_UNDERRUNS_W, AU_WRITE_W,
  audioRingBytes, commandRingBytes, isPowerOfTwo, recordRingBytes,
} from './layout.js';

const align8 = (n) => (n + 7) & ~7;

// Variable-size records: the engine's render thread writes commands, the GPU worker executes them.
export class CommandRing {
  static bytes(cap) {
    return commandRingBytes(cap);
  }

  static init(buffer, byteOffset, cap) {
    if (!isPowerOfTwo(cap) || cap < 256) throw new RangeError('command ring capacity must be a power of two, at least 256');
    if (byteOffset % 8) throw new RangeError('command ring must be 8-byte aligned');
    const h = new Int32Array(buffer, byteOffset, RING_HEADER_WORDS);
    h.fill(0);
    h[RING_CAP_W] = cap;
    Atomics.store(h, RING_MAGIC_W, COMMAND_RING_MAGIC);
    return new CommandRing(buffer, byteOffset);
  }

  constructor(buffer, byteOffset) {
    this.h = new Int32Array(buffer, byteOffset, RING_HEADER_WORDS);
    if (Atomics.load(this.h, RING_MAGIC_W) !== COMMAND_RING_MAGIC) throw new Error('no command ring at offset ' + byteOffset);
    this.cap = this.h[RING_CAP_W];
    this.data = byteOffset + RING_HEADER_WORDS * 4;  // byte offset of the record area in the buffer
    this.setBuffer(buffer);
    this.pending = -1;
  }

  // Views over the whole buffer: payloads are addressed by absolute byte offset. Call again after a wasm memory grew.
  setBuffer(buffer) {
    this.buffer = buffer;
    this.dv = new DataView(buffer);
    this.u8 = new Uint8Array(buffer);
  }

  // Producer: reserves a record and returns the byte offset of its payload. While the ring is full it waits for the
  // consumer (Atomics.wait: not allowed on a page's main thread) unless `wait` is false, then it returns -1.
  reserve(op, payloadBytes, wait = true) {
    if (this.pending >= 0) throw new Error('commit() the previous record first');
    const need = align8(RECORD_HEADER_BYTES + payloadBytes);
    if (need > this.cap / 2) throw new RangeError(`a ${payloadBytes}-byte record does not fit a ${this.cap}-byte ring`);
    const h = this.h, mask = this.cap - 1;
    let w = Atomics.load(h, RING_WRITE_W) >>> 0;
    for (;;) {
      const r = Atomics.load(h, RING_READ_W) >>> 0;
      const tail = this.cap - (w & mask);
      const total = tail < need ? tail + need : need;
      if (((w - r) >>> 0) + total <= this.cap) {
        if (tail < need) {
          const at = this.data + (w & mask);
          this.dv.setUint32(at, OP_PAD, true);
          this.dv.setUint32(at + 4, tail - RECORD_HEADER_BYTES, true);
          w = (w + tail) >>> 0;
        }
        const at = this.data + (w & mask);
        this.dv.setUint32(at, op, true);
        this.dv.setUint32(at + 4, payloadBytes, true);
        this.pending = (w + need) >>> 0;
        return at + RECORD_HEADER_BYTES;
      }
      if (!wait) return -1;
      Atomics.wait(h, RING_READ_W, r | 0, 1000);
    }
  }

  // Producer: publishes the reserved record.
  commit() {
    if (this.pending < 0) throw new Error('nothing reserved');
    Atomics.store(this.h, RING_WRITE_W, this.pending | 0);
    Atomics.notify(this.h, RING_WRITE_W);
    this.pending = -1;
  }

  // Producer: a record with no payload.
  push(op) {
    this.reserve(op, 0);
    this.commit();
  }

  // Consumer: calls fn(op, payloadOffset, payloadBytes) for each committed record, in order. fn returning false stops
  // after that record. The space is released once fn has returned, so payloads can be read in place.
  drain(fn) {
    const h = this.h, mask = this.cap - 1;
    let r = Atomics.load(h, RING_READ_W) >>> 0, n = 0;
    const w = Atomics.load(h, RING_WRITE_W) >>> 0;
    while (r !== w) {
      const at = this.data + (r & mask);
      const op = this.dv.getUint32(at, true), len = this.dv.getUint32(at + 4, true);
      r = (r + align8(RECORD_HEADER_BYTES + len)) >>> 0;
      if (op === OP_PAD) continue;
      n++;
      if (fn(op, at + RECORD_HEADER_BYTES, len) === false) break;
    }
    Atomics.store(h, RING_READ_W, r | 0);
    Atomics.notify(h, RING_READ_W);
    return n;
  }

  // Consumer: true if records are waiting.
  pendingRecords() {
    return Atomics.load(this.h, RING_WRITE_W) !== Atomics.load(this.h, RING_READ_W);
  }

  writeIndex() {
    return Atomics.load(this.h, RING_WRITE_W);
  }

  // Frame accounting: the producer counts frames it ended, the consumer frames it finished.
  framesSubmitted() {
    return Atomics.load(this.h, RING_FRAMES_SUBMITTED_W) >>> 0;
  }

  framesDone() {
    return Atomics.load(this.h, RING_FRAMES_DONE_W) >>> 0;
  }

  markSubmitted() {
    Atomics.add(this.h, RING_FRAMES_SUBMITTED_W, 1);
  }

  markDone() {
    Atomics.add(this.h, RING_FRAMES_DONE_W, 1);
    Atomics.notify(this.h, RING_FRAMES_DONE_W);
  }

  // Producer: waits until fewer than `max` frames are queued or being drawn.
  waitFramesInFlight(max) {
    for (;;) {
      const done = Atomics.load(this.h, RING_FRAMES_DONE_W);
      if (((this.framesSubmitted() - (done >>> 0)) >>> 0) < max) return;
      Atomics.wait(this.h, RING_FRAMES_DONE_W, done, 1000);
    }
  }
}

// Fixed-size records of `recordWords` 32-bit words: input events, work queues between engine threads.
export class RecordRing {
  static bytes(cap, recordWords) {
    return recordRingBytes(cap, recordWords);
  }

  static init(buffer, byteOffset, cap, recordWords) {
    if (!isPowerOfTwo(cap)) throw new RangeError('record ring capacity must be a power of two');
    if (byteOffset % 8) throw new RangeError('record ring must be 8-byte aligned');
    const h = new Int32Array(buffer, byteOffset, RR_HEADER_WORDS);
    h.fill(0);
    h[RR_CAP_W] = cap;
    h[RR_RECORD_WORDS_W] = recordWords;
    Atomics.store(h, RR_MAGIC_W, RECORD_RING_MAGIC);
    return new RecordRing(buffer, byteOffset);
  }

  constructor(buffer, byteOffset) {
    this.h = new Int32Array(buffer, byteOffset, RR_HEADER_WORDS);
    if (Atomics.load(this.h, RR_MAGIC_W) !== RECORD_RING_MAGIC) throw new Error('no record ring at offset ' + byteOffset);
    this.cap = this.h[RR_CAP_W];
    this.rw = this.h[RR_RECORD_WORDS_W];
    const at = byteOffset + RR_HEADER_WORDS * 4;
    // i32 and f32 alias the same records: a record is read as integers or floats word by word.
    this.i32 = new Int32Array(buffer, at, this.cap * this.rw);
    this.f32 = new Float32Array(buffer, at, this.cap * this.rw);
  }

  // Producer: index (into i32/f32) of the next free record, or -1 when full (the record is counted as dropped).
  reserve() {
    const w = Atomics.load(this.h, RR_WRITE_W) >>> 0, r = Atomics.load(this.h, RR_READ_W) >>> 0;
    if (((w - r) >>> 0) >= this.cap) {
      Atomics.add(this.h, RR_DROPPED_W, 1);
      return -1;
    }
    return (w & (this.cap - 1)) * this.rw;
  }

  // Producer: like reserve(), but waits for room (Atomics.wait: not on a page's main thread).
  reserveWait() {
    for (;;) {
      const w = Atomics.load(this.h, RR_WRITE_W) >>> 0, r = Atomics.load(this.h, RR_READ_W);
      if (((w - (r >>> 0)) >>> 0) < this.cap) return (w & (this.cap - 1)) * this.rw;
      Atomics.wait(this.h, RR_READ_W, r, 1000);
    }
  }

  commit() {
    Atomics.add(this.h, RR_WRITE_W, 1);
    Atomics.notify(this.h, RR_WRITE_W);
  }

  // Consumer: index of the oldest unread record, or -1 when empty.
  peek() {
    const w = Atomics.load(this.h, RR_WRITE_W), r = Atomics.load(this.h, RR_READ_W);
    if (w === r) return -1;
    return ((r >>> 0) & (this.cap - 1)) * this.rw;
  }

  // Consumer: releases the record returned by peek().
  release() {
    Atomics.add(this.h, RR_READ_W, 1);
    Atomics.notify(this.h, RR_READ_W);
  }

  // Consumer: waits until a record is available or the timeout passes; returns peek().
  peekWait(timeoutMs = Infinity) {
    for (;;) {
      const w = Atomics.load(this.h, RR_WRITE_W), r = Atomics.load(this.h, RR_READ_W);
      if (w !== r) return ((r >>> 0) & (this.cap - 1)) * this.rw;
      // waits only while WRITE still has the value just compared: a commit in between returns at once
      if (Atomics.wait(this.h, RR_WRITE_W, w, timeoutMs) === 'timed-out') return this.peek();
    }
  }

  size() {
    return ((Atomics.load(this.h, RR_WRITE_W) - Atomics.load(this.h, RR_READ_W)) >>> 0);
  }

  dropped() {
    return Atomics.load(this.h, RR_DROPPED_W) >>> 0;
  }
}

// Interleaved float32 PCM: the engine writes, an AudioWorklet (src/audio-worklet.js) plays. One producer, one consumer.
export class AudioRing {
  static bytes(cap, channels) {
    return audioRingBytes(cap, channels);
  }

  static init(buffer, byteOffset, cap, channels, rate) {
    if (!isPowerOfTwo(cap)) throw new RangeError('audio ring capacity must be a power of two');
    if (byteOffset % 8) throw new RangeError('audio ring must be 8-byte aligned');
    const h = new Int32Array(buffer, byteOffset, AU_HEADER_WORDS);
    h.fill(0);
    h[AU_CAP_W] = cap;
    h[AU_CHANNELS_W] = channels;
    h[AU_RATE_W] = rate;
    Atomics.store(h, AU_MAGIC_W, AUDIO_RING_MAGIC);
    return new AudioRing(buffer, byteOffset);
  }

  constructor(buffer, byteOffset) {
    this.h = new Int32Array(buffer, byteOffset, AU_HEADER_WORDS);
    if (Atomics.load(this.h, AU_MAGIC_W) !== AUDIO_RING_MAGIC) throw new Error('no audio ring at offset ' + byteOffset);
    this.cap = this.h[AU_CAP_W];
    this.channels = this.h[AU_CHANNELS_W];
    this.rate = this.h[AU_RATE_W];
    this.data = new Float32Array(buffer, byteOffset + AU_HEADER_WORDS * 4, this.cap * this.channels);
  }

  // Frames written and not played yet.
  queued() {
    return (Atomics.load(this.h, AU_WRITE_W) - Atomics.load(this.h, AU_READ_W)) >>> 0;
  }

  // Producer: writes up to frames.length / channels interleaved frames; never blocks. Returns the frames written.
  write(frames) {
    const ch = this.channels, mask = this.cap - 1;
    const w = Atomics.load(this.h, AU_WRITE_W) >>> 0;
    const n = Math.min(Math.floor(frames.length / ch), this.cap - this.queued());
    for (let i = 0; i < n; i++) {
      const at = ((w + i) & mask) * ch;
      for (let c = 0; c < ch; c++) this.data[at + c] = frames[i * ch + c];
    }
    Atomics.store(this.h, AU_WRITE_W, (w + n) | 0);
    return n;
  }

  // Consumer: copies up to `n` frames into per-channel arrays (planar, as AudioWorklet outputs are). Returns frames read.
  readPlanar(outputs, n) {
    const ch = this.channels, mask = this.cap - 1;
    const r = Atomics.load(this.h, AU_READ_W) >>> 0;
    const k = Math.min(n, this.queued());
    let peak = 0;
    for (let i = 0; i < k; i++) {
      const at = ((r + i) & mask) * ch;
      for (let c = 0; c < outputs.length; c++) {
        const x = this.data[at + Math.min(c, ch - 1)];
        outputs[c][i] = x;
        if (x > peak) peak = x;
        else if (-x > peak) peak = -x;
      }
    }
    if (peak) {
      // a running maximum (JavaScript has no Atomics.max): stats() swaps it back to 0 concurrently
      const v = Math.round(peak * 1e6);
      for (let cur = Atomics.load(this.h, AU_PEAK_W); v > cur;) {
        const seen = Atomics.compareExchange(this.h, AU_PEAK_W, cur, v);
        if (seen === cur) break;
        cur = seen;
      }
    }
    for (let c = 0; c < outputs.length; c++) outputs[c].fill(0, k, n);
    Atomics.store(this.h, AU_READ_W, (r + k) | 0);
    if (k < n && Atomics.load(this.h, AU_WRITE_W) !== 0) Atomics.add(this.h, AU_UNDERRUNS_W, 1);
    return k;
  }

  stats() {
    return {
      rate: this.rate, channels: this.channels,
      written: Atomics.load(this.h, AU_WRITE_W) >>> 0, played: Atomics.load(this.h, AU_READ_W) >>> 0,
      underruns: Atomics.load(this.h, AU_UNDERRUNS_W) >>> 0,
      peak: Atomics.exchange(this.h, AU_PEAK_W, 0) / 1e6,   // played, since the previous stats() call
      queuedPeak: this.#queuedPeak(),                        // written and not played yet
    };
  }

  #queuedPeak() {
    const ch = this.channels, mask = this.cap - 1, r = Atomics.load(this.h, AU_READ_W) >>> 0;
    let peak = 0;
    for (let i = 0, n = this.queued(); i < n; i++) {
      for (let c = 0, at = ((r + i) & mask) * ch; c < ch; c++) peak = Math.max(peak, Math.abs(this.data[at + c]));
    }
    return peak;
  }
}
