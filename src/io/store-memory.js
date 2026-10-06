// Block store in memory: the fallback when OPFS is missing or another tab holds the persistent store. Runs (one fetch's
// worth of consecutive blocks) are kept whole and evicted least recently used first.

export class MemoryStore {
  constructor({ files, maxBytes = 256 * 1048576 }) {
    this.files = files;
    this.bs = files.blockSize;
    this.maxBytes = maxBytes;
    this.kind = 'memory';
    this.index = new Map();   // block key -> run
    this.runs = new Map();    // run -> true, oldest first
    this.pins = new Map();    // block key -> number of reads waiting to copy it
    this.bytes = 0;
  }

  // A read pins its blocks from the moment it waits for them until it has copied them, so that other fetches landing
  // meanwhile cannot evict them. Pinned runs may push the cache over maxBytes for a while.
  pin(id, first, last) {
    for (let b = first; b <= last; b++) {
      const k = this.key(id, b);
      this.pins.set(k, (this.pins.get(k) || 0) + 1);
    }
  }

  unpin(id, first, last) {
    for (let b = first; b <= last; b++) {
      const k = this.key(id, b), n = (this.pins.get(k) || 1) - 1;
      if (n) this.pins.set(k, n);
      else this.pins.delete(k);
    }
  }

  #pinned(run) {
    if (!this.pins.size) return false;
    const n = Math.ceil(run.bytes / this.bs);
    for (let k = 0; k < n; k++) if (this.pins.has(this.key(run.id, run.firstBlock + k))) return true;
    return false;
  }

  key(id, block) {
    return id * 4294967296 + block;
  }

  has(id, block) {
    return this.index.has(this.key(id, block));
  }

  beginRun(id, firstBlock, bytes) {
    const buf = new Uint8Array(bytes);
    return { id, firstBlock, bytes, buf, write: (chunk, at) => buf.set(chunk, at) };
  }

  endRun(run) {
    const n = Math.ceil(run.bytes / this.bs);
    for (let k = 0; k < n; k++) this.index.set(this.key(run.id, run.firstBlock + k), run);
    this.runs.set(run, true);
    this.bytes += run.bytes;
    for (const old of this.runs.keys()) {
      if (this.bytes <= this.maxBytes) break;
      if (old !== run && !this.#pinned(old)) this.#evict(old);
    }
  }

  // Copies [offset, offset + length) of file id to dst[dstOffset...]. Returns length, or -1 if a block is missing.
  read(id, offset, length, dst, dstOffset) {
    const bs = this.bs;
    for (let b = Math.floor(offset / bs), last = Math.floor((offset + length - 1) / bs); b <= last; b++) {
      if (!this.index.has(this.key(id, b))) return -1;
    }
    let done = 0;
    while (done < length) {
      const pos = offset + done;
      const run = this.index.get(this.key(id, Math.floor(pos / bs)));
      const inRun = pos - run.firstBlock * bs;
      const n = Math.min(length - done, run.bytes - inRun);
      dst.set(run.buf.subarray(inRun, inRun + n), dstOffset + done);
      done += n;
      this.runs.delete(run);
      this.runs.set(run, true);
    }
    return length;
  }

  #evict(run) {
    this.runs.delete(run);
    this.bytes -= run.bytes;
    const n = Math.ceil(run.bytes / this.bs);
    for (let k = 0; k < n; k++) {
      const key = this.key(run.id, run.firstBlock + k);
      if (this.index.get(key) === run) this.index.delete(key);
    }
  }

  stats() {
    return { kind: this.kind, bytes: this.bytes, blocks: this.index.size, persistent: false };
  }

  flush() {}

  close() {
    this.index.clear();
    this.runs.clear();
    this.bytes = 0;
  }
}
