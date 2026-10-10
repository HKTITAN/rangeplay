// The GPU worker (a module worker, started by host.js). It owns the canvas and the WebGPU device and executes the
// commands an engine thread writes into a command ring in shared memory.
//
// Why a worker of its own: WebGPU is asynchronous (adapter and device requests, buffer mapping, error scopes, the
// frame's presentation all need an event loop) and GPU objects cannot be shared between threads, while engine threads
// spend their time inside wasm or blocked in Atomics.wait. The engine only writes bytes; this worker turns them into
// WebGPU calls.
//
// The application supplies the commands: `handlers` is the URL of a module exporting
//   async setup(ctx) -> { [opcode]: (payloadOffset, payloadBytes) => void, frame?: () => void, resize?: (w, h, dpr) => void }
// ctx: { canvas, backend: 'webgpu' | '2d', device, context, format, ctx2d, memory, u8, dv, f32, i32, refresh(), log }
// Opcodes from OP_USER (16) up belong to the application. OP_FRAME_END ends a frame: the worker waits for the next
// animation frame, calls frame() and then counts the frame as done, which is what paces the engine.
//
// A lost device (a driver reset, the GPU process crashing, a laptop switching GPUs) is replaced: the worker requests a
// new one, reconfigures the canvas and calls setup(ctx) again, with ctx.restored counting the restorations. Handlers
// that draw from what each frame brings recover by themselves; handlers that uploaded resources once (textures, meshes)
// must upload them again. A device lost twice within 10 s, or more than 3 times, is reported as an error instead.
//
// Messages from the page:   { type: 'init', canvas, handlers, width, height, dpr, prefer2d, pacing, enginePort }
//                           { type: 'resize', width, height, dpr }, { type: 'debug' }, { type: 'simulate-gpu-loss' }
// Messages from the engine: { type: 'attach', memory, ringOffset }
// To the page:              { type: 'ready', backend, gpu }, { type: 'first-frame' }, { type: 'error', message },
//                           { type: 'log', text }, { type: 'gpu-lost', reason, message }, { type: 'gpu-restored', gpu }

import { CommandRing } from './shared/ring.js';
import { OP_FRAME_END, RING_READ_W, RING_WRITE_W } from './shared/layout.js';

const log = (text) => self.postMessage({ type: 'log', text });
const fail = (message) => self.postMessage({ type: 'error', message });

let ctx = null;
let handlers = null;
let handlerModule = null;
let ring = null;
let size = { width: 1, height: 1, dpr: 1 };
let framesDrawn = 0;
let ready = null;
let restoring = null;   // a promise while a lost device is being replaced
let lastRestore = -Infinity;

// What the page can show when a player reports a black screen: which backend, which GPU, why not WebGPU, what failed.
const gpu = {
  backend: null, adapter: null, fallbackAdapter: false, features: [], limits: null, why2d: null,
  errors: 0, lastError: null, lost: 0, restored: 0,
};

function describe(adapter) {
  const info = adapter.info || {};
  gpu.adapter = { vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '', description: info.description || '' };
  gpu.fallbackAdapter = !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter);
  gpu.features = [...adapter.features].sort();
  const l = adapter.limits;
  gpu.limits = { maxTextureDimension2D: l.maxTextureDimension2D, maxBufferSize: l.maxBufferSize, maxStorageBufferBindingSize: l.maxStorageBufferBindingSize };
}

async function requestDevice() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter (the GPU is blocklisted, or hardware acceleration is off)');
  const device = await adapter.requestDevice();
  describe(adapter);
  device.lost.then((info) => onDeviceLost(device, info));
  device.addEventListener?.('uncapturederror', (e) => {
    // A broken pipeline fails every frame: count the errors, log the first few.
    gpu.errors++;
    gpu.lastError = e.error.message;
    if (gpu.errors <= 5 || gpu.errors % 1000 === 0) log('[gpu] ' + e.error.message + (gpu.errors > 1 ? ' (error ' + gpu.errors + ')' : ''));
  });
  return { adapter, device };
}

function onDeviceLost(device, info) {
  if (info.reason === 'destroyed' || device !== ctx?.device) return;
  gpu.lost++;
  self.postMessage({ type: 'gpu-lost', reason: info.reason, message: info.message });
  if (gpu.lost > 3 || performance.now() - lastRestore < 10000) {
    fail('WebGPU device lost (' + (info.message || info.reason) + '). Reload the page; if it keeps happening, update the graphics driver or close other GPU-heavy tabs.');
    return;
  }
  log('[gpu] device lost (' + (info.message || info.reason) + '): requesting a new one');
  restoring = restore().catch((e) => fail('WebGPU device lost, and a new one could not be created: ' + e.message)).finally(() => (restoring = null));
}

async function restore() {
  let got = null;
  for (let attempt = 0; !got; attempt++) {
    try {
      got = await requestDevice();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));   // the GPU process may still be restarting
    }
  }
  ctx.context.configure({ device: got.device, format: ctx.format, alphaMode: 'opaque' });
  Object.assign(ctx, { adapter: got.adapter, device: got.device, restored: (ctx.restored || 0) + 1 });
  lastRestore = performance.now();
  if (handlers) {   // (before attach() has set the handlers up, it does so with the new device itself)
    handlers = await handlerModule.setup(ctx);
    handlers.resize?.(size.width, size.height, size.dpr);
  }
  gpu.restored++;
  log('[gpu] new device ready (restoration ' + gpu.restored + ')');
  self.postMessage({ type: 'gpu-restored', gpu: { ...gpu } });
}

let pacing = 'raf';
// 'raf' follows the display and stops while the page is hidden (what a game wants); 'timer' runs at ~60 fps regardless.
const nextFrame = () =>
  new Promise((resolve) => (pacing === 'raf' && typeof self.requestAnimationFrame === 'function' ? self.requestAnimationFrame(resolve) : setTimeout(resolve, 16)));

async function init(m) {
  const canvas = m.canvas;
  size = { width: m.width, height: m.height, dpr: m.dpr };
  canvas.width = Math.max(1, Math.round(m.width * m.dpr));
  canvas.height = Math.max(1, Math.round(m.height * m.dpr));
  ctx = { canvas, backend: null, device: null, context: null, format: null, ctx2d: null, restored: 0, log };

  if (m.prefer2d) gpu.why2d = 'the page asked for the 2D canvas (prefer2d)';
  else if (!self.navigator.gpu) gpu.why2d = 'this browser has no WebGPU (navigator.gpu is missing)';
  else {
    try {
      const { adapter, device } = await requestDevice();
      ctx.device = device;   // before anything can fail: a loss while starting is still this device's
      const context = canvas.getContext('webgpu');
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });
      Object.assign(ctx, { backend: 'webgpu', adapter, device, context, format });
    } catch (e) {
      gpu.why2d = e.message;
      ctx.device = null;
      log('[gpu] WebGPU unavailable (' + e.message + '): using the 2D canvas');
    }
  }
  if (!ctx.backend) {
    ctx.ctx2d = canvas.getContext('2d', { alpha: false });
    ctx.backend = '2d';
  }
  gpu.backend = ctx.backend;
}

async function attach(memory, ringOffset) {
  const buffer = memory.buffer ?? memory;
  ring = new CommandRing(buffer, ringOffset);
  const views = () => {
    const b = memory.buffer ?? memory;
    if (ctx.u8?.buffer === b && ctx.u8.length === b.byteLength) return;
    Object.assign(ctx, { memory, u8: new Uint8Array(b), dv: new DataView(b), f32: new Float32Array(b, 0, b.byteLength >> 2), i32: new Int32Array(b, 0, b.byteLength >> 2) });
    ring.setBuffer(b);
  };
  ctx.refresh = views;
  views();
  handlerModule = await import(handlersUrl);
  // A device lost meanwhile: set up again with its replacement.
  let device;
  do {
    if (restoring) await restoring;
    device = ctx.device;
    handlers = await handlerModule.setup(ctx);
  } while (device !== ctx.device);
  handlers.resize?.(size.width, size.height, size.dpr);
  self.postMessage({ type: 'ready', backend: ctx.backend, gpu: { ...gpu } });
  run().catch((e) => fail('GPU worker stopped: ' + e.message));
}

// Executes commands as they arrive; one frame at a time, paced by animation frames.
async function run() {
  for (;;) {
    // While a lost device is replaced, commands wait in the ring (the engine blocks once it is full, or on pacing).
    if (restoring) await restoring;
    let frameEnded = false;
    ctx.refresh();
    ring.drain((op, at, len) => {
      if (op === OP_FRAME_END) {
        frameEnded = true;
        return false;
      }
      const h = handlers[op];
      if (!h) log('[gpu] unknown opcode ' + op);
      else {
        try {
          h(at, len);
        } catch (e) {
          log('[gpu] opcode ' + op + ' failed: ' + e.message);
        }
      }
    });
    if (frameEnded) {
      await nextFrame();
      try {
        handlers.frame?.();
      } catch (e) {
        log('[gpu] frame failed: ' + e.message);
      }
      ring.markDone();
      if (++framesDrawn === 1) self.postMessage({ type: 'first-frame' });
      continue;
    }
    const seen = ring.writeIndex();
    if (ring.pendingRecords()) continue;
    if (typeof Atomics.waitAsync === 'function') {
      const r = Atomics.waitAsync(ring.h, RING_WRITE_W, seen, 1000);
      if (r.async) await r.value;
    } else {
      await new Promise((r) => setTimeout(r, 1));
    }
  }
}

let handlersUrl = null;

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m?.type) {
    case 'init':
      handlersUrl = m.handlers;
      pacing = m.pacing || 'raf';
      m.enginePort.onmessage = (e) => {
        if (e.data?.type !== 'attach') return;
        ready.then(() => attach(e.data.memory, e.data.ringOffset)).catch((err) => fail('GPU attach failed: ' + err.message));
      };
      ready = init(m).catch((e) => {
        fail('GPU init failed: ' + e.message);
        throw e;
      });
      break;
    case 'debug':
      self.postMessage({
        type: 'debug',
        state: ring
          ? { attached: true, write: ring.writeIndex() >>> 0, read: Atomics.load(ring.h, RING_READ_W) >>> 0, framesSubmitted: ring.framesSubmitted(), framesDone: ring.framesDone(), framesDrawn, backend: ctx?.backend, restoring: !!restoring, gpu: { ...gpu } }
          : { attached: false, backend: ctx?.backend ?? null, gpu: { ...gpu } },
      });
      break;
    case 'simulate-gpu-loss':
      // For testing handlers: destroy the device and go through what a real loss does.
      ready?.then(() => {
        const old = ctx.device;
        if (!old) return log('[gpu] no WebGPU device to lose (2D canvas)');
        old.destroy();
        onDeviceLost(old, { reason: 'unknown', message: 'simulated with simulateGpuLoss()' });
      });
      break;
    case 'resize':
      if (!(m.width >= 1 && m.height >= 1)) break;
      size = { width: m.width, height: m.height, dpr: m.dpr };
      ready?.then(() => {
        ctx.canvas.width = Math.max(1, Math.round(m.width * m.dpr));
        ctx.canvas.height = Math.max(1, Math.round(m.height * m.dpr));
        handlers?.resize?.(m.width, m.height, m.dpr);
      });
      break;
  }
};
