// Persistent block store in the Origin Private File System.
//
// data.bin is append-only: a fetch reserves room at its end and the response body is streamed into it chunk by chunk.
// journal.bin records where each block went, written only after the data it points to has been flushed, so a crash
// can lose recent blocks but never index garbage. Entries are keyed by the file's content hash, not its id: after a new
// manifest, blocks of files whose bytes did not change are still valid.
//
// journal.bin: 32-byte header [u32 magic "RPJ1"][u32 format 1][u32 block size][20 bytes reserved], then 24-byte
// entries [u32 key lo][u32 key hi][u32 block][u32 bytes][u32 offset lo][u32 offset hi], little-endian.
//
// Works on anything shaped like FileSystemSyncAccessHandle (read/write with {at}, getSize, truncate, flush, close),
// which is how the tests run it on Node files.

import { MemoryStore } from './store-memory.js';

const MAGIC = 0x314a5052;   // "RPJ1"
const FORMAT = 1;
const HEADER = 32;
const ENTRY = 24;

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
    this.full = false;
    this.flushTimer = 0;
    this.readIntoShared = true;
    this.overflow = new MemoryStore({ files, maxBytes: overflowBytes });   // used once the disk store is full
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
      ok = head.getUint32(0, true) === MAGIC && head.getUint32(4, true) === FORMAT && head.getUint32(8, true) === this.bs;
    }
    if (!ok) return this.reset();

    const dataSize = this.data.getSize();
    const n = Math.floor((this.journal.getSize() - HEADER) / ENTRY);
    const buf = new Uint8Array(n * ENTRY);
    if (n) this.journal.read(buf, { at: HEADER });
    const dv = new DataView(buf.buffer);

    const byKey = new Map();
    for (let id = 0; id < this.files.count; id++) {
      const [lo, hi] = this.files.contentKey(id);
      byKey.set(hi + ':' + lo, id);
    }
    let live = 0, kept = 0;
    for (let i = 0; i < n; i++) {
      const o = i * ENTRY;
      const id = byKey.get(dv.getUint32(o + 4, true) + ':' + dv.getUint32(o, true));
      const block = dv.getUint32(o + 8, true), bytes = dv.getUint32(o + 12, true);
      const at = dv.getUint32(o + 16, true) + dv.getUint32(o + 20, true) * 4294967296;
      if (id === undefined || block >= this.files.blocks(id) || bytes !== this.files.blockLen(id, block) || at + bytes > dataSize) continue;
      this.index.set(this.key(id, block), at);
      live += bytes;
      kept++;
    }
    this.end = dataSize;
    this.journalEnd = HEADER + n * ENTRY;
    this.storedBytes = live;
    // Space held by files that are gone is only reclaimed by starting over. Do it when most of the store is dead.
    if (dataSize > 64 * 1048576 && live < dataSize / 2) {
      this.log('[store] ' + ((dataSize - live) / 1048576 | 0) + ' MB of ' + (dataSize / 1048576 | 0) + ' MB belong to old versions: starting an empty store');
      return this.reset();
    }
    if (this.end >= this.maxBytes) this.full = true;
    this.log('[store] ' + kept + ' blocks (' + (live / 1048576).toFixed(1) + ' MB) cached from earlier visits');
  }

  reset() {
    this.index.clear();
    this.pending.length = 0;
    this.data.truncate(0);
    this.journal.truncate(0);
    const head = new DataView(new ArrayBuffer(HEADER));
    head.setUint32(0, MAGIC, true);
    head.setUint32(4, FORMAT, true);
    head.setUint32(8, this.bs, true);
    this.journal.write(new Uint8Array(head.buffer), { at: 0 });
    this.journal.flush();
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
    for (let k = 0; k < n; k++) {
      const block = run.firstBlock + k, at = run.at + k * this.bs;
      this.index.set(this.key(run.id, block), at);
      this.pending.push(lo, hi, block, this.files.blockLen(run.id, block), at);
    }
    this.storedBytes += run.bytes;
    this.#scheduleFlush();
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
    const dv = new DataView(new ArrayBuffer(n * ENTRY));
    for (let i = 0; i < n; i++) {
      const o = i * ENTRY, at = p[i * 5 + 4];
      dv.setUint32(o, p[i * 5], true);           // key lo
      dv.setUint32(o + 4, p[i * 5 + 1], true);   // key hi
      dv.setUint32(o + 8, p[i * 5 + 2], true);   // block
      dv.setUint32(o + 12, p[i * 5 + 3], true);  // bytes
      dv.setUint32(o + 16, at % 4294967296, true);
      dv.setUint32(o + 20, Math.floor(at / 4294967296), true);
    }
    this.pending.length = 0;
    try {
      this.data.flush();
      this.journal.write(new Uint8Array(dv.buffer), { at: this.journalEnd });
      this.journal.flush();
      this.journalEnd += n * ENTRY;
    } catch (e) {
      this.log('[store] journal write failed: ' + e.message);
    }
  }

  stats() {
    return { kind: this.kind, bytes: this.storedBytes, blocks: this.index.size, persistent: true, full: this.full, overflowBytes: this.overflow.bytes };
  }

  close() {
    this.flush();
    try {
      this.data.close();
      this.journal.close();
    } catch {}
    this.overflow.close();
    this.release?.();
    this.release = null;
  }
}

// Opens the store in OPFS (dedicated workers only: sync access handles). Resolves to null when it cannot: no OPFS,
// another tab holds it (Web Locks), or the handles stay locked.
export async function openOpfsStore({ files, name = files.name, lockTimeoutMs = 2000, log = () => {}, maxBytes, overflowBytes } = {}) {
  if (!globalThis.navigator?.storage?.getDirectory) return null;
  const lockName = 'rangeplay-store:' + name;
  const release = await acquireLock(lockName, lockTimeoutMs);
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

// Deletes the persistent store of `name` (the caller must have closed it).
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
