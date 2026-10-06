// Page side: checks the browser, starts the IO, GPU and engine workers, wires them together and forwards input.
//
//   import { start } from 'rangeplay/host';
//   const game = await start({
//     canvas: document.querySelector('canvas'),
//     manifest: 'dist/manifest.json',            // from `rangeplay pack`
//     bootset: 'dist/bootset.json',              // optional: recorded reads to prefetch at once
//     engine: new URL('./engine.js', import.meta.url),       // module worker that calls connect() from engine.js
//     gpuHandlers: new URL('./gpu.js', import.meta.url),     // module the GPU worker imports (see gpu-worker.js)
//     onStats: (s) => ..., onLog: (line) => ..., onMessage: (m) => ...,
//   });
//
// Other options: record (collect a boot set), persist: false (no OPFS cache), prefer2d (skip WebGPU),
// pacing: 'timer' (keep running at ~60 fps while the page is hidden; default 'raf' pauses with the page),
// io: { ...IoCore options, maxStoreBytes, memoryCacheBytes }, engineOptions (passed to the engine's connect()).

import {
  EV_BLUR, EV_KEY_DOWN, EV_KEY_UP, EV_POINTER_DOWN, EV_POINTER_MOVE, EV_POINTER_UP, EV_RESIZE, EV_WHEEL, keyCodeIndex,
} from './shared/layout.js';
import { RecordRing } from './shared/ring.js';
import { FileTable } from './shared/manifest.js';

export class RangeplayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RangeplayError';
    this.code = code;
  }
}

export function capabilities() {
  const nav = globalThis.navigator || {};
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    webgpu: !!nav.gpu,
    opfs: !!nav.storage?.getDirectory,
    offscreenCanvas: typeof OffscreenCanvas === 'function' && typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype,
    waitAsync: typeof Atomics.waitAsync === 'function',
    webLocks: !!nav.locks,
    cores: nav.hardwareConcurrency || 0,
    memoryGB: nav.deviceMemory || null,
  };
}

export async function start(opts) {
  const caps = capabilities();
  if (!caps.crossOriginIsolated || !caps.sharedArrayBuffer) {
    throw new RangeplayError('not-isolated', 'This page is not cross-origin isolated, so shared memory is off. Serve it with the headers ' +
      '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp" (see docs/deploying.md).');
  }
  if (!caps.offscreenCanvas) throw new RangeplayError('no-offscreen-canvas', 'This browser cannot hand a canvas to a worker (OffscreenCanvas).');

  const { canvas } = opts;
  const emit = (name, ...args) => opts[name]?.(...args);
  const manifestUrl = new URL(opts.manifest, location.href).href;
  const res = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!res.ok) throw new RangeplayError('no-manifest', 'manifest: HTTP ' + res.status + ' for ' + manifestUrl);
  const manifest = await res.json();
  const files = new FileTable(manifest, manifestUrl);   // validates

  const here = import.meta.url;
  const io = new Worker(new URL('./io-worker.js', here), { type: 'module', name: 'rangeplay-io' });
  const gpu = new Worker(new URL('./gpu-worker.js', here), { type: 'module', name: 'rangeplay-gpu' });
  const engine = new Worker(new URL(opts.engine, location.href), { type: 'module', name: 'engine' });

  const state = { stats: null, backend: null, store: null };
  let resolveReady, rejectReady;
  const ready = new Promise((res2, rej) => {
    resolveReady = res2;
    rejectReady = rej;
  });
  const onError = (message) => {
    emit('onLog', '[error] ' + message);
    rejectReady(new RangeplayError('worker', message));
    emit('onError', new RangeplayError('worker', message));
  };

  io.onmessage = ({ data: m }) => {
    if (m.type === 'stats') emit('onStats', (state.stats = m.stats));
    else if (m.type === 'ready') state.store = m.store;
    else if (m.type === 'log') emit('onLog', m.text);
    else if (m.type === 'error') onError(m.message);
    else waiters.get(m.type)?.shift()?.(m);
  };
  gpu.onmessage = ({ data: m }) => {
    if (m.type === 'ready') {
      state.backend = m.backend;
      resolveReady({ backend: m.backend });
    } else if (m.type === 'log') emit('onLog', m.text);
    else if (m.type === 'error') onError(m.message);
  };
  for (const w of [io, gpu, engine]) w.onerror = (e) => onError((e.message || 'worker failed to load') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : ''));

  const waiters = new Map();
  const ask = (worker, type, reply) => new Promise((resolve) => {
    if (!waiters.has(reply)) waiters.set(reply, []);
    waiters.get(reply).push(resolve);
    worker.postMessage({ type });
  });

  // Each worker gets a direct line to the engine, so the engine can hand its shared memory to them.
  const ioCh = new MessageChannel(), gpuCh = new MessageChannel();
  io.postMessage({
    type: 'init',
    manifest,
    manifestUrl,
    bootsetUrl: opts.bootset ? new URL(opts.bootset, location.href).href : null,
    record: !!opts.record,
    persist: opts.persist !== false,
    options: opts.io || {},
    enginePort: ioCh.port1,
  }, [ioCh.port1]);

  const rect = canvas.getBoundingClientRect();
  const dpr = globalThis.devicePixelRatio || 1;
  const offscreen = canvas.transferControlToOffscreen();
  gpu.postMessage({
    type: 'init',
    canvas: offscreen,
    handlers: new URL(opts.gpuHandlers, location.href).href,
    width: rect.width,
    height: rect.height,
    dpr,
    prefer2d: !!opts.prefer2d,
    pacing: opts.pacing || 'raf',
    enginePort: gpuCh.port1,
  }, [offscreen, gpuCh.port1]);

  engine.postMessage({ type: 'rangeplay:start', manifest, manifestUrl, ioPort: ioCh.port2, gpuPort: gpuCh.port2, options: opts.engineOptions || {} }, [ioCh.port2, gpuCh.port2]);

  let input = null;
  engine.onmessage = ({ data: m }) => {
    if (m?.type === 'rangeplay:input') {
      input = new RecordRing(m.memory, m.ringOffset);
      pushResize();
    } else if (m?.type === 'rangeplay:app') emit('onMessage', m.message);
  };

  // ---- input: DOM events into the input ring (never blocks: a full ring drops the event) ----
  const push = (type, code, x, y, dx, dy, mods) => {
    if (!input) return;
    const i = input.reserve();
    if (i < 0) return;
    const a = input.i32, f = input.f32;
    a[i] = type;
    a[i + 1] = code;
    f[i + 2] = x;
    f[i + 3] = y;
    f[i + 4] = dx;
    f[i + 5] = dy;
    a[i + 6] = mods;
    f[i + 7] = performance.now();
    input.commit();
  };
  const mods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  const listeners = [
    [canvas, 'keydown', (e) => {
      if (!e.repeat) push(EV_KEY_DOWN, keyCodeIndex(e.code), 0, 0, 0, 0, mods(e));
      if (opts.captureKeys !== false && keyCodeIndex(e.code) && !(e.ctrlKey || e.metaKey)) e.preventDefault();
    }],
    [canvas, 'keyup', (e) => push(EV_KEY_UP, keyCodeIndex(e.code), 0, 0, 0, 0, mods(e))],
    [canvas, 'pointerdown', (e) => {
      canvas.focus();
      canvas.setPointerCapture?.(e.pointerId);
      push(EV_POINTER_DOWN, e.button, ...pos(e), 0, 0, mods(e) | (e.buttons << 8));
    }],
    [canvas, 'pointerup', (e) => push(EV_POINTER_UP, e.button, ...pos(e), 0, 0, mods(e) | (e.buttons << 8))],
    [canvas, 'pointermove', (e) => push(EV_POINTER_MOVE, 0, ...pos(e), e.movementX, e.movementY, mods(e) | (e.buttons << 8))],
    [canvas, 'wheel', (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      push(EV_WHEEL, 0, ...pos(e), e.deltaX * scale, e.deltaY * scale, mods(e));
    }, { passive: false }],
    [canvas, 'contextmenu', (e) => e.preventDefault()],
    [canvas, 'blur', () => push(EV_BLUR, 0, 0, 0, 0, 0, 0)],
    [globalThis, 'pagehide', () => io.postMessage({ type: 'close' })],
  ];
  for (const [target, name, fn, o] of listeners) target.addEventListener(name, fn, o);

  // A hidden page can report a 0 x 0 canvas: keep the last real size until it is laid out again.
  function pushResize() {
    const r = canvas.getBoundingClientRect(), d = globalThis.devicePixelRatio || 1;
    if (r.width >= 1 && r.height >= 1) push(EV_RESIZE, 0, r.width, r.height, d, 0, 0);
  }
  const ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect(), d = globalThis.devicePixelRatio || 1;
    if (r.width < 1 || r.height < 1) return;
    gpu.postMessage({ type: 'resize', width: r.width, height: r.height, dpr: d });
    pushResize();
  });
  ro.observe(canvas);

  const stop = () => {
    ro.disconnect();
    for (const [target, name, fn, o] of listeners) target.removeEventListener(name, fn, o);
    io.postMessage({ type: 'close' });
    for (const w of [engine, gpu, io]) w.terminate();
  };

  return {
    files,
    capabilities: caps,
    ready,                                   // resolves with { backend } once the GPU worker runs
    stats: () => state.stats,
    store: () => state.store,
    backend: () => state.backend,
    // The reads seen so far (start with record: true): save it as bootset.json next to the manifest.
    takeRecording: () => ask(io, 'take-recording', 'recording').then((m) => m.bootset),
    // Stops everything and deletes this game's persistent cache. Reload the page afterwards.
    clearCache: async () => {
      ro.disconnect();
      engine.terminate();
      gpu.terminate();
      await ask(io, 'clear', 'cleared');
      io.terminate();
    },
    stop,
  };
}
