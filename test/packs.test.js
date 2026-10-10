import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pack } from '../tools/pack.js';
import { IoClient } from '../src/engine.js';
import { FileTable, objectPath } from '../src/shared/manifest.js';
import { loadFiles, makeDataset, opfsStoreAt, readOnThreads, startCore, startServer } from './helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

// A game with what packs are for: hundreds of small files (shaders, scripts), next to a big archive and an empty file.
function gameSizes(n = 400, seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const sizes = { 'big.pak': 2 * 1048576 + 77, 'empty.cfg': 0 };
  for (let i = 0; i < n; i++) sizes[`shaders/s${String(i).padStart(4, '0')}.wgsl`] = 200 + Math.floor(rnd() * 20000);
  const same = randomBytes(3000);
  Object.assign(sizes, { 'a/same.txt': same, 'b/same.txt': same });
  return sizes;
}
const PACKING = { packSmall: 65536, packMax: 262144 };
const shaders = (contents) => Object.keys(contents).filter((n) => n.startsWith('shaders/'));

function check(results, reads, contents, files) {
  results.forEach((r, i) => {
    const [id, off, len] = reads[i];
    const data = contents[files.path(id)];
    const part = data.subarray(Math.min(off, data.length), Math.min(off + len, data.length));
    assert.equal(r.error, null, `read ${i} ${JSON.stringify(reads[i])}: ${r.error}`);
    assert.equal(r.n, part.length, `read ${i} length`);
    assert.equal(r.hash, sha(part), `read ${i} bytes`);
  });
}

// Whole small files, pieces of them, reads running past their ends, and the big archive.
function readsFor(files, contents, n = 300, seed = 9) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const names = Object.keys(contents), reads = [];
  for (let i = 0; i < n; i++) {
    const name = names[Math.floor(rnd() * names.length)], size = contents[name].length, kind = rnd();
    if (kind < 0.5) reads.push([files.id(name), 0, size]);
    else if (kind < 0.8) reads.push([files.id(name), Math.floor(rnd() * Math.max(1, size)), 1 + Math.floor(rnd() * 5000)]);
    else reads.push([files.id(name), Math.max(0, size - 50), 4000]);
  }
  return reads;
}

async function manifestOf(dist) {
  return new FileTable(JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8')));
}

async function objectNames(dist) {
  const out = [];
  for (const d of await readdir(join(dist, 'data'))) for (const f of await readdir(join(dist, 'data', d))) out.push(f);
  return out.sort();
}

test('pack: small files go into packs, each content once; big and empty files keep objects of their own', async () => {
  const ds = await makeDataset(gameSizes(), PACKING);
  try {
    const json = JSON.parse(await readFile(join(ds.dist, 'manifest.json'), 'utf8'));
    assert.equal(json.format, 'rangeplay-manifest@2');
    assert.ok(json.packs.length > 3, 'several packs');
    for (const [, size] of json.packs) assert.ok(size <= PACKING.packMax);
    const files = new FileTable(json);
    const big = files.id('big.pak'), empty = files.id('empty.cfg');
    assert.ok(!files.packed(big) && !files.packed(empty));
    // Small files are packed, except one that would be alone in its pack (it stays an object of its own).
    const loose = shaders(ds.contents).filter((name) => !files.packed(files.id(name)));
    assert.ok(loose.length <= 20, loose.length + ' of 400 shaders were left out of packs');
    for (let i = 0; i < json.packs.length; i++) assert.ok(json.files.filter((f) => f[3] === i).length > 1, 'pack ' + i + ' holds several files');
    const [a, b] = [files.id('a/same.txt'), files.id('b/same.txt')];
    assert.deepEqual([files.sid(a), files.base(a)], [files.sid(b), files.base(b)], 'identical files share their bytes');

    // The host stores the packs and the unpacked files, nothing else.
    const expected = [...json.packs.map(([h]) => h), ...[big, empty, ...loose.map((n) => files.id(n))].map((id) => files.hash(id))].sort();
    assert.deepEqual(await objectNames(ds.dist), expected);
    // Each file's bytes sit in its pack where the manifest says.
    for (const name of [...shaders(ds.contents).slice(0, 50), 'a/same.txt']) {
      const id = files.id(name), sid = files.sid(id);
      const body = await readFile(join(ds.dist, 'data', ...objectPath(files.hash(sid)).split('/')));
      assert.ok(body.subarray(files.base(id), files.base(id) + files.size(id)).equals(ds.contents[name]), name);
    }
    assert.equal(files.downloadBytes(), json.packs.reduce((n, [, size]) => n + size, 0) + files.size(big) + loose.reduce((n, name) => n + ds.contents[name].length, 0));
  } finally {
    await ds.cleanup();
  }
});

test('pack: without --pack-small, or with nothing small enough, manifests stay format 1', async () => {
  const ds = await makeDataset({ 'big.bin': 300000, 'b.bin': 200000 }, { packSmall: 1000 });
  try {
    const json = JSON.parse(await readFile(join(ds.dist, 'manifest.json'), 'utf8'));
    assert.equal(json.format, 'rangeplay-manifest@1');
    assert.equal(json.packs, undefined);
  } finally {
    await ds.cleanup();
  }
});

test('packed files read correct bytes on engine threads, and a second session reads from the cache', async () => {
  const ds = await makeDataset(gameSizes(), PACKING);
  const storeDir = join(ds.dir, 'store');
  await mkdir(storeDir);
  const srv = await startServer(ds.dist);
  try {
    const files = await loadFiles(srv.base);
    const reads = readsFor(files, ds.contents);

    const mem = startCore(files);
    check(await readOnThreads(mem, reads, 4), reads, ds.contents, files);
    mem.core.close();

    const one = startCore(files, { store: opfsStoreAt(storeDir, files) });
    check(await readOnThreads(one, reads, 4), reads, ds.contents, files);
    one.core.close();
    const two = startCore(files, { store: opfsStoreAt(storeDir, files) });
    check(await readOnThreads(two, reads, 4), reads, ds.contents, files);
    // Every read is served from the cache. (Read-ahead may still fetch neighbouring bytes nobody read yet.)
    const s = two.core.snapshot();
    assert.equal(s.readsWaited, 0, 'no read waited for the network');
    assert.ok(s.bytesFetched < files.downloadBytes() / 10, 'at most some read-ahead: ' + s.bytesFetched);
    two.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('boot set over packs: hundreds of small files arrive in a handful of requests', async () => {
  const sizes = gameSizes();
  const ds = await makeDataset(sizes);
  try {
    // The engine touches 300 shaders at start-up, in an order unlike their paths.
    const touched = shaders(ds.contents).slice(0, 300).reverse();
    const bootset = { format: 'rangeplay-bootset@1', files: touched.map((n) => [n, [[0, ds.contents[n].length - 1]]]) };
    const packed = join(ds.dir, 'packed');
    await pack({ src: ds.src, out: packed, name: 'test', packSmall: 65536, packMax: 1048576, order: bootset });

    const requests = {};
    for (const [kind, dist] of [['files', ds.dist], ['packs', packed]]) {
      const srv = await startServer(dist, { latencyMs: 2 });
      try {
        const files = await loadFiles(srv.base);
        const rt = startCore(files);
        const before = srv.server.requests();
        await rt.core.prefetchBootset(bootset);
        requests[kind] = srv.server.requests() - before;
        const reads = touched.map((n) => [files.id(n), 0, ds.contents[n].length]);
        check(await readOnThreads(rt, reads, 2), reads, ds.contents, files);
        assert.equal(rt.core.snapshot().readsWaited, 0, kind + ': every start-up read was prefetched');
        rt.core.close();
      } finally {
        await srv.close();
      }
    }
    assert.ok(requests.files >= 300, 'one request per file without packs: ' + requests.files);
    assert.ok(requests.packs * 10 <= requests.files, `packs: ${requests.packs} requests, files: ${requests.files}`);
  } finally {
    await ds.cleanup();
  }
});

test('a loader walking through packed files in order reads ahead, without a boot set', async () => {
  const ds = await makeDataset(gameSizes(200), { packSmall: 65536, packMax: 1048576 });
  const srv = await startServer(ds.dist, { latencyMs: 2 });
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files);
    const reads = shaders(ds.contents).map((n) => [files.id(n), 0, ds.contents[n].length]);   // path order: pack order
    check(await readOnThreads(rt, reads, 1), reads, ds.contents, files);
    const s = rt.core.snapshot();
    assert.ok(s.readsWaited * 4 < reads.length, `${s.readsWaited} of ${reads.length} reads waited`);
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('hints and background fill work on packed files', async () => {
  const ds = await makeDataset(gameSizes(120), PACKING);
  const srv = await startServer(ds.dist, { latencyMs: 10 });
  try {
    const files = await loadFiles(srv.base);
    const rt = startCore(files);
    const name = shaders(ds.contents)[17], id = files.id(name);
    new IoClient(rt.buffer, 0).hint(id, 100, 1000);
    for (let i = 0; i < 200 && rt.core.snapshot().hintsFetched < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await Promise.all([...rt.core.inflight.values()].map((e) => e.promise.catch(() => {})));
    const hinted = [[id, 100, 1000]];
    check(await readOnThreads(rt, hinted, 1), hinted, ds.contents, files);
    assert.equal(rt.core.snapshot().readsWaited, 0, 'the hinted read did not wait');

    await rt.core.fill(true);
    const s = rt.core.snapshot();
    assert.equal(s.fill.state, 'done');
    assert.equal(s.fill.bytes, files.downloadBytes(), 'every object once');
    const before = srv.server.requests();
    const all = Object.keys(ds.contents).map((n) => [files.id(n), 0, ds.contents[n].length]);
    check(await readOnThreads(rt, all, 4), all, ds.contents, files);
    assert.equal(srv.server.requests(), before, 'everything was installed');
    rt.core.close();
  } finally {
    await srv.close();
    await ds.cleanup();
  }
});

test('pack: an update changes the pack of the file that changed, not the packs after it', async () => {
  const ds = await makeDataset(gameSizes(), PACKING);
  try {
    const objects = async () => (await manifestOf(ds.dist)).objectList().map((o) => o.hash);
    const before = await objects();
    for (const i of [40, 41, 250]) {
      // one shader grows by 3 KB: a new version
      const name = shaders(ds.contents)[i];
      await writeFile(join(ds.src, ...name.split('/')), Buffer.concat([ds.contents[name], randomBytes(3000)]));
      await pack({ src: ds.src, out: ds.dist, name: 'test', ...PACKING });
      const after = await objects();
      const fresh = after.filter((h) => !before.includes(h));
      assert.ok(fresh.length >= 1 && fresh.length <= 2, `shader ${i}: ${fresh.length} of ${after.length} objects changed`);
      before.splice(0, before.length, ...after);
    }
  } finally {
    await ds.cleanup();
  }
});

test('manifest: pack locations are validated', () => {
  const h = 'ab'.repeat(16);
  const base = { format: 'rangeplay-manifest@2', packs: [[h, 100]] };
  assert.ok(new FileTable({ ...base, files: [['a', 60, h, 0, 40]] }));
  assert.throws(() => new FileTable({ ...base, files: [['a', 61, h, 0, 40]] }), /bad pack location/);
  assert.throws(() => new FileTable({ ...base, files: [['a', 10, h, 1, 0]] }), /bad pack location/);
  assert.throws(() => new FileTable({ format: 'rangeplay-manifest@1', files: [['a', 10, h, 0, 0]] }), /bad pack location/);
  assert.throws(() => new FileTable({ format: 'rangeplay-manifest@3', files: [] }), /not a rangeplay manifest/);
});
