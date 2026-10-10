// The browser check: runs what rangeplay relies on, on this device, and builds a report a player can paste into a bug
// report. Query options: ?manifest=<url> tests the network path to that game's data (default: a demo's, when present).
import { capabilities } from '../../src/host.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const report = { page: location.href, time: new Date().toISOString(), userAgent: navigator.userAgent, checks: [] };
const LABEL = { ok: 'ok', warn: 'warn', fail: 'fail', info: 'info' };

function row(level, what, detail = '') {
  report.checks.push({ level, what, detail });
  const li = document.createElement('li');
  const tag = Object.assign(document.createElement('span'), { className: 'tag ' + level, textContent: LABEL[level] });
  const w = Object.assign(document.createElement('span'), { className: 'what', textContent: what });
  const d = Object.assign(document.createElement('span'), { className: 'detail', textContent: detail });
  li.append(tag, w, d);
  $('checks').append(li);
  render();
}

function render() {
  $('report').textContent = JSON.stringify(report, null, 2);
}

const gb = (n) => (n / 1073741824).toFixed(1) + ' GB';
const timeout = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' did not answer within ' + ms / 1000 + ' s')), ms));

// ---- the page and the browser ----
const caps = capabilities();
report.capabilities = caps;
row(caps.crossOriginIsolated ? 'ok' : 'fail', 'Cross-origin isolation',
  caps.crossOriginIsolated ? 'the page has the COOP and COEP headers' : 'this page was served without the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers, so shared memory is off');
row(caps.sharedArrayBuffer ? 'ok' : 'fail', 'SharedArrayBuffer', caps.sharedArrayBuffer ? 'engine threads can share memory' : 'engine threads need it');
row(caps.offscreenCanvas ? 'ok' : 'fail', 'OffscreenCanvas', caps.offscreenCanvas ? 'a worker can draw on the canvas' : 'the GPU worker needs it');
row(caps.waitAsync ? 'ok' : 'warn', 'Atomics.waitAsync', caps.waitAsync ? '' : 'workers poll instead: works, uses a little more power');
row(typeof AudioWorkletNode === 'function' ? 'ok' : 'warn', 'AudioWorklet', typeof AudioWorkletNode === 'function' ? '' : 'games will be silent');
row(caps.webLocks ? 'ok' : 'warn', 'Web Locks', caps.webLocks ? '' : 'two tabs of one game could fight over its cache');
row('info', 'Device', `${caps.cores || '?'} logical cores` + (caps.memoryGB ? `, about ${caps.memoryGB} GB of memory or more` : ', memory not reported'));

// ---- the on-device cache: OPFS sync access handles, which only exist in workers ----
const OPFS_WORKER = `
onmessage = async () => {
  const name = 'rangeplay-check-' + Math.random().toString(36).slice(2);
  let root = null, h = null;
  try {
    root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name, { create: true });
    h = await fh.createSyncAccessHandle();
    h.write(new Uint8Array([1, 2, 3, 4]), { at: 0 });
    const back = new Uint8Array(4);
    h.read(back, { at: 0 });
    let shared = true;
    try { h.read(new Uint8Array(new SharedArrayBuffer(4)), { at: 0 }); } catch { shared = false; }
    postMessage({ ok: back.join() === '1,2,3,4', shared });
  } catch (e) {
    postMessage({ ok: false, error: e.name + ': ' + e.message });
  } finally {
    try { h?.close(); await root?.removeEntry(name); } catch {}
  }
};`;
try {
  const url = URL.createObjectURL(new Blob([OPFS_WORKER], { type: 'text/javascript' }));
  const w = new Worker(url);
  const r = await Promise.race([new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => res({ ok: false, error: e.message }); w.postMessage(0); }), timeout(5000, 'the OPFS test')]);
  w.terminate();
  URL.revokeObjectURL(url);
  report.opfs = r;
  if (r.ok) row('ok', 'On-device cache (OPFS)', 'games stay cached between visits' + (r.shared ? '' : '; reads go through a copy (no direct reads into shared memory)'));
  else row('warn', 'On-device cache (OPFS)', 'not available (' + r.error + '): games cache in memory only and download again on every visit');
} catch (e) {
  report.opfs = { ok: false, error: e.message };
  row('warn', 'On-device cache (OPFS)', 'could not be tested: ' + e.message);
}
try {
  const est = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted?.();
  report.storage = { quota: est.quota, usage: est.usage, persisted };
  const free = est.quota - est.usage;
  row(free > 4 * 1073741824 ? 'ok' : 'warn', 'Storage', `${gb(free)} available to this site` + (persisted ? ', persistent' : ', may be cleared by the browser when the disk is full') +
    (free > 4 * 1073741824 ? '' : ': a game larger than this caches what fits and keeps the rest in memory'));
} catch (e) {
  row('info', 'Storage', 'not reported (' + e.message + ')');
}

// ---- WebGPU ----
async function checkGpu() {
  if (!navigator.gpu) return row('warn', 'WebGPU', 'this browser has no WebGPU: games that support it draw on the 2D canvas, which is slower');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return row('warn', 'WebGPU', 'no adapter: the GPU is blocklisted or hardware acceleration is off (see chrome://gpu or edge://gpu)');
  const info = adapter.info || {};
  report.gpu = {
    vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    fallbackAdapter: !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
    features: [...adapter.features].sort(),
    limits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D, maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
    preferredFormat: navigator.gpu.getPreferredCanvasFormat(),
  };
  render();
  const device = await Promise.race([adapter.requestDevice(), timeout(10000, 'requestDevice')]);
  try {
    device.queue.submit([device.createCommandEncoder().finish()]);
    await Promise.race([device.queue.onSubmittedWorkDone(), timeout(5000, 'the GPU queue')]);
  } finally {
    device.destroy();
  }
  const name = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'name not reported';
  if (report.gpu.fallbackAdapter) row('warn', 'WebGPU', `a software adapter (${name}): it works, slowly. Check hardware acceleration in the browser settings`);
  else row('ok', 'WebGPU', name + ', ' + report.gpu.features.length + ' features');
}
try {
  await checkGpu();
} catch (e) {
  row('warn', 'WebGPU', 'failed: ' + e.message);
}

// ---- the network path to a game's data ----
async function sha256Hex(buffer) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function checkNetwork() {
  const candidates = q.get('manifest') ? [q.get('manifest')] : ['../quake/dist/manifest.json', '../tile-world/dist/manifest.json', '../freedoom/dist/manifest.json'];
  let manifestUrl = null, manifest = null;
  for (const c of candidates) {
    const url = new URL(c, location.href).href;
    const r = await fetch(url, { cache: 'no-store' }).catch(() => null);
    if (r?.ok && /json/.test(r.headers.get('content-type') || '')) {
      manifestUrl = url;
      manifest = await r.json();
      break;
    }
  }
  if (!manifest) return row('info', 'Game data', 'no game to test against: add ?manifest=<url of a manifest.json>');
  const packs = manifest.packs || [];
  const objects = [...packs.map(([hash, size]) => ({ hash, size })),
    ...manifest.files.filter((f) => f.length === 3 && f[1] > 0).map(([, size, hash]) => ({ hash, size }))].sort((a, b) => a.size - b.size);
  const base = new URL(manifest.dataPath ?? 'data/', manifestUrl).href;
  const urlOf = (o) => base + o.hash.slice(0, 2) + '/' + o.hash;
  const times = [];
  for (const o of [objects[0], objects[objects.length >> 1], objects[objects.length - 1]]) {
    const at = Math.floor(o.size / 2);
    const t0 = performance.now();
    const r = await fetch(urlOf(o), { headers: { Range: `bytes=${at}-${Math.min(o.size - 1, at + 15)}` }, cache: 'no-store' });
    await r.arrayBuffer();
    times.push(performance.now() - t0);
    if (r.status !== 206) return row('fail', 'Game data', `a range request answered HTTP ${r.status} (expected 206): something between this browser and the host (a proxy, an extension) breaks byte ranges`);
  }
  const small = objects[0];
  const whole = await (await fetch(urlOf(small), { cache: 'no-store' })).arrayBuffer();
  if ((await sha256Hex(whole)).slice(0, 32) !== small.hash) return row('fail', 'Game data', 'the data arrived changed (a proxy or an extension rewrites it)');
  times.sort((a, b) => a - b);
  report.network = { manifest: manifestUrl, rangeMs: times.map(Math.round) };
  const ms = Math.round(times[1]);
  row(ms < 400 ? 'ok' : 'warn', 'Game data', `byte ranges work and the bytes are intact; a request takes about ${ms} ms` +
    (ms < 400 ? '' : ': a slow path to the host, so loading screens will be longer'));
}
try {
  await checkNetwork();
} catch (e) {
  row('warn', 'Game data', 'could not be tested: ' + e.message);
}

// ---- verdict ----
const first = (level) => report.checks.find((c) => c.level === level);
const v = $('verdict');
if (first('fail')) {
  v.dataset.level = 'fail';
  v.textContent = 'rangeplay games cannot run here. ' + first('fail').what + ': ' + first('fail').detail + '.';
} else if (report.checks.some((c) => c.level === 'warn' && c.what === 'WebGPU')) {
  v.dataset.level = 'warn';
  v.textContent = 'Games can run here, but without WebGPU: those that support it draw on the 2D canvas, which is slower.';
} else if (first('warn')) {
  v.dataset.level = 'warn';
  v.textContent = 'Games can run here, with limits: see the warnings below.';
} else {
  v.dataset.level = 'ok';
  v.textContent = 'This browser has everything rangeplay games need.';
}
report.verdict = v.textContent;
render();

$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('report').textContent);
    $('copy').textContent = 'Copied';
  } catch {
    $('copy').textContent = 'Select the report below and copy it';
  }
};
