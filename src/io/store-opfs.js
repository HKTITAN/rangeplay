// Persistent block store in the Origin Private File System.
//
// data.bin is append-only: a fetch reserves room at its end and the response body is streamed into it chunk by chunk.
// journal.bin records where each block went, written only after the data it points to has been flushed, so a crash
// can lose recent blocks but never index garbage. Entries are keyed by the file's content hash, not its id: after a new
// manifest, blocks of files whose bytes did not change are still valid.
//
// journal.bin, little-endian:
//   32-byte header  [u32 magic "RPJ1"][u32 format 2][u32 block size][u32 generation][16 bytes reserved]
//   32-byte entries [u32 key lo][u32 key hi][u32 block][u32 bytes][u32 offset lo][u32 offset hi][u32 generation][u32 check]
// Entries are 32 bytes so that none straddles a 4 KB page (a torn write cannot leave half an entry that looks whole),
// and carry a checksum and the store's generation (a new one at every reset), so entries from before a reset that
// a crash left behind are never trusted.
//
// Works on anything shaped like FileSystemSyncAccessHandle (read/write with {at}, getSize, truncate, flush, close),
// which is how the tests run it on Node files.

import { MemoryStore } from './store-memory.js';

const MAGIC = 0x314a5052;   // "RPJ1"
const FORMAT = 2;
const HEADER = 32;
const ENTRY = 32;

function checksum(words) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 7; i++) {
    h = Math.imul(h ^ words[i], 0x01000193);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export class OpfsStore {
  constructor({ files, data, journal, maxBytes = Infinity, overflowBytes = 128 * 1048576, log = () => {}, release = null }) {
    this.files = files;
    this.bs = files.blockSize;
    this.data = data;
    this.journal = journal;
    this.maxBytes = maxBytes;
    this.log = log;
    this.release = release;
    this.kind = 'opfs';
    this.index = new Map();   // block key -> offset in data.bin
    this.pending = [];        // journal entries whose data is not flushed yet
    this.end = 0;
    this.journalEnd = HEADER;
    this.generation = 0;
    this.full = false;
    this.flushTimer = 0;
    this.readIntoShared = true;
    this.overflow = new MemoryStore({ files, maxBytes: overflowBytes });   // used once the disk store is full
    // objects with identical bytes share their cached blocks (store ids: packed files have none, their pack has one)
    this.byContent = new Map();
    for (let id = 0; id < files.objects; id++) {
      if (files.packed(id)) continue;
      const [lo, hi] = files.contentKey(id), k = hi + ':' + lo;
      if (!this.byContent.has(k)) this.byContent.set(k, []);
      this.byContent.get(k).push(id);
    }
    this.#load();
  }

  key(id, block) {
    return id * 4294967296 + block;
  }

  #load() {
    const head = new DataView(new ArrayBuffer(HEADER));
    let ok = false;
    if (this.journal.getSize() >= HEADER) {
      this.journal.read(new Uint8Array(head.buffer), { at: 0 });
      ok = head.getUint32(0, true) === MAGIC && head.getUint32(4, true) === FORMAT && head.getUint32(8, true) === this.bs && head.getUint32(12, true) !== 0;
    }
    if (!ok) return this.reset();
    this.generation = head.getUint32(12, true);

    const dataSize = this.data.getSize();
    const n = Math.floor((this.journal.getSize() - HEADER) / ENTRY);
    const buf = new Uint8Array(n * ENTRY);
    if (n) this.journal.read(buf, { at: HEADER });
    const words = new Uint32Array(buf.buffer);

    let live = 0, kept = 0, good = 0;
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const w = words.subarray(i * 8, i * 8 + 8);
      const block = w[2], bytes = w[3], at = w[4] + w[5] * 4294967296;
      if (w[6] !== this.generation || w[7] !== checksum(w) || !bytes || bytes > this.bs || at + bytes > dataSize) continue;
      keep[i] = 1;
      good++;
      const ids = this.byContent.get(w[1] + ':' + w[0]);
      if (!ids) continue;   // a file of another version: dead space
      let used = false;
      for (const id of ids) {
        if (block >= this.files.blocks(id) || bytes !== this.files.blockLen(id, block)) continue;
        this.index.set(this.key(id, block), at);
        used = true;
      }
      if (used) {
        live += bytes;
        kept++;
      }
    }
    this.end = dataSize;
    this.storedBytes = live;
    if (good < n) {
      // Torn or stale entries: rewrite the journal without them, so they cannot come back once data.bin grows again.
      this.log('[store] dropping ' + (n - good) + ' damaged journal entries');
      const clean = new Uint8Array(good * ENTRY);
      for (let i = 0, j = 0; i < n; i++) if (keep[i]) clean.set(buf.subarray(i * ENTRY, (i + 1) * ENTRY), ENTRY * j++);
      this.journal.truncate(HEADER);
      if (good) this.journal.write(clean, { at: HEADER });
      this.journal.flush();
    }
    this.journalEnd = HEADER + good * ENTRY;
    // Space held by files that are gone is only reclaimed by starting over. Do it when most of the store is dead.
    if (dataSize > 64 * 1048576 && live < dataSize / 2) {
      this.log('[store] ' + ((dataSize - live) / 1048576 | 0) + ' MB of ' + (dataSize / 1048576 | 0) + ' MB belong to old versions: starting an empty store');
      return this.reset();
    }
    if (this.end >= this.maxBytes) this.full = true;
    this.log('[store] ' + kept + ' blocks (' + (live / 1048576).toFixed(1) + ' MB) cached from earlier visits');
  }

  // Starts an empty store. The journal goes first: a crash before the data is truncated leaves dead bytes, never
  // entries that point into new data.
  reset() {
    this.index.clear();
    this.pending.length = 0;
    this.generation = (Math.random() * 0xfffffffe + 1) >>> 0;
    const head = new DataView(new ArrayBuffer(HEADER));
    head.setUint32(0, MAGIC, true);
    head.setUint32(4, FORMAT, true);
    head.setUint32(8, this.bs, true);
    head.setUint32(12, this.generation, true);
    this.journal.truncate(0);
    this.journal.write(new Uint8Array(head.buffer), { at: 0 });
    this.journal.flush();
    this.data.truncate(0);
    this.data.flush();
    this.end = 0;
    this.journalEnd = HEADER;
    this.storedBytes = 0;
    this.full = false;
  }

  // Only the in-memory overflow evicts.
  pin(id, first, last) {
    this.overflow.pin(id, first, last);
  }

  unpin(id, first, last) {
    this.overflow.unpin(id, first, last);
  }

  has(id, block) {
    const k = this.key(id, block);
    return this.index.has(k) || this.overflow.index.has(k);
  }

  beginRun(id, firstBlock, bytes) {
    if (this.full || this.end + bytes > this.maxBytes) {
      this.full = true;
      const run = this.overflow.beginRun(id, firstBlock, bytes);
      run.overflow = true;
      return run;
    }
    const run = { id, firstBlock, bytes, at: this.end, failed: null };
    this.end += bytes;
    run.write = (chunk, pos) => {
      if (run.failed) return;
      try {
        this.data.write(chunk, { at: run.at + pos });
      } catch (e) {
        // Quota exceeded or the disk is full: this run is lost, later runs go to memory.
        run.failed = e;
        this.full = true;
        this.log('[store] write failed (' + e.message + '): caching in memory from now on');
      }
    };
    return run;
  }

  endRun(run) {
    if (run.overflow) return this.overflow.endRun(run);
    if (run.failed) throw run.failed;
    const n = Math.ceil(run.bytes / this.bs);
    const [lo, hi] = this.files.contentKey(run.id);
    const same = this.byContent.get(hi + ':' + lo) || [run.id];
    for (let k = 0; k < n; k++) {
      const block = run.firstBlock + k, at = run.at + k * this.bs;
      for (const id of same) this.index.set(this.key(id, block), at);
      this.pending.push(lo, hi, block, this.files.blockLen(run.id, block), at);
    }
    this.storedBytes += run.bytes;
    this.#scheduleFlush();
  }

  // A fetch failed: give its reserved room back if nothing was reserved after it.
  abortRun(run) {
    if (run.overflow) return;
    run.failed ||= new Error('fetch aborted');   // chunks still arriving from cancelled slices are ignored
    if (run.at + run.bytes === this.end) this.end = run.at;
  }

  // Copies [offset, offset + length) of file id into dst (a Uint8Array, may be shared memory) at dstOffset.
  // Returns length, or -1 if a block is missing.
  read(id, offset, length, dst, dstOffset) {
    const bs = this.bs;
    for (let b = Math.floor(offset / bs), last = Math.floor((offset + length - 1) / bs); b <= last; b++) {
      if (!this.has(id, b)) return -1;
    }
    let done = 0;
    while (done < length) {
      const pos = offset + done, block = Math.floor(pos / bs);
      const at = this.index.get(this.key(id, block));
      if (at === undefined) {
        // in the overflow cache: copy this block's part from memory
        const n = Math.min(length - done, (block + 1) * bs - pos);
        if (this.overflow.read(id, pos, n, dst, dstOffset + done) < 0) return -1;
        done += n;
        continue;
      }
      // extend while the following blocks are stored right behind this one
      let n = Math.min(length - done, (block + 1) * bs - pos);
      for (let b = block + 1; done + n < length; b++) {
        if (this.index.get(this.key(id, b)) !== at + (b - block) * bs) break;
        n += Math.min(length - done - n, bs);
      }
      this.#readAt(dst, dstOffset + done, n, at + (pos - block * bs));
      done += n;
    }
    return length;
  }

  #readAt(dst, dstOffset, n, at) {
    let got;
    if (this.readIntoShared) {
      try {
        got = this.data.read(dst.subarray(dstOffset, dstOffset + n), { at });
      } catch (e) {
        // Some engines refuse views on shared memory here: go through a private buffer from now on.
        this.readIntoShared = false;
        this.log('[store] reading into shared memory failed (' + e.message + '): copying through a buffer');
      }
    }
    if (!this.readIntoShared) {
      const tmp = new Uint8Array(n);
      got = this.data.read(tmp, { at });
      dst.set(tmp, dstOffset);
    }
    if (got !== n) throw new Error('store read returned ' + got + ' of ' + n + ' bytes');
  }

  #scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = 0;
      this.flush();
    }, 1000);
  }

  // Data first, then the journal entries that point at it.
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
    if (!this.pending.length) return;
    const p = this.pending, n = p.length / 5;
    const words = new Uint32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const w = words.subarray(i * 8, i * 8 + 8), at = p[i * 5 + 4];
      w[0] = p[i * 5];          // key lo
      w[1] = p[i * 5 + 1];      // key hi
      w[2] = p[i * 5 + 2];      // block
      w[3] = p[i * 5 + 3];      // bytes
      w[4] = at % 4294967296;
      w[5] = Math.floor(at / 4294967296);
      w[6] = this.generation;
      w[7] = checksum(w);
    }
    this.pending.length = 0;
    try {
      this.data.flush();
      this.journal.write(new Uint8Array(words.buffer), { at: this.journalEnd });
      this.journal.flush();
      this.journalEnd += n * ENTRY;
    } catch (e) {
      this.log('[store] journal write failed: ' + e.message);
    }
  }

  stats() {
    return { kind: this.kind, bytes: this.storedBytes, blocks: this.index.size, persistent: true, full: this.full, overflowBytes: this.overflow.bytes };
  }

  // keepLock: return the lock's release function instead of releasing it (to delete the files first).
  close({ keepLock = false } = {}) {
    this.flush();
    try {
      this.data.close();
      this.journal.close();
    } catch {}
    this.overflow.close();
    const release = this.release || (() => {});
    this.release = null;
    if (keepLock) return release;
    release();
    return null;
  }
}

// Opens the store in OPFS (dedicated workers only: sync access handles). Resolves to null when it cannot: no OPFS,
// another tab holds it (Web Locks), or the handles stay locked.
export async function openOpfsStore({ files, name = files.name, lockTimeoutMs = 2000, log = () => {}, maxBytes, overflowBytes } = {}) {
  if (!globalThis.navigator?.storage?.getDirectory) return null;
  const release = await lockStore(name, lockTimeoutMs);
  if (release === null) {
    log('[store] another tab is using the cache: caching in memory');
    return null;
  }
  let data = null, journal = null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('rangeplay', { create: true })).getDirectoryHandle(safeName(name), { create: true });
    data = await openHandle(dir, 'data.bin');
    journal = await openHandle(dir, 'journal.bin');
    if (maxBytes === undefined && navigator.storage.estimate) {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      maxBytes = quota ? Math.max(0, quota - usage + data.getSize()) * 0.8 : Infinity;
    }
    return new OpfsStore({ files, data, journal, maxBytes, overflowBytes, log, release });
  } catch (e) {
    try { data?.close(); journal?.close(); } catch {}
    release();
    log('[store] OPFS unavailable (' + e.message + '): caching in memory');
    return null;
  }
}

// Takes the store's lock (for deleting it while no tab uses it). Resolves to the release function, or null.
export function lockStore(name, timeoutMs = 2000) {
  return acquireLock('rangeplay-store:' + name, timeoutMs);
}

// Deletes the persistent store of `name`. The caller must hold its lock (see close({ keepLock }) and lockStore()).
export async function deleteOpfsStore(name) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('rangeplay', { create: true });
  await dir.removeEntry(safeName(name), { recursive: true }).catch((e) => {
    if (e.name !== 'NotFoundError') throw e;
  });
}

function safeName(name) {
  return String(name).replace(/[^\w.-]+/g, '_').slice(0, 100) || 'default';
}

// A reload can find the previous page's handles still open for a moment: retry briefly.
async function openHandle(dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  for (let attempt = 0; ; attempt++) {
    try {
      return await fh.createSyncAccessHandle();
    } catch (e) {
      if (e.name !== 'NoModificationAllowedError' || attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// Holds a Web Lock for as long as this worker lives (or until release()). Resolves to the release function, or null if
// the lock stayed taken for timeoutMs. Without Web Locks: a no-op release.
function acquireLock(name, timeoutMs) {
  if (!globalThis.navigator?.locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    navigator.locks
      .request(name, { signal: ac.signal }, () => {
        clearTimeout(timer);
        return new Promise((release) => resolve(release));
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}
