// tile-world's streamer thread: takes tile requests from the engine, reads each tile with a blocking read (it waits
// for the network when the tile is not cached; that is what this thread is for) and reports it done.

import { IoClient } from '../../src/engine.js';
import { RecordRing } from '../../src/shared/ring.js';

self.onmessage = ({ data: m }) => {
  const io = IoClient.fromShared(m);
  const req = new RecordRing(m.buffer, m.req), done = new RecordRing(m.buffer, m.done);
  self.postMessage('ready');
  for (;;) {
    const i = req.peekWait();
    const [tile, slot, file, offset] = [req.i32[i], req.i32[i + 1], req.i32[i + 2], req.i32[i + 3]];
    req.release();
    let n;
    try {
      n = io.readSync(file, offset, m.tileBytes, m.stagingAt + slot * m.tileBytes);
    } catch {
      n = -1;
    }
    const o = done.reserveWait();
    done.i32[o] = tile;
    done.i32[o + 1] = slot;
    done.i32[o + 2] = n;
    done.commit();
  }
};
