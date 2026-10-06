import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, parseRange } from '../tools/serve.js';

let dir, server, base;
const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 255));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rangeplay-serve-'));
  await mkdir(join(dir, 'data', 'ab'), { recursive: true });
  await writeFile(join(dir, 'data', 'ab', 'ab' + '0'.repeat(30)), body);
  await writeFile(join(dir, 'index.html'), '<p>hi</p>');
  server = createServer({ root: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), [0, 9]);
  assert.deepEqual(parseRange('bytes=90-', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=-10', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=95-200', 100), [95, 99]);
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('bytes=5-1', 100), null);
});

test('range requests on an object', async () => {
  const url = `${base}/data/ab/ab${'0'.repeat(30)}`;
  const r = await fetch(url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), body.subarray(10, 20));

  const r416 = await fetch(url, { headers: { Range: 'bytes=5000-' } });
  assert.equal(r416.status, 416);
  assert.equal(r416.headers.get('content-range'), 'bytes */1000');

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 1000);
});

test('pages get isolation headers and no-cache; traversal is refused', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const t = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
  assert.ok(t.status === 403 || t.status === 404);
});
