// Page side: checks the browser, starts the IO, GPU and engine workers, wires them together and forwards input.
//
//   import { start } from 'rangeplay/host';
//   const game = await start({
//     canvas: document.querySelector('canvas'),
//     manifest: 'dist/manifest.json',            // from `rangeplay pack`
//     bootset: 'dist/bootset.json',              // optional: recorded reads to prefetch at once
//     engine: new URL('./engine.js', import.meta.url),       // module worker that calls connect() from engine.js
//     gpuHandlers: new URL('./gpu.js', import.meta.url),     // module the GPU worker imports (see gpu-worker.js)
//     onStats: (s) => ..., onLog: (line) => ..., onMessage: (m) => ..., onFirstFrame: (ms) => ...,
//   });
//
// Other options: record (collect a boot set), persist: false (no OPFS cache), prefer2d (skip WebGPU),
// pacing: 'timer' (keep running at ~60 fps while the page is hidden; default 'raf' pauses with the page),
// io: { ...IoCore options, maxStoreBytes, memoryCacheBytes, backgroundFill: [paths] or true (download the rest of the
// game at low priority after the boot set) }, engineOptions (passed to the engine worker in its start message),
// pointerLock (a click on the canvas locks the pointer: raw mouse movement for camera control), audio: false (ignore an
// engine's audio ring), fineTimers (keep a 1 ms timer pending on the page: Chrome on Windows otherwise rounds short
// Atomics.wait timeouts in engine threads up to the 15.6 ms system tick), stallMs + onStall (called with debug() when
// nothing has happened for that long before the first frame; default 30 s), onGpuLost({ reason, message }) and
// onGpuRestored(gpu) (the WebGPU device was lost and replaced: see gpu-worker.js), onError(error).

import {
  EV_BLUR, EV_KEY_DOWN, EV_KEY_UP, EV_POINTER_DOWN, EV_POINTER_MOVE, EV_POINTER_UP, EV_RESIZE, EV_WHEEL, keyCodeIndex,
} from './shared/layout.js';
import { AudioRing, RecordRing } from './shared/ring.js';
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

  const t0 = performance.now();
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

  const state = { stats: null, backend: null, gpu: null, store: null, firstFrameMs: null };
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
      state.gpu = m.gpu;
      if (m.gpu?.why2d && !opts.prefer2d) emit('onLog', '[gpu] drawing on the 2D canvas: ' + m.gpu.why2d);
      resolveReady({ backend: m.backend, gpu: m.gpu });
    } else if (m.type === 'gpu-lost') {
      emit('onLog', '[gpu] device lost: ' + (m.message || m.reason));
      emit('onGpuLost', { reason: m.reason, message: m.message });
    } else if (m.type === 'gpu-restored') {
      state.gpu = m.gpu;
      emit('onGpuRestored', m.gpu);
    } else if (m.type === 'first-frame') emit('onFirstFrame', (state.firstFrameMs = performance.now() - t0));
    else if (m.type === 'debug') gpuDebug.shift()?.(m.state);
    else if (m.type === 'log') emit('onLog', m.text);
    else if (m.type === 'error') onError(m.message);
  };
  for (const w of [io, gpu, engine]) w.onerror = (e) => onError((e.message || 'worker failed to load') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : ''));

  const waiters = new Map();
  const gpuDebug = [];
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
      input = new RecordRing(m.memory.buffer ?? m.memory, m.ringOffset);
      pushResize();
    } else if (m?.type === 'rangeplay:audio') {
      if (opts.audio !== false) audio.offer(m.memory, m.ringOffset);
    } else if (m?.type === 'rangeplay:app') emit('onMessage', m.message);
  };

  // ---- audio: the engine's PCM ring, played by an AudioWorklet once the page has had a user gesture ----
  const audio = {
    ring: null, ctx: null, gesture: false, starting: false,
    offer(memory, ringOffset) {
      this.ring = { memory, ringOffset, info: new AudioRing(memory.buffer ?? memory, ringOffset) };
      this.start();
    },
    async start() {
      if (!this.ring || !this.gesture || this.ctx || this.starting) return;
      this.starting = true;
      try {
        const { memory, ringOffset, info } = this.ring;
        const ctx = new AudioContext({ sampleRate: info.rate, latencyHint: 'interactive' });
        await ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
        const node = new AudioWorkletNode(ctx, 'rangeplay-audio', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [info.channels], processorOptions: { memory, ringOffset },
        });
        node.connect(ctx.destination);
        await ctx.resume();
        this.ctx = ctx;
        emit('onLog', '[audio] playing at ' + ctx.sampleRate + ' Hz');
      } catch (e) {
        emit('onLog', '[audio] could not start: ' + e.message);
      } finally {
        this.starting = false;
      }
    },
    onGesture() {
      this.gesture = true;
      if (this.ctx?.state === 'suspended') this.ctx.resume();
      this.start();
    },
    stats() {
      return this.ring ? { ...this.ring.info.stats(), state: this.ctx?.state ?? 'waiting for a click or key press' } : null;
    },
  };
  const gestureListener = () => audio.onGesture();
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, gestureListener, { capture: true });

  // ---- optional: a 1 ms timer that keeps Chrome on Windows from rounding short waits up to the 15.6 ms tick ----
  const fineTimer = opts.fineTimers ? setInterval(() => {}, 1) : 0;

  // ---- stall watchdog: nothing new from the engine (no read, no download, no frame) for stallMs before the first frame ----
  let lastActivity = performance.now(), lastSeen = '';
  const watchdog = setInterval(async () => {
    if (state.firstFrameMs !== null) return clearInterval(watchdog);
    const s = state.stats, seen = s ? s.reads + '/' + s.bytesFetched + '/' + s.fetchesActive : '';
    if (seen !== lastSeen) {
      lastSeen = seen;
      lastActivity = performance.now();
      return;
    }
    if (performance.now() - lastActivity < (opts.stallMs ?? 30000)) return;
    lastActivity = performance.now();
    const info = await controller.debug().catch((e) => ({ error: e.message }));
    emit('onLog', '[host] no progress for ' + Math.round((opts.stallMs ?? 30000) / 1000) + ' s: ' + JSON.stringify(info));
    emit('onStall', info);
  }, 2000);

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
  const locked = () => document.pointerLockElement === canvas;
  const mods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0) | (locked() ? 16 : 0);
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
      if (opts.pointerLock && !locked()) {
        // raw movement where the browser offers it (no OS acceleration)
        canvas.requestPointerLock?.({ unadjustedMovement: true })?.catch?.(() => canvas.requestPointerLock());
      } else if (!opts.pointerLock) canvas.setPointerCapture?.(e.pointerId);
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
    // Release the persistent cache while the page is hidden or going away (the next page, or another tab, can take it),
    // and take it back if the page returns from the back/forward cache.
    [globalThis, 'pagehide', () => io.postMessage({ type: 'suspend' })],
    [globalThis, 'pageshow', (e) => { if (e.persisted) io.postMessage({ type: 'resume' }); }],
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

  // Stops everything; resolves once the cache has written its journal (or after a second).
  const stop = async () => {
    ro.disconnect();
    for (const [target, name, fn, o] of listeners) target.removeEventListener(name, fn, o);
    for (const type of ['pointerdown', 'keydown']) removeEventListener(type, gestureListener, { capture: true });
    clearInterval(fineTimer);
    clearInterval(watchdog);
    audio.ctx?.close();
    engine.terminate();
    gpu.terminate();
    await Promise.race([ask(io, 'close', 'closed'), new Promise((r) => setTimeout(r, 1000))]);
    io.terminate();
  };

  const controller = {
    files,
    capabilities: caps,
    ready,                                   // resolves with { backend, gpu } once the GPU worker runs
    stats: () => state.stats,
    store: () => state.store,
    backend: () => state.backend,
    // The GPU as the worker found it: adapter (vendor, architecture, description), features, key limits, why2d (why
    // not WebGPU), and counters for uncaptured errors and lost and restored devices. Worth attaching to bug reports.
    gpu: () => state.gpu,
    // Loses the WebGPU device on purpose, as a driver reset would: to test that your GPU handlers recover.
    simulateGpuLoss: () => gpu.postMessage({ type: 'simulate-gpu-loss' }),
    firstFrameMs: () => state.firstFrameMs,   // from start() to the first frame on screen
    audio: () => audio.stats(),               // the engine's audio ring: rate, frames written and played, underruns
    audioRing: () => audio.ring?.info ?? null, // the AudioRing itself (shared memory), for meters and visualisers
    // What the IO and GPU workers see in shared memory: for diagnosing an engine that stops (blocked on a read? on a
    // full command ring? on frame pacing?).
    debug: async () => ({
      io: await ask(io, 'debug', 'debug').then((m) => m.state),
      gpu: await new Promise((resolve) => {
        gpuDebug.push(resolve);
        gpu.postMessage({ type: 'debug' });
      }),
      audio: audio.stats(),
    }),
    // The reads seen so far (start with record: true): save it as bootset.json next to the manifest.
    takeRecording: () => ask(io, 'take-recording', 'recording').then((m) => m.bootset),
    // Stops everything and deletes this game's persistent cache. Reload the page afterwards.
    clearCache: async () => {
      ro.disconnect();
      clearInterval(watchdog);
      audio.ctx?.close();
      engine.terminate();
      gpu.terminate();
      await ask(io, 'clear', 'cleared');
      io.terminate();
    },
    stop,
  };
  return controller;
}
