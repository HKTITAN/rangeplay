// Engine side, for engines written in JavaScript (wasm engines use native/rangeplay.h; the protocol is the same).
//
// In the engine worker:
//   const rt = await connect({ heapBytes: 64 << 20 });
//   const id = rt.files.id('world/region_0_0.bin');
//   const n = rt.io.readSync(id, 0, 4096, rt.heap.alloc(4096));   // blocks this thread until the bytes are in
//
// Any other thread of the engine (a worker it starts) gets its own client: IoClient.fromShared(rt.shared()).

import {
  ERR_BADF, ERR_INVAL, ERR_IO, HINT_FILE, HINT_LEN_FLAGS, HINT_LEN_MASK, HINT_OFF_HI, HINT_OFF_LO, HINT_SEQ, HINT_SPECULATIVE,
  INPUT_WORDS, IO_DOORBELL_W, IO_HEADER_WORDS, IO_HINT_CAP_W, IO_HINT_HEAD_W, IO_MAGIC, IO_MAGIC_W, IO_READY_W,
  IO_SLOT_CAP_W, IO_SLOT_NEXT_W, OP_FRAME_END, SLOT_DONE, SLOT_DST_HI, SLOT_DST_LO, SLOT_FILE, SLOT_FLAGS, SLOT_IDLE,
  SLOT_LEN, SLOT_OFF_HI, SLOT_OFF_LO, SLOT_REQUESTED, SLOT_RESULT, SLOT_STATE, alignUp, initIoControl, ioControlBytes,
  ioHintWord, ioSlotWord,
} from './shared/layout.js';
import { CommandRing, RecordRing } from './shared/ring.js';
import { FileTable } from './shared/manifest.js';

export class IoError extends Error {
  constructor(code, what) {
    super(what + ': ' + (code === ERR_BADF ? 'bad file id' : code === ERR_INVAL ? 'invalid request' : code === ERR_IO ? 'I/O error' : 'error ' + code));
    this.code = code;
  }
}

export class IoClient {
  static fromShared({ buffer, ioOffset }) {
    return new IoClient(buffer, ioOffset);
  }

  constructor(buffer, controlOffset) {
    const head = new Int32Array(buffer, controlOffset, IO_HEADER_WORDS);
    if (Atomics.load(head, IO_MAGIC_W) !== IO_MAGIC) throw new Error('no IO control block at ' + controlOffset);
    this.slotCap = head[IO_SLOT_CAP_W];
    this.hintCap = head[IO_HINT_CAP_W];
    this.a = new Int32Array(buffer, controlOffset, ioControlBytes(this.slotCap, this.hintCap) / 4);
    this.slotWord = -1;
  }

  // Each thread uses one slot, claimed on its first read.
  #slot() {
    if (this.slotWord < 0) {
      const s = Atomics.add(this.a, IO_SLOT_NEXT_W, 1);
      if (s >= this.slotCap) throw new Error('out of IO slots: raise ioSlots (' + this.slotCap + ')');
      this.slotWord = ioSlotWord(s);
    }
    return this.slotWord;
  }

  #request(file, offset, length, dst, flags) {
    if (!(length >= 0 && length <= 0x7fffffff)) throw new RangeError('read length out of range: ' + length);
    const a = this.a, s = this.#slot();
    a[s + SLOT_FILE] = file;
    a[s + SLOT_OFF_LO] = offset >>> 0;
    a[s + SLOT_OFF_HI] = Math.floor(offset / 4294967296);
    a[s + SLOT_DST_LO] = dst >>> 0;
    a[s + SLOT_DST_HI] = Math.floor(dst / 4294967296);
    a[s + SLOT_LEN] = length;
    a[s + SLOT_FLAGS] = flags;
    a[s + SLOT_RESULT] = 0;
    Atomics.store(a, s + SLOT_STATE, SLOT_REQUESTED);
    Atomics.add(a, IO_DOORBELL_W, 1);
    Atomics.notify(a, IO_DOORBELL_W);
    return s;
  }

  #finish(s, what) {
    const res = this.a[s + SLOT_RESULT];
    Atomics.store(this.a, s + SLOT_STATE, SLOT_IDLE);
    if (res < 0) throw new IoError(res, what);
    return res;
  }

  // Reads `length` bytes of file `file` from `offset` into the shared memory at byte address `dst`. Blocks the
  // calling thread (Atomics.wait: workers only) until the bytes are there. Returns the bytes read (short at the end of
  // the file); throws IoError on failure.
  readSync(file, offset, length, dst, flags = 0) {
    const s = this.#request(file, offset, length, dst, flags);
    for (;;) {
      const st = Atomics.load(this.a, s + SLOT_STATE);
      if (st === SLOT_DONE) break;
      Atomics.wait(this.a, s + SLOT_STATE, st);
    }
    return this.#finish(s, 'read of file ' + file);
  }

  // The same without blocking the thread (Atomics.waitAsync). One read at a time per client.
  async read(file, offset, length, dst, flags = 0) {
    const s = this.#request(file, offset, length, dst, flags);
    for (;;) {
      const st = Atomics.load(this.a, s + SLOT_STATE);
      if (st === SLOT_DONE) break;
      if (typeof Atomics.waitAsync === 'function') {
        const r = Atomics.waitAsync(this.a, s + SLOT_STATE, st);
        if (r.async) await r.value;
      } else {
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    return this.#finish(s, 'read of file ' + file);
  }

  // Announces a read the engine will make soon, so the IO worker can fetch it now. speculative: might not be read at
  // all (fetched at low priority, after announced reads). Never blocks; old hints are overwritten if the ring is full.
  hint(file, offset, length, speculative = false) {
    const len = Math.min(Math.floor(length), HINT_LEN_MASK);
    if (!this.hintCap || !(len > 0)) return;
    const a = this.a;
    const i = Atomics.add(a, IO_HINT_HEAD_W, 1);
    const e = ioHintWord(this.slotCap, (i >>> 0) & (this.hintCap - 1));
    Atomics.store(a, e + HINT_SEQ, ~(i + 1));   // being written
    a[e + HINT_FILE] = file;
    a[e + HINT_OFF_LO] = offset >>> 0;
    a[e + HINT_OFF_HI] = Math.floor(offset / 4294967296);
    a[e + HINT_LEN_FLAGS] = len | (speculative ? HINT_SPECULATIVE : 0);
    Atomics.store(a, e + HINT_SEQ, (i + 1) | 0);   // published
    Atomics.add(a, IO_DOORBELL_W, 1);
    Atomics.notify(a, IO_DOORBELL_W);
  }

  // Waits until the IO worker is serving (reads made before that are queued, so this is optional).
  waitReady(timeoutMs = Infinity) {
    return Atomics.load(this.a, IO_READY_W) === 1 || Atomics.wait(this.a, IO_READY_W, 0, timeoutMs) !== 'timed-out';
  }
}

// The render thread's side of the command ring.
export class GpuClient {
  constructor(buffer, ringOffset, { maxFramesInFlight = 2 } = {}) {
    this.ring = new CommandRing(buffer, ringOffset);
    this.maxFramesInFlight = maxFramesInFlight;
    this.dv = this.ring.dv;
    this.u8 = this.ring.u8;
  }

  // Starts a command: returns the byte offset of its payload (write it through this.dv / this.u8, then commit()).
  begin(op, payloadBytes) {
    return this.ring.reserve(op, payloadBytes);
  }

  commit() {
    this.ring.commit();
  }

  // Waits while maxFramesInFlight frames are still queued or drawing, so the engine runs at the display's pace.
  beginFrame() {
    this.ring.waitFramesInFlight(this.maxFramesInFlight);
  }

  endFrame() {
    this.ring.push(OP_FRAME_END);
    this.ring.markSubmitted();
  }

  framesDone() {
    return this.ring.framesDone();
  }
}

// The engine's side of the input ring: poll((type, code, x, y, dx, dy, mods, time) => ...) once per frame.
export class InputClient {
  constructor(buffer, ringOffset) {
    this.ring = new RecordRing(buffer, ringOffset);
  }

  poll(fn) {
    const { ring } = this;
    let n = 0;
    for (let i = ring.peek(); i >= 0; i = ring.peek()) {
      const a = ring.i32, f = ring.f32;
      fn(a[i], a[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5], a[i + 6], f[i + 7]);
      ring.release();
      n++;
    }
    return n;
  }
}

// A bump allocator over the part of the shared buffer left for the engine's own data.
export class BumpHeap {
  constructor(start, bytes) {
    this.start = start;
    this.end = start + bytes;
    this.top = start;
  }

  alloc(bytes, align = 16) {
    const at = alignUp(this.top, align);
    if (at + bytes > this.end) throw new RangeError('shared heap exhausted: raise heapBytes');
    this.top = at + bytes;
    return at;
  }
}

// The host's start message is caught as soon as this module is evaluated: a worker that awaits something before
// calling connect() (instantiating its wasm, say) would otherwise miss it. Import this module statically.
const startMessage = typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof document === 'undefined'
  ? new Promise((resolve) => {
    const on = (ev) => {
      if (ev.data?.type !== 'rangeplay:start') return;
      self.removeEventListener('message', on);
      resolve(ev.data);
    };
    self.addEventListener('message', on);
  })
  : null;

// Sets up the engine's shared memory and connects it to the runtime's workers. Call once, in the engine worker that
// host.js started. Layout of the SharedArrayBuffer: [IO control block][command ring][input ring][heap].
export async function connect({ heapBytes = 64 * 1048576, ioSlots = 16, hintCap = 1024, gpuRingBytes = 4 * 1048576, inputCap = 256, maxFramesInFlight = 2 } = {}) {
  if (!startMessage) throw new Error('connect() runs in the engine worker that host.js starts');
  const start = await startMessage;
  const ioOffset = 0;
  const gpuOffset = alignUp(ioOffset + ioControlBytes(ioSlots, hintCap), 64);
  const inputOffset = alignUp(gpuOffset + CommandRing.bytes(gpuRingBytes), 64);
  const heapOffset = alignUp(inputOffset + RecordRing.bytes(inputCap, INPUT_WORDS), 4096);
  const buffer = new SharedArrayBuffer(heapOffset + heapBytes);

  initIoControl(buffer, ioOffset, ioSlots, hintCap);
  CommandRing.init(buffer, gpuOffset, gpuRingBytes);
  RecordRing.init(buffer, inputOffset, inputCap, INPUT_WORDS);
  start.ioPort.postMessage({ type: 'attach', memory: buffer, controlOffset: ioOffset });
  start.gpuPort.postMessage({ type: 'attach', memory: buffer, ringOffset: gpuOffset });
  self.postMessage({ type: 'rangeplay:input', memory: buffer, ringOffset: inputOffset });

  const files = new FileTable(start.manifest, start.manifestUrl);
  return {
    buffer,
    files,
    options: start.options || {},
    io: new IoClient(buffer, ioOffset),
    gpu: new GpuClient(buffer, gpuOffset, { maxFramesInFlight }),
    input: new InputClient(buffer, inputOffset),
    heap: new BumpHeap(heapOffset, heapBytes),
    // What another engine thread needs to make its own IoClient (post it to that worker).
    shared: () => ({ buffer, ioOffset, manifest: start.manifest, manifestUrl: start.manifestUrl }),
    // Tell the page something (shown by the host's onMessage callback).
    post: (message) => self.postMessage({ type: 'rangeplay:app', message }),
  };
}

// ---- engines compiled to wasm (native/rangeplay.h) -----------------------------------------------------------------

// The host's start message: { manifest, manifestUrl, ioPort, gpuPort, options }.
export function waitForStart() {
  if (!startMessage) throw new Error('waitForStart() runs in the engine worker that host.js starts');
  return startMessage;
}

// Hands the engine's shared memory (a shared WebAssembly.Memory, or its SharedArrayBuffer when it cannot grow) and
// the addresses of the structures the engine set up with rp_io_init / rp_ring_init / rp_records_init to the runtime.
export function attachWasm(start, { memory, ioOffset, gpuOffset = null, inputOffset = null }) {
  start.ioPort.postMessage({ type: 'attach', memory, controlOffset: ioOffset });
  if (gpuOffset !== null) start.gpuPort.postMessage({ type: 'attach', memory, ringOffset: gpuOffset });
  if (inputOffset !== null) self.postMessage({ type: 'rangeplay:input', memory, ringOffset: inputOffset });
}

// Tells the page something from an engine worker (the host's onMessage callback receives it).
export function postToPage(message) {
  self.postMessage({ type: 'rangeplay:app', message });
}
