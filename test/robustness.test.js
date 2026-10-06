// Failure modes: misbehaving servers, damaged caches, overflowing hint rings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Fetcher } from '../src/io/fetcher.js';
import { IoClient } from '../src/engine.js';
import { loadFiles, makeDataset, opfsStoreAt, readOnThreads, startCore, startServer } from './helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

// A server whose behaviour per request is decided by `handle(req, res, count)`.
async function rawServer(handle) {
  let count = 0;
  const server = createServer((req, res) => handle(req, res, count++));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/x`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }), count: () => count };
}

const body = randomBytes(10000);
function sendRange(req, res, { cap = Infinity } = {}) {
  const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
  const start = Number(a), end = Math.min(Number(b), body.length - 1, start + cap - 1);
  res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
  res.end(body.subarray(start, end + 1));
}

async function collect(fetcher, url, start, end, size = body.length) {
  const out = Buffer.alloc(end - start + 1);
  const n = await fetcher.range(url, start, end, { size, onChunk: (c, at) => out.set(c, at) });
  return out.subarray(0, n);
}

test('a response that stops sending is abandoned and retried', async () => {
  const srv = await rawServer((req, res, n) => {
    if (n === 0) {
      res.writeHead(206, { 'Content-Range': `bytes 0-9999/${body.length}`, 'Content-Length': 10000 });
      res.write(body.subarray(0, 100));   // ...and then nothing
      return;
    }
    sendRange(req, res);
  });
  try {
    const f = new Fetcher({ cache: null, stallMs: 200, baseDelayMs: 1 });
    const got = await collect(f, srv.url, 0, 9999);
    assert.equal(sha(got), sha(body));
    assert.ok(f.stats.stalls >= 1);   // a loaded machine can stall the retry too
  } finally {
    await srv.close();
  }
});

test('an HTML fallback page is refused, not cached as data', async () => {
  const srv = await rawServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>app</title>');
  });
  try {
    const f = new Fetcher({ cache: null, baseDelayMs: 1 });
    await assert.rejects(collect(f, srv.url, 0, 99), /HTML page/);
    assert.equal(srv.count(), 1, 'not retried');
  } finally {
    await srv.close();
  }
});

test('a 200 or 206 for a file of another size is refused', async () => {
  const srv = await rawServer((req, res, n) => {
    if (n === 0) {
      res.writeHead(200, { 'Content-Length': 5 });
      res.end('hello');
    } else {
      res.writeHead(206, { 'Content-Range': 'bytes 0-4/5', 'Content-Length': 5 });
      res.end('hello');
    }
  });
  try {
    const f = new Fetcher({ cache: null, baseDelayMs: 1 });
    await assert.rejects(collect(f, srv.url, 0, 99), /manifest says 10000/);
    await assert.rejects(collect(f, srv.url, 0, 99), /manifest says 10000/);
  } finally {
    await srv.close();
  }
});

test('a server that caps range sizes is asked for the rest', async () => {
  const srv = await rawServer((req, res) => sendRange(req, res, { cap: 1000 }));
  try {
    const f = new Fetcher({ cache: null, baseDelayMs: 1 });
    const got = await collect(f, srv.url, 500, 7499);
    assert.equal(sha(got), sha(body.subarray(500, 7500)));
    assert.equal(srv.count(), 7);
    assert.equal(f.stats.retries, 0);
  } finally {
    await srv.close();
  }
});

test('Retry-After is capped by maxDelayMs', async () => {
  const srv = await rawServer((req, res, n) => {
    if (n === 0) {
      res.writeHead(503, { 'Retry-After': '300' });
      return res.end();
    }
    sendRange(req, res);
  });
  try {
    const waits = [];
    const f = new Fetcher({ cache: null, maxDelayMs: 50, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    await collect(f, srv.url, 0, 99);
    assert.ok(waits[0] <= 50, 'waited ' + waits[0]);
  } finally {
    await srv.close();
  }
});

test('persistent store: damaged and stale journal entries are dropped for good', async () => {
  const ds = await makeDataset({ 'a.bin': 300000, 'b.bin': 300000 });
  const storeDir = join(ds.dir, 'store');
  await mkdir(storeDir);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const all = ['a.bin', 'b.bin'].map((n) => [files.id(n), 0, ds.contents[n].length]);
    const check = async (rt) => {
      const results = await readOnThreads(rt, all, 2);
      results.forEach((r, i) => assert.equal(r.hash, sha(ds.contents[files.path(all[i][0])]), files.path(all[i][0])));
    };

    const one = startCore(files, { store: opfsStoreAt(storeDir, files) });
    await check(one);
    one.core.close();

    // a torn write: the offset of one entry is garbage
    const journalPath = join(storeDir, 'journal.bin');
    const j = await readFile(journalPath);
    j.writeUInt32LE(0xdeadbeef, 32 + 32 * 3 + 16);
    await writeFile(journalPath, j);
    // a crash between truncating data.bin and the journal (the old order): entries now point past the data
    await truncate(join(storeDir, 'data.bin'), 0);

    const logs = [];
    const two = startCore(files, { store: opfsStoreAt(storeDir, files, { log: (t) => logs.push(t) }) });
    assert.ok(logs.some((l) => /dropping \d+ damaged journal entries/.test(l)), logs.join('\n'));
    await check(two);   // everything fetched again, and data.bin grows past the old entries' offsets
    assert.ok(two.core.snapshot().bytesFetched >= 600000);
    two.core.close();

    const three = startCore(files, { store: opfsStoreAt(storeDir, files) });
    await check(three);   // the old entries must not have come back
    assert.equal(three.core.snapshot().bytesFetched, 0);
    three.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('persistent store: files with identical bytes share cached blocks', async () => {
  const ds = await makeDataset({ 'one.bin': 50000 });
  await writeFile(join(ds.src, 'two.bin'), ds.contents['one.bin']);
  ds.contents['two.bin'] = ds.contents['one.bin'];
  const { pack } = await import('../tools/pack.js');
  await pack({ src: ds.src, out: ds.dist, name: 'test' });
  const storeDir = join(ds.dir, 'store');
  await mkdir(storeDir);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const one = startCore(files, { store: opfsStoreAt(storeDir, files) });
    await readOnThreads(one, [[files.id('two.bin'), 0, 50000]], 1);
    one.core.close();
    const two = startCore(files, { store: opfsStoreAt(storeDir, files) });
    const [r] = await readOnThreads(two, [[files.id('one.bin'), 0, 50000]], 1);
    assert.equal(r.hash, sha(ds.contents['one.bin']));
    assert.equal(two.core.snapshot().bytesFetched, 0);
    two.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('persistent store: when its files fail under it, reads carry on from memory', async () => {
  const ds = await makeDataset({ 'a.bin': 200000 });
  const storeDir = join(ds.dir, 'store');
  await mkdir(storeDir);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const all = [[files.id('a.bin'), 0, 200000]];
    const rt = startCore(files, { store: opfsStoreAt(storeDir, files) });
    await readOnThreads(rt, all, 1);
    // what a browser does when the site's storage is cleared while the game runs
    rt.core.store.data.read = () => { throw new Error('NotFoundError'); };
    const [r] = await readOnThreads(rt, all, 1);
    assert.equal(r.error, null);
    assert.equal(r.hash, sha(ds.contents['a.bin']));
    assert.equal(rt.core.store.kind, 'memory');
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('hint ring: after producers lap the IO worker, hints keep flowing', async () => {
  const ds = await makeDataset({ 'big.bin': 2 * 1048576 });
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files, { hintCap: 8 });
    const io = new IoClient(rt.buffer, 0);
    const id = files.id('big.bin');
    // the IO worker only drains when its loop runs: this burst laps the 8-entry ring several times over
    for (let i = 0; i < 37; i++) io.hint(id, (i % 64) * 4096, 4096, true);
    await new Promise((r) => setTimeout(r, 20));
    const after = rt.core.snapshot();
    assert.ok(after.hints >= 1 && after.hints <= 8, 'served ' + after.hints);
    assert.ok(after.hintsDropped >= 29);
    for (let i = 0; i < 5; i++) {
      io.hint(id, 1048576 + i * 4096, 4096, true);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(rt.core.snapshot().hints, after.hints + 5, 'later hints are all served');
    io.hint(id, 0, 0.5);   // rounds to nothing: ignored, and must not wedge the ring
    io.hint(id, 8192, 4096);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(rt.core.snapshot().hints, after.hints + 6);
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});
