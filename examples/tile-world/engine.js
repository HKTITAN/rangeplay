// tile-world's engine (a module worker started by host.js). Shaped like a native engine's main thread: it starts by
// "mounting" its archives (reading every region's table of contents), then runs a blocking game loop paced by the GPU
// worker. A streamer thread (streamer.js) does the blocking tile reads; this thread never waits for the network.

import { connect } from '../../src/engine.js';
import { RecordRing } from '../../src/shared/ring.js';
import {
  EV_BLUR, EV_KEY_DOWN, EV_KEY_UP, EV_POINTER_DOWN, EV_POINTER_MOVE, EV_POINTER_UP, EV_RESIZE, EV_WHEEL, KEY_CODES, OP_USER,
} from '../../src/shared/layout.js';
import { HEADER_BYTES, REGION_MAGIC, regionPath, tocBytes } from './world.js';

export const OP_UPLOAD = OP_USER;        // [u32 atlas slot][u32 address of the pixels][u32 tile size]
export const OP_DRAW = OP_USER + 1;      // [f32 view w][f32 view h][u32 count][u32 0] then count x INSTANCE_BYTES
const INSTANCE_BYTES = 20;               // [f32 x][f32 y][f32 size][i32 atlas slot or -1][u32 rgba]
const ATLAS_SLOTS = 1024;                // 4096 x 4096 atlas of 128-pixel tiles
const STAGING = 48;                      // tiles in flight between the streamer and the GPU

const t0 = performance.now();
const rt = await connect({ heapBytes: 16 * 1048576, ioSlots: 4, hintCap: 1024 });
const { io, files, heap, gpu, input } = rt;
const u8 = new Uint8Array(rt.buffer), dv = new DataView(rt.buffer);

// ---- boot: read the world description, the minimap, and every archive's table of contents ----
function readAll(path) {
  const id = files.id(path);
  if (id < 0) throw new Error('missing ' + path);
  const n = files.size(id), at = heap.alloc(n);
  const got = io.readSync(id, 0, n, at);
  if (got !== n) throw new Error(path + ': short read');
  return at;
}
const worldAt = readAll('world.json');
const world = JSON.parse(new TextDecoder().decode(u8.slice(worldAt, worldAt + files.size(files.id('world.json')))));
const { tileSize: TILE, regionTiles: RT, regions: REGIONS } = world;
const W = REGIONS * RT;
const minimapAt = readAll('minimap.bin');
const tileBytes = TILE * TILE * 4;

const tileFile = new Int32Array(W * W), tileOffset = new Float64Array(W * W);
const tocAt = heap.alloc(tocBytes(RT));
for (let ry = 0; ry < REGIONS; ry++) {
  for (let rx = 0; rx < REGIONS; rx++) {
    const id = files.id(regionPath(rx, ry));
    io.readSync(id, 0, tocBytes(RT), tocAt);
    if (dv.getUint32(tocAt, true) !== REGION_MAGIC) throw new Error('bad region ' + regionPath(rx, ry));
    for (let k = 0; k < RT * RT; k++) {
      const t = (ry * RT + Math.floor(k / RT)) * W + rx * RT + (k % RT);
      tileFile[t] = id;
      tileOffset[t] = dv.getUint32(tocAt + HEADER_BYTES + k * 8, true);
    }
  }
}
const bootMs = performance.now() - t0;

// ---- the streamer thread and its queues: requests [tile, staging slot, file, offset], completions [tile, slot, bytes] ----
const reqRing = RecordRing.init(rt.buffer, heap.alloc(RecordRing.bytes(64, 4), 8), 64, 4);
const doneRing = RecordRing.init(rt.buffer, heap.alloc(RecordRing.bytes(64, 3), 8), 64, 3);
const stagingAt = heap.alloc(STAGING * tileBytes, 64);
const streamer = new Worker(new URL('./streamer.js', import.meta.url), { type: 'module', name: 'streamer' });
streamer.postMessage({ ...rt.shared(), req: reqRing.h.byteOffset, done: doneRing.h.byteOffset, stagingAt, tileBytes });
// Wait until it runs: from now on this thread blocks, and a worker started from a blocked worker may never load.
await new Promise((resolve) => (streamer.onmessage = resolve));

// ---- state ----
const TILE_NONE = 0, TILE_REQUESTED = 1, TILE_RESIDENT = 2;
const tileState = new Uint8Array(W * W), tileSlot = new Int32Array(W * W).fill(-1);
const slotTile = new Int32Array(ATLAS_SLOTS).fill(-1), slotUsed = new Float64Array(ATLAS_SLOTS);
const freeSlots = Array.from({ length: ATLAS_SLOTS }, (_, i) => ATLAS_SLOTS - 1 - i);
const freeStaging = Array.from({ length: STAGING }, (_, i) => i);
const stagingRelease = [];   // [slot, frame after which the GPU worker has consumed it]
const hinted = new Map();    // tile -> frame it was hinted

const keys = new Set();
let view = { w: 800, h: 600 }, cam = { x: world.spawn[0], y: world.spawn[1], zoom: 128 };
let vel = { x: 0, y: 0 }, drag = null, autopilot = rt.options.autopilot !== false, frame = 0, apT = 0;
let last = performance.now(), fpsFrames = 0, fpsT = last, fps = 0, uploads = 0;
const has = (code) => keys.has(KEY_CODES.indexOf(code));

function handleInput() {
  input.poll((type, code, x, y, dx, dy) => {
    if (type === EV_KEY_DOWN) {
      keys.add(code);
      if (KEY_CODES[code] === 'KeyF') autopilot = !autopilot;
      else if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(KEY_CODES[code])) autopilot = false;
    } else if (type === EV_KEY_UP) keys.delete(code);
    else if (type === EV_BLUR) keys.clear();
    else if (type === EV_RESIZE && x >= 1 && y >= 1) view = { w: x, h: y };
    else if (type === EV_POINTER_DOWN) { drag = { x, y }; autopilot = false; }
    else if (type === EV_POINTER_UP) drag = null;
    else if (type === EV_POINTER_MOVE && drag) {
      cam.x -= (x - drag.x) / cam.zoom;
      cam.y -= (y - drag.y) / cam.zoom;
      drag = { x, y };
    } else if (type === EV_WHEEL) setZoom(cam.zoom * Math.exp(-dy * 0.0015));
  });
}

function setZoom(z) {
  // never more tiles on screen than atlas slots (with room for the next ones)
  const minZoom = Math.sqrt((view.w * view.h) / (ATLAS_SLOTS * 0.7));
  cam.zoom = Math.min(256, Math.max(Math.max(32, minZoom), z));
}

function update(dt) {
  if (autopilot) {
    // a slow loop around the island, so tiles keep streaming in
    apT += dt * 0.045;
    const tx = W / 2 + Math.cos(apT) * W * 0.3, ty = W / 2 + Math.sin(apT * 1.7) * W * 0.22;
    vel = { x: (tx - cam.x) * 0.9, y: (ty - cam.y) * 0.9 };
  } else {
    const speed = 7 * (128 / cam.zoom);
    const ix = (has('KeyD') || has('ArrowRight') ? 1 : 0) - (has('KeyA') || has('ArrowLeft') ? 1 : 0);
    const iy = (has('KeyS') || has('ArrowDown') ? 1 : 0) - (has('KeyW') || has('ArrowUp') ? 1 : 0);
    vel = { x: ix * speed, y: iy * speed };
    if (has('KeyQ') || has('Minus')) setZoom(cam.zoom * (1 - dt * 1.5));
    if (has('KeyE') || has('Equal')) setZoom(cam.zoom * (1 + dt * 1.5));
  }
  cam.x = Math.min(W, Math.max(0, cam.x + vel.x * dt));
  cam.y = Math.min(W, Math.max(0, cam.y + vel.y * dt));
  setZoom(cam.zoom);
}

function visibleRange(cx, cy, margin = 0) {
  const hw = view.w / 2 / cam.zoom + margin, hh = view.h / 2 / cam.zoom + margin;
  return [Math.max(0, Math.floor(cx - hw)), Math.max(0, Math.floor(cy - hh)), Math.min(W - 1, Math.floor(cx + hw)), Math.min(W - 1, Math.floor(cy + hh))];
}

function takeAtlasSlot(visible) {
  if (freeSlots.length) return freeSlots.pop();
  let best = -1;
  for (let s = 0; s < ATLAS_SLOTS; s++) if (!visible.has(slotTile[s]) && (best < 0 || slotUsed[s] < slotUsed[best])) best = s;
  if (best < 0) return -1;
  const old = slotTile[best];
  tileState[old] = TILE_NONE;
  tileSlot[old] = -1;
  return best;
}

function request(t) {
  if (!freeStaging.length) return false;
  const at = reqRing.reserve();
  if (at < 0) return false;
  const slot = freeStaging.pop();
  reqRing.i32[at] = t;
  reqRing.i32[at + 1] = slot;
  reqRing.i32[at + 2] = tileFile[t];
  reqRing.i32[at + 3] = tileOffset[t];
  reqRing.commit();
  // The streamer reads its queue one tile at a time; announcing every queued read lets the IO worker fetch them all
  // at once, so the streamer mostly finds its tiles already there.
  io.hint(tileFile[t], tileOffset[t], tileBytes);
  tileState[t] = TILE_REQUESTED;
  hinted.delete(t);
  return true;
}

function frameStep() {
  gpu.beginFrame();   // blocks while two frames are queued: the loop runs at the display's rate
  const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame++;
  handleInput();
  update(dt);

  const [x0, y0, x1, y1] = visibleRange(cam.x, cam.y);
  const visible = new Set();
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) visible.add(ty * W + tx);

  // streamed tiles: upload to the atlas, release staging slots the GPU worker has consumed
  for (let i = doneRing.peek(); i >= 0; i = doneRing.peek()) {
    const [t, staging, n] = [doneRing.i32[i], doneRing.i32[i + 1], doneRing.i32[i + 2]];
    doneRing.release();
    const slot = n === tileBytes ? takeAtlasSlot(visible) : -1;
    if (slot < 0) {
      tileState[t] = TILE_NONE;
      freeStaging.push(staging);
      continue;
    }
    const p = gpu.begin(OP_UPLOAD, 12);
    dv.setUint32(p, slot, true);
    dv.setUint32(p + 4, stagingAt + staging * tileBytes, true);
    dv.setUint32(p + 8, TILE, true);
    gpu.commit();
    uploads++;
    slotTile[slot] = t;
    slotUsed[slot] = frame;
    tileSlot[t] = slot;
    tileState[t] = TILE_RESIDENT;
    stagingRelease.push([staging, gpu.ring.framesSubmitted() + 1]);
  }
  const done = gpu.framesDone();
  for (let i = stagingRelease.length - 1; i >= 0; i--) {
    if (done >= stagingRelease[i][1]) {
      freeStaging.push(stagingRelease[i][0]);
      stagingRelease.splice(i, 1);
    }
  }

  // request what is on screen, nearest the centre first
  const want = [...visible].filter((t) => tileState[t] === TILE_NONE);
  want.sort((a, b) => dist2(a) - dist2(b));
  for (const t of want) if (!request(t)) break;

  // hint what will be on screen in a second and a half, so it downloads before it is needed
  const [h0, k0, h1, k1] = visibleRange(cam.x + vel.x * 1.5, cam.y + vel.y * 1.5, 1);
  let hints = 0;
  for (let ty = k0; ty <= k1 && hints < 48; ty++) {
    for (let tx = h0; tx <= h1 && hints < 48; tx++) {
      const t = ty * W + tx;
      if (tileState[t] !== TILE_NONE || frame - (hinted.get(t) ?? -1e9) < 120) continue;
      io.hint(tileFile[t], tileOffset[t], tileBytes, !visible.has(t));
      hinted.set(t, frame);
      hints++;
    }
  }
  if (hinted.size > 4096) hinted.clear();

  // draw: every visible tile, from the atlas or as its minimap colour while it streams in
  const count = visible.size;
  const p = gpu.begin(OP_DRAW, 16 + count * INSTANCE_BYTES);
  dv.setFloat32(p, view.w, true);
  dv.setFloat32(p + 4, view.h, true);
  dv.setUint32(p + 8, count, true);
  dv.setUint32(p + 12, 0, true);
  let o = p + 16;
  for (const t of visible) {
    const tx = t % W, ty = Math.floor(t / W);
    dv.setFloat32(o, (tx - cam.x) * cam.zoom + view.w / 2, true);
    dv.setFloat32(o + 4, (ty - cam.y) * cam.zoom + view.h / 2, true);
    dv.setFloat32(o + 8, cam.zoom, true);
    const slot = tileState[t] === TILE_RESIDENT ? tileSlot[t] : -1;
    dv.setInt32(o + 12, slot, true);
    if (slot >= 0) slotUsed[slot] = frame;
    u8.copyWithin(o + 16, minimapAt + t * 4, minimapAt + t * 4 + 4);
    o += INSTANCE_BYTES;
  }
  gpu.commit();
  gpu.endFrame();

  fpsFrames++;
  if (now - fpsT > 500) {
    fps = (fpsFrames * 1000) / (now - fpsT);
    fpsFrames = 0;
    fpsT = now;
    let resident = 0;
    for (const t of visible) if (tileState[t] === TILE_RESIDENT) resident++;
    rt.post({ fps, bootMs, visible: visible.size, resident, streaming: STAGING - freeStaging.length - stagingRelease.length, uploads, autopilot, zoom: cam.zoom });
  }
}

function dist2(t) {
  const dx = (t % W) + 0.5 - cam.x, dy = Math.floor(t / W) + 0.5 - cam.y;
  return dx * dx + dy * dy;
}

setZoom(cam.zoom);
for (;;) frameStep();
