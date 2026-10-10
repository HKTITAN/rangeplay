import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { FileTable, objectPath } from '../src/shared/manifest.js';
import { doctor } from '../tools/doctor.js';
import { verifyDir, verifyUrl } from '../tools/verify.js';
import { makeDataset, startServer } from './helpers.js';

const run = promisify(execFile);
const cli = (...args) => run(process.execPath, [fileURLToPath(new URL('../tools/cli.js', import.meta.url)), ...args]);

function sizes() {
  const s = { 'big.pak': 1048576 + 333, 'empty.cfg': 0, 'readme.txt': 70000 };
  for (let i = 0; i < 60; i++) s[`scripts/s${i}.lua`] = 100 + i * 37;
  return s;
}
const PACKING = { packSmall: 4096, packMax: 16384 };

async function manifestOf(dist) {
  return new FileTable(JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8')));
}
const objectFile = (dist, hash) => join(dist, 'data', ...objectPath(hash).split('/'));

test('verify: a good dist passes; a damaged, a truncated and a missing object are reported', async () => {
  const ds = await makeDataset(sizes(), PACKING);
  try {
    const files = await manifestOf(ds.dist);
    let r = await verifyDir({ dist: ds.dist });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.objects, files.objectList().length);

    const [pk, big, readme] = [files.objectList().find((o) => o.pack >= 0), files.sid(files.id('big.pak')), files.sid(files.id('readme.txt'))];
    const body = await readFile(objectFile(ds.dist, pk.hash));
    body[10] ^= 0xff;
    await writeFile(objectFile(ds.dist, pk.hash), body);
    await writeFile(objectFile(ds.dist, files.hash(big)), (await readFile(objectFile(ds.dist, files.hash(big)))).subarray(0, 1000));
    await rm(objectFile(ds.dist, files.hash(readme)));
    await mkdir(join(ds.dist, 'data', 'ff'), { recursive: true });
    await writeFile(join(ds.dist, 'data', 'ff', 'f'.repeat(32)), 'from an old version');
    r = await verifyDir({ dist: ds.dist });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, [files.hash(readme)]);
    assert.equal(r.corrupt.length, 2);
    assert.ok(r.corrupt.some((c) => c.startsWith(pk.hash)) && r.corrupt.some((c) => c.includes('1000 bytes')));
    assert.equal(r.unused, 1);
  } finally {
    await ds.cleanup();
  }
});

test('verify over HTTP downloads every object once and checks it', async () => {
  const ds = await makeDataset(sizes(), PACKING);
  const srv = await startServer(ds.dist, { failRate: 0.2 });
  try {
    const files = await manifestOf(ds.dist);
    const r = await verifyUrl({ manifestUrl: srv.base + 'manifest.json' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.bytes, files.downloadBytes());
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('mirror: a verified copy, resumed after an interruption, with the manifest written last', async () => {
  const ds = await makeDataset(sizes(), PACKING);
  await writeFile(join(ds.dist, 'bootset.json'), JSON.stringify({ format: 'rangeplay-bootset@1', files: [['readme.txt', [[0, 99]]]] }));
  const srv = await startServer(ds.dist);
  const out = join(ds.dir, 'mirror');
  try {
    const files = await manifestOf(ds.dist);
    // An earlier run stopped half way through big.pak, and left a damaged partial copy of readme.txt.
    const big = files.hash(files.sid(files.id('big.pak'))), readme = files.hash(files.sid(files.id('readme.txt')));
    await mkdir(join(objectFile(out, big), '..'), { recursive: true });
    await mkdir(join(objectFile(out, readme), '..'), { recursive: true });
    await writeFile(objectFile(out, big) + '.partial', (await readFile(objectFile(ds.dist, big))).subarray(0, 600000));
    await writeFile(objectFile(out, readme) + '.partial', Buffer.alloc(5000, 7));

    const r = await verifyUrl({ manifestUrl: srv.base + 'manifest.json', out });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.bytes < files.downloadBytes(), 'the partial big.pak was resumed, not downloaded again');
    assert.equal(r.bootset, true);
    assert.ok((await verifyDir({ dist: out })).ok);
    const copy = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    assert.equal(copy.version, files.version);
    assert.equal(copy.dataPath, 'data/');

    // A second run finds everything in place.
    const again = await verifyUrl({ manifestUrl: srv.base + 'manifest.json', out });
    assert.equal(again.skipped, again.objects);
    assert.equal(again.bytes, 0);
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('mirror: an object that is missing on the host leaves no manifest behind', async () => {
  const ds = await makeDataset(sizes(), PACKING);
  const files = await manifestOf(ds.dist);
  await rm(objectFile(ds.dist, files.hash(files.sid(files.id('readme.txt')))));
  const srv = await startServer(ds.dist);
  const out = join(ds.dir, 'mirror');
  try {
    const r = await verifyUrl({ manifestUrl: srv.base + 'manifest.json', out });
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    await assert.rejects(readFile(join(out, 'manifest.json')));
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('doctor: a well-configured host passes', async () => {
  const ds = await makeDataset(sizes(), PACKING);
  await writeFile(join(ds.dist, 'index.html'), '<!doctype html><title>game</title>');
  const srv = await startServer(ds.dist);
  try {
    const r = await doctor({ url: srv.base });
    const fails = r.checks.filter((c) => c.level === 'fail');
    assert.deepEqual(fails, []);
    assert.ok(r.ok);
    assert.ok(r.checks.some((c) => /object bytes match/.test(c.what)));
    assert.ok(r.checks.some((c) => c.level === 'note' && /no boot set/.test(c.what)));
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

// A host that gets everything wrong: no isolation headers, no ranges, an HTML fallback for missing paths, compressed
// objects, cached manifest.
function badHost(dist, { ranges = false, gzip = false, fallback = false } = {}) {
  const server = createHttpServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
    let body;
    try {
      body = await readFile(join(dist, path));
    } catch {
      if (fallback) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><div id=app></div>');
      return res.writeHead(404).end();
    }
    if (path.endsWith('.json')) return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' }).end(body);
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (ranges && m) {
      const part = body.subarray(Number(m[1]), Number(m[2]) + 1);
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${m[1]}-${m[2]}/${body.length}` };
      if (gzip) return res.writeHead(206, { ...headers, 'Content-Encoding': 'gzip' }).end(gzipSync(part));
      return res.writeHead(206, headers).end(part);
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)),
  })));
}

test('doctor: names what a misconfigured host gets wrong', async () => {
  const ds = await makeDataset(sizes(), PACKING);
  try {
    const host = await badHost(ds.dist);
    try {
      const r = await doctor({ url: host.base });
      const said = r.checks.map((c) => c.level + ': ' + c.what).join('\n');
      assert.equal(r.ok, false);
      assert.match(said, /fail: Cross-Origin-Opener-Policy is missing/);
      assert.match(said, /fail: Cross-Origin-Embedder-Policy is missing/);
      assert.match(said, /fail: the host ignores Range/);
      assert.match(said, /warn: manifest is cached for long/);
    } finally {
      await host.close();
    }

    const gz = await badHost(ds.dist, { ranges: true, gzip: true });
    try {
      const said = (await doctor({ url: gz.base + 'manifest.json' })).checks.map((c) => c.level + ': ' + c.what).join('\n');
      assert.match(said, /fail: objects are compressed on the fly/);
    } finally {
      await gz.close();
    }

    // The objects were never uploaded, and a single-page-app fallback answers for them.
    const files = await manifestOf(ds.dist);
    for (const o of files.objectList()) await rm(objectFile(ds.dist, o.hash), { force: true });
    const spa = await badHost(ds.dist, { ranges: true, fallback: true });
    try {
      const said = (await doctor({ url: spa.base + 'manifest.json' })).checks.map((c) => c.level + ': ' + c.what).join('\n');
      assert.match(said, /fail: objects answer with an HTML page/);
    } finally {
      await spa.close();
    }
  } finally {
    await ds.cleanup();
  }
});

test('cli: pack --pack-small, inspect, verify', async () => {
  const ds = await makeDataset(sizes());
  try {
    const out = join(ds.dir, 'packed');
    const p = await cli('pack', ds.src, '--out', out, '--pack-small', '4k', '--pack-max', '16KiB');
    assert.match(p.stdout, /small files in \d+ packs/);
    const i = await cli('inspect', join(out, 'manifest.json'));
    assert.match(i.stdout, /served as \d+ objects/);
    const v = await cli('verify', out);
    assert.match(v.stdout, /verified (\d+) of \1 objects/);
    const sum = createHash('sha256').update(await readFile(join(out, 'manifest.json'))).digest('hex');
    await cli('pack', ds.src, '--out', out, '--pack-small', '4096', '--pack-max', '16384');
    assert.equal(createHash('sha256').update(await readFile(join(out, 'manifest.json'))).digest('hex'), sum, 'sizes parse the same either way');
    await assert.rejects(cli('pack', ds.src, '--out', out, '--pack-small', 'lots'), /not a size/);
  } finally {
    await ds.cleanup();
  }
});
