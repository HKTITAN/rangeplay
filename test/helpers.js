// Test helpers: a packed data set served over HTTP, an IoCore attached to shared memory, engine threads that read.
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pack } from '../tools/pack.js';
import { createServer } from '../tools/serve.js';
import { FileTable } from '../src/shared/manifest.js';
import { IoCore } from '../src/io/core.js';
import { Fetcher } from '../src/io/fetcher.js';
import { MemoryStore } from '../src/io/store-memory.js';
import { OpfsStore } from '../src/io/store-opfs.js';
import { initIoControl, ioControlBytes } from '../src/shared/layout.js';

// FileSystemSyncAccessHandle on a Node file, enough for OpfsStore.
export class NodeHandle {
  constructor(path) {
    this.fd = openSync(path, existsSync(path) ? 'r+' : 'w+');
  }
  read(view, { at }) { return readSync(this.fd, view, 0, view.byteLength, at); }
  write(view, { at }) { return writeSync(this.fd, view, 0, view.byteLength, at); }
  getSize() { return fstatSync(this.fd).size; }
  truncate(n) { ftruncateSync(this.fd, n); }
  flush() { fsyncSync(this.fd); }
  close() { closeSync(this.fd); }
}

export async function makeDataset(sizes, packOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rangeplay-'));
  const src = join(dir, 'src'), dist = join(dir, 'dist');
  const contents = {};
  for (const [name, size] of Object.entries(sizes)) {
    // a Buffer stands for itself (identical contents), a number for that many random bytes
    contents[name] = typeof size === 'number' ? randomBytes(size) : size;
    const path = join(src, ...name.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents[name]);
  }
  await pack({ src, out: dist, name: 'test', ...packOptions });
  return { dir, src, dist, contents, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function startServer(root, opts = {}) {
  const server = createServer({ root, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

export async function loadFiles(base) {
  const url = base + 'manifest.json';
  return new FileTable(await (await fetch(url)).json(), url);
}

export function opfsStoreAt(dir, files, opts = {}) {
  return new OpfsStore({ files, data: new NodeHandle(join(dir, 'data.bin')), journal: new NodeHandle(join(dir, 'journal.bin')), ...opts });
}

// An IoCore serving a fresh SharedArrayBuffer: [control block][heap].
export function startCore(files, { store, options = {}, slots = 16, hintCap = 256, heapBytes = 16 * 1048576, fetcher } = {}) {
  const ctl = ioControlBytes(slots, hintCap);
  const heapOffset = Math.ceil(ctl / 4096) * 4096;
  const buffer = new SharedArrayBuffer(heapOffset + heapBytes);
  initIoControl(buffer, 0, slots, hintCap);
  const log = [];
  const core = new IoCore({
    files,
    store: store || new MemoryStore({ files }),
    fetcher: fetcher || new Fetcher({ cache: null, baseDelayMs: 2, maxDelayMs: 20 }),
    options,
    log: (t) => log.push(t),
  });
  core.attach(buffer, 0);
  return { core, buffer, heapOffset, heapBytes, log };
}

// Runs `reads` ([file id, offset, length]...) on `threads` engine threads (worker_threads, blocking reads). Each thread
// gets its own heap area; returns, per read, the bytes read and a hex digest of what arrived.
export async function readOnThreads({ buffer, heapOffset, heapBytes }, reads, threads = 4) {
  const per = Math.floor(heapBytes / threads / 4096) * 4096;
  const jobs = Array.from({ length: threads }, (_, t) => reads.map((r, i) => [i, ...r]).filter(([i]) => i % threads === t));
  const results = new Array(reads.length);
  await Promise.all(jobs.map((job, t) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./reader-thread.js', import.meta.url), { workerData: { buffer, dst: heapOffset + t * per, room: per, job } });
    w.on('message', (m) => {
      for (const [i, n, hash, error] of m) results[i] = { n, hash, error };
      resolve();
    });
    w.on('error', reject);
  })));
  return results;
}
