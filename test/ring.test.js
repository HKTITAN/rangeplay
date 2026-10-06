import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { CommandRing, RecordRing } from '../src/shared/ring.js';
import { OP_USER } from '../src/shared/layout.js';

test('command ring: records come out in order, across many wraps', () => {
  const buf = new SharedArrayBuffer(CommandRing.bytes(256) + 64);
  const ring = CommandRing.init(buf, 64, 256);
  const out = [];
  let next = 0;
  for (let round = 0; round < 500; round++) {
    // write a few records of varying size until the ring is full, then drain
    for (;;) {
      const len = (next * 7) % 40;
      const at = ring.reserve(OP_USER + (next % 5), len, false);
      if (at < 0) break;
      for (let i = 0; i < len; i++) ring.u8[at + i] = (next + i) & 255;
      ring.commit();
      next++;
    }
    ring.drain((op, at, len) => {
      const n = out.length;
      assert.equal(op, OP_USER + (n % 5));
      assert.equal(len, (n * 7) % 40);
      for (let i = 0; i < len; i++) assert.equal(ring.u8[at + i], (n + i) & 255);
      out.push(n);
    });
  }
  assert.equal(out.length, next);
  assert.ok(next > 2000);
});

test('command ring: a blocked producer resumes when a consumer drains (two threads)', async () => {
  const buf = new SharedArrayBuffer(CommandRing.bytes(1024));
  CommandRing.init(buf, 0, 1024);
  const N = 20000;
  const producer = new Worker(`
    const { workerData } = require('node:worker_threads');
    import(workerData.ring).then(({ CommandRing }) => {
      const ring = new CommandRing(workerData.buf, 0);
      for (let i = 0; i < workerData.N; i++) {
        const at = ring.reserve(16, 8);
        ring.dv.setUint32(at, i, true);
        ring.dv.setUint32(at + 4, i ^ 0x5a5a5a5a, true);
        ring.commit();
      }
    });
  `, { eval: true, workerData: { buf, N, ring: new URL('../src/shared/ring.js', import.meta.url).href } });
  const ring = new CommandRing(buf, 0);
  let seen = 0;
  while (seen < N) {
    ring.drain((op, at) => {
      assert.equal(ring.dv.getUint32(at, true), seen);
      assert.equal(ring.dv.getUint32(at + 4, true), (seen ^ 0x5a5a5a5a) >>> 0);
      seen++;
    });
    await new Promise((r) => setImmediate(r));
  }
  await producer.terminate();
  assert.equal(seen, N);
});

test('record ring: drops when full, keeps order', () => {
  const buf = new SharedArrayBuffer(RecordRing.bytes(8, 4));
  const ring = RecordRing.init(buf, 0, 8, 4);
  for (let i = 0; i < 10; i++) {
    const at = ring.reserve();
    if (at < 0) continue;
    ring.i32[at] = i;
    ring.f32[at + 1] = i / 2;
    ring.commit();
  }
  assert.equal(ring.dropped(), 2);
  assert.equal(ring.size(), 8);
  for (let i = 0; i < 8; i++) {
    const at = ring.peek();
    assert.equal(ring.i32[at], i);
    assert.equal(ring.f32[at + 1], i / 2);
    ring.release();
  }
  assert.equal(ring.peek(), -1);
});

test('audio ring: frames come out in order across wraps; underruns and the level meter are counted', async () => {
  const { AudioRing } = await import('../src/shared/ring.js');
  const buf = new SharedArrayBuffer(AudioRing.bytes(64, 2) + 8);
  const ring = AudioRing.init(buf, 8, 64, 2, 48000);
  const L = new Float32Array(48), R = new Float32Array(48);
  let next = 0, expect = 0;
  for (let round = 0; round < 50; round++) {
    const frames = new Float32Array(2 * 40);
    for (let i = 0; i < 40; i++) {
      frames[i * 2] = ((next + i) % 100) / 100;
      frames[i * 2 + 1] = -((next + i) % 100) / 100;
    }
    next += ring.write(frames);
    const n = ring.readPlanar([L, R], 48);
    for (let i = 0; i < n; i++, expect++) {
      assert.equal(L[i], Math.fround((expect % 100) / 100));
      assert.equal(R[i], Math.fround(-(expect % 100) / 100));
    }
    for (let i = n; i < 48; i++) assert.equal(L[i], 0);
  }
  assert.equal(expect, next);
  const s = ring.stats();
  assert.ok(s.underruns > 0, 'the reader asked for more than was written');
  assert.ok(s.peak > 0.9 && s.peak <= 1);
  assert.equal(ring.stats().peak, 0, 'stats() resets the meter');
});
