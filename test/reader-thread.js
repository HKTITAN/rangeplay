// An engine thread for the tests: blocking reads through IoClient, reports what arrived.
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { IoClient } from '../src/engine.js';

const { buffer, dst, room, job } = workerData;
const io = new IoClient(buffer, 0);
const u8 = new Uint8Array(buffer);
const out = [];
for (const [i, file, offset, length] of job) {
  try {
    if (length > room) throw new Error('read larger than the thread heap');
    const n = io.readSync(file, offset, length, dst);
    out.push([i, n, createHash('sha256').update(u8.slice(dst, dst + n)).digest('hex'), null]);
  } catch (e) {
    out.push([i, -1, null, e.message]);
  }
}
parentPort.postMessage(out);
