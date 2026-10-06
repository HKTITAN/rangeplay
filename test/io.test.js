import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pack } from '../tools/pack.js';
import { IoClient } from '../src/engine.js';
import { MemoryStore } from '../src/io/store-memory.js';
import { loadFiles, makeDataset, opfsStoreAt, readOnThreads, startCore, startServer } from './helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const SIZES = { 'big.bin': 3 * 1048576 + 1234, 'small.txt': 3000, 'sub/odd.bin': 4096 * 7 + 1, 'empty.bin': 0, 'copy.bin': 3000 };

// A deterministic mix of reads: tiny reads at the start of files (tables of contents), scattered reads, long
// sequential scans, reads that run past the end of a file, and reads of the empty file.
function readsFor(files, contents, n = 300, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const names = Object.keys(contents);
  const reads = [];
  for (let i = 0; i < n; i++) {
    const name = names[Math.floor(rnd() * names.length)], id = files.id(name), size = contents[name].length;
    const kind = rnd();
    let off, len;
    if (kind < 0.3) [off, len] = [0, 16 + Math.floor(rnd() * 3000)];
    else if (kind < 0.8) [off, len] = [Math.floor(rnd() * Math.max(1, size)), 1 + Math.floor(rnd() * 200000)];
    else [off, len] = [Math.max(0, size - 100), 5000];
    reads.push([id, off, len]);
  }
  for (let off = 0; off < contents['big.bin'].length; off += 65536) reads.push([files.id('big.bin'), off, 65536]);
  return reads;
}

function expected(contents, files, [id, off, len]) {
  const data = contents[files.path(id)];
  const part = data.subarray(Math.min(off, data.length), Math.min(off + len, data.length));
  return { n: part.length, hash: sha(part) };
}

function check(results, reads, contents, files) {
  results.forEach((r, i) => {
    const e = expected(contents, files, reads[i]);
    assert.equal(r.error, null, `read ${i} ${JSON.stringify(reads[i])}: ${r.error}`);
    assert.equal(r.n, e.n, `read ${i} length`);
    assert.equal(r.hash, e.hash, `read ${i} bytes`);
  });
}

test('pack: content-addressed objects, identical files stored once', async () => {
  const ds = await makeDataset(SIZES);
  try {
    const srv = await startServer(ds.dist);
    const files = await loadFiles(srv.base);
    assert.equal(files.count, 5);
    assert.equal(files.hash(files.id('small.txt')) === files.hash(files.id('copy.bin')), sha(ds.contents['small.txt']) === sha(ds.contents['copy.bin']));
    assert.equal(files.size(files.id('big.bin')), SIZES['big.bin']);
    await srv.close();
  } finally {
    await ds.cleanup();
  }
});

test('engine threads read correct bytes through the memory store', async () => {
  const ds = await makeDataset(SIZES);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files);
    const reads = readsFor(files, ds.contents);
    check(await readOnThreads(rt, reads, 4), reads, ds.contents, files);
    const s = rt.core.snapshot();
    assert.ok(s.reads > 0 && s.bytesFetched > 0);
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('a small memory cache that evicts constantly still returns correct bytes', async () => {
  const ds = await makeDataset(SIZES);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files, { store: new MemoryStore({ files, maxBytes: 256 * 1024 }) });
    const reads = readsFor(files, ds.contents, 200, 7);
    check(await readOnThreads(rt, reads, 6), reads, ds.contents, files);
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('retries: 30% of requests fail with 503, every read still succeeds', async () => {
  const ds = await makeDataset(SIZES);
  const srv = await startServer(ds.dist, { failRate: 0.3 });
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files);
    const reads = readsFor(files, ds.contents, 150, 3);
    check(await readOnThreads(rt, reads, 4), reads, ds.contents, files);
    assert.ok(rt.core.snapshot().retries > 0, 'some requests were retried');
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('persistent store: a second session reads everything without the network', async () => {
  const ds = await makeDataset(SIZES);
  const storeDir = join(ds.dir, 'store');
  await mkdir(storeDir);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const reads = readsFor(files, ds.contents, 200, 11);

    const one = startCore(files, { store: opfsStoreAt(storeDir, files) });
    check(await readOnThreads(one, reads, 4), reads, ds.contents, files);
    assert.ok(one.core.snapshot().bytesFetched > 0);
    one.core.close();

    const two = startCore(files, { store: opfsStoreAt(storeDir, files) });
    const before = srv.server.requests();
    check(await readOnThreads(two, reads, 4), reads, ds.contents, files);
    const s = two.core.snapshot();
    assert.equal(srv.server.requests(), before, 'no HTTP requests in the second session');
    assert.equal(s.bytesFetched, 0);
    assert.equal(s.readsWaited, 0);
    two.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('persistent store: after a new version, unchanged files stay cached and changed files are fetched again', async () => {
  const ds = await makeDataset(SIZES);
  const storeDir = join(ds.dir, 'store');
  await mkdir(storeDir);
  let srv = await startServer(ds.dist);
  try {
    let files = await loadFiles(srv.base);
    const one = startCore(files, { store: opfsStoreAt(storeDir, files) });
    const all = Object.keys(ds.contents).map((n) => [files.id(n), 0, ds.contents[n].length]);
    check(await readOnThreads(one, all, 2), all, ds.contents, files);
    one.core.close();
    await srv.close();

    // ship a new version in which only sub/odd.bin changed
    ds.contents['sub/odd.bin'] = randomBytes(5000);
    await writeFile(join(ds.src, 'sub', 'odd.bin'), ds.contents['sub/odd.bin']);
    await pack({ src: ds.src, out: ds.dist, name: 'test' });
    srv = await startServer(ds.dist);
    files = await loadFiles(srv.base);

    const two = startCore(files, { store: opfsStoreAt(storeDir, files) });
    const big = [[files.id('big.bin'), 0, SIZES['big.bin']]];
    check(await readOnThreads(two, big, 1), big, ds.contents, files);
    assert.equal(two.core.snapshot().bytesFetched, 0, 'big.bin did not change: no download');
    const odd = [[files.id('sub/odd.bin'), 0, 5000]];
    check(await readOnThreads(two, odd, 1), odd, ds.contents, files);
    assert.equal(two.core.snapshot().bytesFetched, 5000, 'sub/odd.bin changed: downloaded again');
    two.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('boot set: record a session, replay it, and the reads no longer wait', async () => {
  const ds = await makeDataset(SIZES);
  const srv = await startServer(ds.dist, { latencyMs: 5 });
  try {
    const files = await loadFiles(srv.base);
    const reads = readsFor(files, ds.contents, 60, 5);

    const one = startCore(files);
    one.core.startRecording();
    check(await readOnThreads(one, reads, 2), reads, ds.contents, files);
    const bootset = one.core.takeRecording();
    one.core.close();
    assert.ok(bootset.files.length > 0);

    const two = startCore(files);
    await two.core.prefetchBootset(bootset);
    assert.equal(two.core.snapshot().boot.state, 'done');
    check(await readOnThreads(two, reads, 2), reads, ds.contents, files);
    assert.equal(two.core.snapshot().readsWaited, 0, 'every read was prefetched');
    two.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('hints: an announced read is fetched before the engine asks for it', async () => {
  const ds = await makeDataset(SIZES);
  const srv = await startServer(ds.dist, { latencyMs: 20 });
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files);
    const io = new IoClient(rt.buffer, 0);
    const id = files.id('big.bin');
    io.hint(id, 1048576, 200000);
    io.hint(id, 2097152, 100000, true);
    for (let i = 0; i < 200 && rt.core.snapshot().hintsFetched < 2; i++) await new Promise((r) => setTimeout(r, 5));
    await Promise.all([...rt.core.inflight.values()].map((e) => e.promise.catch(() => {})));
    const reads = [[id, 1048576, 200000], [id, 2097152, 100000]];
    check(await readOnThreads(rt, reads, 1), reads, ds.contents, files);
    const s = rt.core.snapshot();
    assert.equal(s.hints, 2);
    assert.equal(s.readsWaited, 0);
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('background fill installs whole files, then reads need no network', async () => {
  const ds = await makeDataset(SIZES);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files);
    await rt.core.fill(['big.bin', 'sub/odd.bin', 'not-in-the-manifest.bin']);
    const s = rt.core.snapshot();
    assert.equal(s.fill.state, 'done');
    assert.equal(s.fill.done, s.fill.runs);
    assert.equal(s.fill.bytes, SIZES['big.bin'] + SIZES['sub/odd.bin']);
    const before = srv.server.requests();
    const reads = [[files.id('big.bin'), 0, SIZES['big.bin']], [files.id('sub/odd.bin'), 0, SIZES['sub/odd.bin']]];
    check(await readOnThreads(rt, reads, 2), reads, ds.contents, files);
    assert.equal(srv.server.requests(), before);
    assert.equal(rt.core.snapshot().readsWaited, 0);
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('bad requests fail cleanly instead of hanging', async () => {
  const ds = await makeDataset(SIZES);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files);
    const results = await readOnThreads(rt, [[99, 0, 10], [files.id('empty.bin'), 0, 10], [files.id('small.txt'), 999999, 10]], 1);
    assert.match(results[0].error, /bad file id/);
    assert.equal(results[1].n, 0);
    assert.equal(results[2].n, 0);
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});
