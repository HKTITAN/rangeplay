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
// Messages from the page:   { type: 'init', canvas, handlers, width, height, dpr, prefer2d, pacing, enginePort }
//                           { type: 'resize', width, height, dpr }
// Messages from the engine: { type: 'attach', memory, ringOffset }
// To the page:              { type: 'ready', backend }, { type: 'error', message }, { type: 'log', text }

import { CommandRing } from './shared/ring.js';
import { OP_FRAME_END, RING_WRITE_W } from './shared/layout.js';

const log = (text) => self.postMessage({ type: 'log', text });
const fail = (message) => self.postMessage({ type: 'error', message });

let ctx = null;
let handlers = null;
let ring = null;
let size = { width: 1, height: 1, dpr: 1 };
let ready = null;

let pacing = 'raf';
// 'raf' follows the display and stops while the page is hidden (what a game wants); 'timer' runs at ~60 fps regardless.
const nextFrame = () =>
  new Promise((resolve) => (pacing === 'raf' && typeof self.requestAnimationFrame === 'function' ? self.requestAnimationFrame(resolve) : setTimeout(resolve, 16)));

async function init(m) {
  const canvas = m.canvas;
  size = { width: m.width, height: m.height, dpr: m.dpr };
  canvas.width = Math.max(1, Math.round(m.width * m.dpr));
  canvas.height = Math.max(1, Math.round(m.height * m.dpr));
  ctx = { canvas, backend: null, device: null, context: null, format: null, ctx2d: null, log };

  if (!m.prefer2d && self.navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('no WebGPU adapter');
      const device = await adapter.requestDevice();
      device.lost.then((info) => fail('WebGPU device lost: ' + info.message));
      device.addEventListener?.('uncapturederror', (e) => log('[gpu] ' + e.error.message));
      const context = canvas.getContext('webgpu');
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });
      Object.assign(ctx, { backend: 'webgpu', adapter, device, context, format });
    } catch (e) {
      log('[gpu] WebGPU unavailable (' + e.message + '): using the 2D canvas');
    }
  }
  if (!ctx.backend) {
    ctx.ctx2d = canvas.getContext('2d', { alpha: false });
    ctx.backend = '2d';
  }
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
  const mod = await import(handlersUrl);
  handlers = await mod.setup(ctx);
  handlers.resize?.(size.width, size.height, size.dpr);
  self.postMessage({ type: 'ready', backend: ctx.backend });
  run().catch((e) => fail('GPU worker stopped: ' + e.message));
}

// Executes commands as they arrive; one frame at a time, paced by animation frames.
async function run() {
  for (;;) {
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
