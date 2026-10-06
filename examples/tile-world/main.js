// tile-world's page: starts the runtime and shows what it is doing.
// Query options: ?record=1 (record a boot set), ?nostore=1 (no persistent cache), ?2d=1 (no WebGPU), ?nobootset=1,
// ?timer=1 (keep drawing while the page is hidden)
import { start } from '../../src/host.js';

const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const canvas = $('view');

let game;
try {
  game = await start({
    canvas,
    manifest: './dist/manifest.json',
    bootset: q.has('nobootset') ? null : './dist/bootset.json',
    engine: new URL('./engine.js', import.meta.url),
    gpuHandlers: new URL('./gpu.js', import.meta.url),
    record: q.has('record'),
    persist: !q.has('nostore'),
    prefer2d: q.has('2d'),
    pacing: q.has('timer') ? 'timer' : 'raf',
    onStats: showStats,
    onMessage: showEngine,
    onLog: (line) => console.log(line),
    onError: (e) => showError(e.message),
  });
  $('sub').textContent = `${Math.round(game.files.totalBytes() / 1048576)} MB of terrain, streamed as you look at it`;
  const { backend } = await game.ready;
  $('backend').textContent = backend === 'webgpu' ? 'WebGPU' : '2D canvas';
  canvas.focus();
} catch (e) {
  showError(e.message);
}

function showError(text) {
  $('error-text').textContent = text;
  $('error').style.display = 'grid';
}

function showStats(s) {
  const store = s.store;
  $('store').innerHTML = store.persistent ? '<span class="ok">OPFS, persistent</span>' : '<span class="warn">memory only</span>';
  const b = s.boot;
  if (b.state === 'none') $('bootset').textContent = q.has('record') ? 'recording…' : 'none';
  else $('bootset').textContent = `${b.done}/${b.runs} ranges, ${mb(b.bytes)}` + (b.state === 'done' ? ` in ${(b.ms / 1000).toFixed(1)} s` : '');
  $('bootbar').style.width = b.runs ? `${(100 * b.done) / b.runs}%` : '0';
  $('net').textContent = `${mb(s.bytesFetched)} in ${s.requests} requests` + (s.retries ? `, ${s.retries} retried` : '');
  $('inflight').textContent = `${s.fetchesActive}` + (s.queued ? ` (+${s.queued} queued)` : '');
  $('cached').textContent = mb(store.bytes);
  $('reads').textContent = `${s.reads} (${mb(s.bytesRead)})`;
  const avg = s.readsWaited ? s.waitMs / s.readsWaited : 0;
  $('waited').textContent = `${s.readsWaited}, ${s.readsCold} unannounced, avg ${avg.toFixed(0)} ms`;
  $('hints').textContent = `${s.hints} seen, ${s.hintsFetched} fetched`;
}

function showEngine(m) {
  $('boot').textContent = `${(m.bootMs / 1000).toFixed(2)} s`;
  $('fps').textContent = m.fps.toFixed(0);
  $('tiles').textContent = `${m.resident}/${m.visible} sharp, ${m.streaming} streaming`;
  $('auto').textContent = m.autopilot ? 'Autopilot: on' : 'Autopilot: off';
}

$('auto').onclick = () => {
  canvas.focus();
  canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
  canvas.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' }));
};

$('clear').onclick = async () => {
  $('clear').disabled = true;
  await game?.clearCache();
  location.reload();
};

if (q.has('record')) {
  $('record').textContent = 'Save boot set';
  $('record').onclick = async () => {
    const set = await game.takeRecording();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([JSON.stringify(set)], { type: 'application/json' })),
      download: 'bootset-recording.json',
    });
    a.click();
    URL.revokeObjectURL(a.href);
  };
} else {
  // Reads are recorded whether or not they come from the cache, so recording needs no reset.
  $('record').onclick = () => (location.search = '?record=1');
}
