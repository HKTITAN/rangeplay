// The IO service: answers the engine threads' blocking reads from shared memory, fetching missing blocks with HTTP
// Range requests into a block store, and fetches ahead of the engine from hints, sequential read-ahead and the boot set.
// No DOM, no worker globals: io-worker.js runs it in the browser, the tests run it on Node.

import {
  ERR_BADF, ERR_INVAL, ERR_IO, HINT_FILE, HINT_LEN_FLAGS, HINT_LEN_MASK, HINT_OFF_HI, HINT_OFF_LO, HINT_SEQ, HINT_SPECULATIVE,
  IO_DOORBELL_W, IO_HINT_CAP_W, IO_HINT_HEAD_W, IO_HINT_TAIL_W, IO_MAGIC, IO_MAGIC_W, IO_READY_W, IO_SLOT_CAP_W,
  IO_SLOT_NEXT_W, READ_NO_READAHEAD, SLOT_DONE, SLOT_DST_HI, SLOT_DST_LO, SLOT_FILE, SLOT_FLAGS, SLOT_LEN, SLOT_OFF_HI,
  SLOT_OFF_LO, SLOT_REQUESTED, SLOT_RESULT, SLOT_STATE, SLOT_TAKEN, ioHintWord, ioSlotWord,
} from '../shared/layout.js';
import { BOOTSET_FORMAT, mergeRanges, validateBootset } from '../shared/bootset.js';
import { DroppedError, Lane } from './lane.js';
import { MemoryStore } from './store-memory.js';

export const DEFAULT_OPTIONS = {
  demandSliceBytes: 256 * 1024,   // a blocking read larger than this is fetched as parallel slices (latency-bound hosts)
  maxRunBytes: 1024 * 1024,       // longest single background request
  readAheadMinRead: 64 * 1024,    // only reads at least this big, continuing the previous one, trigger read-ahead
  readAheadFirst: 64 * 1024,      // read-ahead starts here and doubles per sequential read...
  readAheadMax: 1024 * 1024,      // ...up to this
  hintConcurrency: 32,            // background fetches for reads the engine announced
  speculativeConcurrency: 8,      // read-ahead and speculative hints, low fetch priority
  bootConcurrency: 16,            // boot set fetches, low fetch priority
  maxQueuedHints: 2048,           // older queued hints are dropped beyond this
  bootGapBytes: 64 * 1024,        // boot set ranges closer than this are fetched as one
  memoryCacheBytes: 256 * 1048576, // size of the in-memory cache when there is no persistent one
};

const now = () => (globalThis.performance ? performance.now() : Date.now());

export class IoCore {
  constructor({ files, store, fetcher, options = {}, log = () => {} }) {
    this.files = files;
    this.bs = files.blockSize;
    this.store = store;
    this.fetcher = fetcher;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.log = log;
    this.inflight = new Map();   // block key -> { promise, promote }
    this.hintLane = new Lane(this.opts.hintConcurrency);
    this.lowLane = new Lane(this.opts.speculativeConcurrency);
    this.seq = new Map();        // file id -> { end, ahead }: sequential read detection
    this.recording = null;       // file id -> [[start, end], ...] while recording a boot set
    this.closed = false;
    this.memory = null;
    this.runsStarted = 0;
    this.stats = {
      reads: 0, bytesRead: 0, readsWaited: 0, readsCold: 0, waitMs: 0, maxWaitMs: 0, readErrors: 0,
      fetches: 0, fetchesActive: 0, bytesFetched: 0,
      hints: 0, hintsFetched: 0, hintsDropped: 0,
      boot: { runs: 0, done: 0, bytes: 0, ms: 0, state: 'none' },
    };
    if (fetcher) fetcher.onBytes = (n) => { this.stats.bytesFetched += n; };
  }

  key(id, block) {
    return id * 4294967296 + block;
  }

  // ---- fetching blocks ----------------------------------------------------------------------------------------------

  // Makes sure blocks first..last of file id are stored. cls: 'demand' (an engine thread waits), 'hint' (announced
  // read), 'low' (read-ahead, speculative hint), 'boot' (boot set). Returns a promise, or null when nothing is missing.
  ensure(id, first, last, cls) {
    last = Math.min(last, this.files.blocks(id) - 1);
    if (first > last) return null;
    const maxRun = Math.max(1, Math.floor(this.opts.maxRunBytes / this.bs));
    const waits = new Set();
    let a = -1;
    const flush = (end) => {
      if (a >= 0) waits.add(this.#startRun(id, a, end, cls));
      a = -1;
    };
    for (let b = first; b <= last; b++) {
      if (this.store.has(id, b)) {
        flush(b - 1);
        continue;
      }
      const running = this.inflight.get(this.key(id, b));
      if (running) {
        flush(b - 1);
        if (cls === 'demand') running.promote?.();   // an engine thread is blocked on it: start it now, high priority
        waits.add(running.promise);
        continue;
      }
      if (a < 0) a = b;
      else if (b - a >= maxRun) {
        flush(b - 1);
        a = b;
      }
    }
    flush(last);
    return waits.size ? Promise.all(waits) : null;
  }

  #startRun(id, a, b, cls) {
    this.runsStarted++;
    const bs = this.bs, start = a * bs;
    const bytes = Math.min(this.files.size(id), (b + 1) * bs) - start;
    const url = this.files.url(id);
    const exec = async (promoted) => {
      const priority = cls === 'demand' || promoted ? 'high' : cls === 'hint' ? 'auto' : 'low';
      // An engine thread waits on demand reads: big ones go as parallel slices, since on many hosts a single stream is
      // limited by round trips, not by the link. Background runs go whole: their speed is the number in flight.
      const slice = cls === 'demand' || promoted ? Math.max(bs, this.opts.demandSliceBytes - (this.opts.demandSliceBytes % bs)) : bytes;
      const store = this.store;
      const run = store.beginRun(id, a, bytes);
      const abort = new AbortController();   // one failed slice cancels its siblings
      this.stats.fetches++;
      this.stats.fetchesActive++;
      try {
        const parts = [];
        for (let s = 0; s < bytes; s += slice) {
          const n = Math.min(slice, bytes - s);
          parts.push(this.fetcher.range(url, start + s, start + s + n - 1, {
            priority,
            size: this.files.size(id),
            signal: abort.signal,
            onChunk: (chunk, pos) => run.write(chunk, s + pos),
          }).then((got) => {
            if (got !== n) throw new Error(this.files.path(id) + ': the server has ' + (start + s + got) + ' bytes, the manifest says ' + this.files.size(id));
          }));
        }
        await Promise.all(parts);
        store.endRun(run);
      } catch (e) {
        abort.abort(e);
        store.abortRun?.(run);
        throw e;
      } finally {
        this.stats.fetchesActive--;
      }
    };
    const forget = () => {
      for (let k = a; k <= b; k++) if (this.inflight.get(this.key(id, k)) === entry) this.inflight.delete(this.key(id, k));
    };
    const lane = cls === 'hint' ? this.hintLane : cls === 'low' ? this.lowLane : null;
    // A queued fetch dropped from its lane leaves the in-flight map at once, so nobody joins it in the meantime.
    const task = lane ? lane.run(exec, forget) : { promise: exec(false), promote: null };
    const entry = { promise: null, promote: task.promote };
    entry.promise = task.promise.finally(forget);
    entry.promise.catch(() => {});
    for (let k = a; k <= b; k++) this.inflight.set(this.key(id, k), entry);
    if (lane) lane.trim(this.opts.maxQueuedHints);
    return entry.promise;
  }

  // A read that continues the previous read of the same file (and is not tiny) fetches the bytes after it too, with a
  // window that doubles on every such read. Small or scattered reads (archive tables of contents) fetch only themselves.
  #readAhead(id, off, len, lastBlock) {
    const st = this.seq.get(id) || { end: -1, ahead: 0 };
    const sequential = off === st.end && len >= this.opts.readAheadMinRead;
    st.ahead = sequential ? Math.min(this.opts.readAheadMax, st.ahead ? st.ahead * 2 : this.opts.readAheadFirst) : 0;
    st.end = off + len;
    this.seq.set(id, st);
    if (!st.ahead) return;
    const to = Math.floor((Math.min(this.files.size(id), off + len + st.ahead) - 1) / this.bs);
    this.ensure(id, lastBlock + 1, to, 'low')?.catch(() => {});
  }

  // ---- serving the engine threads -----------------------------------------------------------------------------------

  // Starts serving the IO control block at byte offset `controlOffset` of `memory` (a shared WebAssembly.Memory or a
  // SharedArrayBuffer). Destinations of reads are addresses in the same memory.
  attach(memory, controlOffset) {
    this.memory = memory;
    this.#views();
    const cw = controlOffset / 4;
    if (!Number.isInteger(cw) || Atomics.load(this.i32, cw + IO_MAGIC_W) !== IO_MAGIC) throw new Error('no IO control block at ' + controlOffset);
    this.cw = cw;
    this.slotCap = this.i32[cw + IO_SLOT_CAP_W];
    this.hintCap = this.i32[cw + IO_HINT_CAP_W];
    Atomics.store(this.i32, cw + IO_READY_W, 1);
    Atomics.notify(this.i32, cw + IO_READY_W);
    this.loop = this.#loop();
    return this.loop;
  }

  #views() {
    const buffer = this.memory.buffer ?? this.memory;
    if (this.u8?.buffer !== buffer || this.u8.length !== buffer.byteLength) {
      this.u8 = new Uint8Array(buffer);
      this.i32 = new Int32Array(buffer, 0, buffer.byteLength >> 2);
    }
  }

  async #loop() {
    const bell = this.cw + IO_DOORBELL_W;
    while (!this.closed) {
      this.#views();
      const a = this.i32;
      const seen = Atomics.load(a, bell);   // read before scanning: a request made during the scan changes it
      const n = Math.min(Atomics.load(a, this.cw + IO_SLOT_NEXT_W), this.slotCap);
      for (let s = 0; s < n; s++) {
        const w = this.cw + ioSlotWord(s);
        if (Atomics.compareExchange(a, w + SLOT_STATE, SLOT_REQUESTED, SLOT_TAKEN) === SLOT_REQUESTED) this.#serve(w);
      }
      this.#drainHints();
      await waitForChange(a, bell, seen, () => this.closed);
    }
  }

  async #serve(w) {
    const t0 = now();
    let a = this.i32;
    const id = a[w + SLOT_FILE];
    const off = (a[w + SLOT_OFF_LO] >>> 0) + (a[w + SLOT_OFF_HI] >>> 0) * 4294967296;
    const dst = (a[w + SLOT_DST_LO] >>> 0) + (a[w + SLOT_DST_HI] >>> 0) * 4294967296;
    const flags = a[w + SLOT_FLAGS];
    let len = a[w + SLOT_LEN], result;
    try {
      if (!this.files.valid(id)) result = ERR_BADF;
      else if (len < 0) result = ERR_INVAL;
      else {
        const size = this.files.size(id);
        if (off >= size || len === 0) result = 0;
        else {
          if (off + len > size) len = size - off;
          if (dst + len > this.u8.length) this.#views();
          if (dst + len > this.u8.length) result = ERR_INVAL;
          else {
            this.stats.reads++;
            this.stats.bytesRead += len;
            if (this.recording) this.#recordTouch(id, off, len);
            const first = Math.floor(off / this.bs), last = Math.floor((off + len - 1) / this.bs);
            this.store.pin?.(id, first, last);
            try {
              await this.#fetchAndCopy(id, off, len, dst, first, last, flags, t0);
            } finally {
              this.store.unpin?.(id, first, last);
            }
            result = len;
          }
        }
      }
    } catch (e) {
      this.stats.readErrors++;
      this.log('[io] read failed: ' + (this.files.valid(id) ? this.files.path(id) : 'file ' + id) + ' at ' + off + ': ' + e.message);
      result = ERR_IO;
    }
    a = this.i32;
    a[w + SLOT_RESULT] = result;
    Atomics.store(a, w + SLOT_STATE, SLOT_DONE);
    Atomics.notify(a, w + SLOT_STATE);
  }

  // Waits for blocks first..last (fetching what nobody fetches yet), then copies the read into shared memory.
  async #fetchAndCopy(id, off, len, dst, first, last, flags, t0) {
    let waited = false;
    for (let attempt = 0; ; attempt++) {
      const runsBefore = this.runsStarted;
      const pending = this.ensure(id, first, last, 'demand');
      if (attempt === 0 && !(flags & READ_NO_READAHEAD)) this.#readAhead(id, off, len, last);
      if (pending) {
        if (!waited) {
          waited = true;
          this.stats.readsWaited++;
          // cold: nobody fetched these bytes ahead of the read (no hint, read-ahead or boot set covered them)
          if (this.runsStarted !== runsBefore) this.stats.readsCold++;
        }
        try {
          await pending;
        } catch (e) {
          // The fetch this read joined failed (maybe a background one): try again with a fetch of its own.
          if (attempt >= 2) throw e;
          continue;
        }
      }
      this.#views();
      let copied;
      try {
        copied = this.store.read(id, off, len, this.u8, dst);
      } catch (e) {
        // The persistent store broke under us (its files deleted, the disk gone): carry on in memory.
        if (this.store.kind !== 'opfs' || attempt >= 2) throw e;
        this.log('[io] cache read failed (' + e.message + '): caching in memory from now on');
        this.swapStore(new MemoryStore({ files: this.files, maxBytes: this.opts.memoryCacheBytes }));
        continue;
      }
      // The blocks are pinned, but a store can still lose a fetch (a failed disk write): then fetch again.
      if (copied === len) break;
      if (attempt >= 3) throw new Error('blocks of ' + this.files.path(id) + ' keep disappearing from the cache');
    }
    if (waited) {
      const ms = now() - t0;
      this.stats.waitMs += ms;
      if (ms > this.stats.maxWaitMs) this.stats.maxWaitMs = ms;
    }
  }

  #drainHints() {
    if (!this.hintCap) return;
    const a = this.i32, cw = this.cw, cap = this.hintCap;
    const head = Atomics.load(a, cw + IO_HINT_HEAD_W) >>> 0;
    let tail = Atomics.load(a, cw + IO_HINT_TAIL_W) >>> 0;
    if (((head - tail) >>> 0) > cap) {
      this.stats.hintsDropped += ((head - tail) >>> 0) - cap;
      tail = (head - cap) >>> 0;   // the producers lapped us: the oldest hints were overwritten
    }
    while (tail !== head) {
      const e = cw + ioHintWord(this.slotCap, tail & (cap - 1));
      const want = (tail + 1) | 0;
      const s1 = Atomics.load(a, e + HINT_SEQ);
      if (s1 !== want) {
        // A published hint of a later lap: this one was overwritten, skip it. Anything else (an earlier lap, or the
        // "being written" marker) means its producer has not finished: it rings the doorbell when it has.
        if (((s1 - want) & (cap - 1)) === 0 && ((s1 - want) | 0) > 0) {
          this.stats.hintsDropped++;
          tail = (tail + 1) >>> 0;
          continue;
        }
        break;
      }
      const id = a[e + HINT_FILE];
      const off = (a[e + HINT_OFF_LO] >>> 0) + (a[e + HINT_OFF_HI] >>> 0) * 4294967296;
      const lf = a[e + HINT_LEN_FLAGS];
      tail = (tail + 1) >>> 0;
      if (Atomics.load(a, e + HINT_SEQ) !== s1) {   // overwritten while we read it
        this.stats.hintsDropped++;
        continue;
      }
      this.stats.hints++;
      // Hints are advisory: a torn or stale entry costs at most a useless fetch.
      if (!this.files.valid(id) || off >= this.files.size(id)) continue;
      const len = Math.min(lf & HINT_LEN_MASK, this.files.size(id) - off);
      if (len <= 0) continue;
      const p = this.ensure(id, Math.floor(off / this.bs), Math.floor((off + len - 1) / this.bs), lf & HINT_SPECULATIVE ? 'low' : 'hint');
      if (p) {
        this.stats.hintsFetched++;
        p.catch((e) => { if (!(e instanceof DroppedError)) this.log('[io] hinted fetch failed: ' + e.message); });
      }
    }
    Atomics.store(a, cw + IO_HINT_TAIL_W, tail | 0);
  }

  // ---- boot set -----------------------------------------------------------------------------------------------------

  // Fetches the ranges of a boot set in order, bootConcurrency at a time, at low priority. Returns when done.
  async prefetchBootset(set) {
    validateBootset(set);
    const maxRun = Math.max(1, Math.floor(this.opts.maxRunBytes / this.bs));
    const runs = [];
    let bytes = 0;
    for (const [path, ranges] of set.files) {
      const id = this.files.id(path);
      if (id < 0) continue;   // not in this version
      const lastBlock = this.files.blocks(id) - 1;
      for (const [s, e] of mergeRanges(ranges, this.opts.bootGapBytes)) {
        if (s > this.files.size(id) - 1) continue;
        const a = Math.floor(s / this.bs), b = Math.min(Math.floor(e / this.bs), lastBlock);
        for (let k = a; k <= b; k += maxRun) runs.push([id, k, Math.min(b, k + maxRun - 1)]);
        bytes += Math.min(e, this.files.size(id) - 1) - s + 1;
      }
    }
    const boot = this.stats.boot;
    Object.assign(boot, { runs: runs.length, done: 0, bytes, state: 'running' });
    const t0 = now();
    let next = 0;
    const worker = async () => {
      while (next < runs.length && !this.closed) {
        const [id, a, b] = runs[next++];
        try {
          await this.ensure(id, a, b, 'boot');
        } catch (e) {
          this.log('[io] boot set fetch failed: ' + e.message);
        }
        boot.done++;
      }
    };
    await Promise.all(Array.from({ length: this.opts.bootConcurrency }, worker));
    boot.ms = now() - t0;
    boot.state = 'done';
    this.log('[io] boot set: ' + runs.length + ' ranges, ' + (bytes / 1048576).toFixed(1) + ' MB in ' + (boot.ms / 1000).toFixed(1) + ' s');
  }

  startRecording() {
    this.recording = new Map();
  }

  #recordTouch(id, off, len) {
    let r = this.recording.get(id);
    if (!r) this.recording.set(id, (r = []));
    r.push([off, off + len - 1]);
  }

  // The reads seen since startRecording(), as a boot set (files in order of first touch).
  takeRecording() {
    const files = [];
    for (const [id, ranges] of this.recording || []) files.push([this.files.path(id), mergeRanges(ranges, 0)]);
    return { format: BOOTSET_FORMAT, manifestVersion: this.files.version, files };
  }

  snapshot() {
    return {
      ...this.stats,
      boot: { ...this.stats.boot },
      queued: this.hintLane.queued + this.lowLane.queued,
      store: this.store.stats(),
      retries: this.fetcher?.stats.retries ?? 0,
      requests: this.fetcher?.stats.requests ?? 0,
    };
  }

  // Replaces the block store, e.g. while the page is hidden (the persistent store is released for other tabs). Fetches
  // still writing into the old store fail and are made again.
  swapStore(store) {
    const old = this.store;
    this.store = store;
    old.close();
  }

  // Returns the store lock's release function when keepLock is set (see OpfsStore.close).
  close({ keepLock = false } = {}) {
    this.closed = true;
    return this.store.close({ keepLock });
  }
}

// Resolves when a[i] !== seen (or every second, to notice `stop`). Uses Atomics.waitAsync where it exists and polls
// with a short backoff where it does not.
async function waitForChange(a, i, seen, stop) {
  if (typeof Atomics.waitAsync === 'function') {
    const r = Atomics.waitAsync(a, i, seen, 1000);
    if (r.async) await r.value;
    return;
  }
  for (let delay = 1; Atomics.load(a, i) === seen && !stop(); delay = Math.min(delay * 2, 8)) {
    await new Promise((r) => setTimeout(r, delay));
  }
}
