// freedoom's page. Query options: ?wad=1 (Phase 1) or ?wad=2 (Phase 2, the default), ?nostore=1, ?nobootset=1,
// ?2d=1 (no WebGPU), ?timer=1 (keep running while the page is hidden), ?record=1 (record a boot set).
import { start } from '../../src/host.js';

const q = new URLSearchParams(location.search);
const phase = q.get('wad') === '1' ? 1 : 2;
const iwad = `freedoom${phase}.wad`;
const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const CHECK = 'Does this browser have what the game needs? Test it: ' + new URL('../check/', location.href).href;
const canvas = $('view'), consoleEl = $('console');
let total = 0;

$('game').textContent = phase === 1 ? 'Phase 1: 36 levels' : 'Phase 2: 32 levels';
$('p' + phase).style.fontWeight = '650';

function print(line) {
  consoleEl.append(line + '\n');
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

try {
  const game = await start({
    canvas,
    manifest: './dist/manifest.json',
    bootset: q.has('nobootset') || q.has('record') ? null : `./bootset-${phase}.json`,
    engine: new URL('./engine.js', import.meta.url),
    gpuHandlers: new URL('./gpu.js', import.meta.url),
    engineOptions: { iwad },
    // After the boot set, download the rest of this game at low priority: it ends up installed while you play.
    io: { backgroundFill: q.has('record') ? null : [iwad] },
    record: q.has('record'),
    persist: !q.has('nostore'),
    prefer2d: q.has('2d'),
    pacing: q.has('timer') ? 'timer' : 'raf',
    pointerLock: true,   // click the game to aim with the mouse; Esc gives the pointer back
    fineTimers: true,    // the engine sleeps 1 ms at a time between tics: keep Chrome on Windows from making that 15.6 ms
    onStats: (s) => {
      const installed = s.fill.state === 'done' ? ', installed' : s.fill.runs ? `, installing ${Math.round((100 * s.fill.done) / s.fill.runs)}%` : '';
      $('net').textContent = `${mb(s.bytesFetched)} of ${mb(total)}${installed}`;
      $('reads').textContent = `${s.reads}, ${s.readsWaited} waited`;
      $('store').innerHTML = s.store.persistent ? '<span class="ok">on this device</span>' : '<span class="warn">memory only</span>';
    },
    onMessage: (m) => {
      if (m.log) print(m.log.replace(/\s+$/, ''));
      if (m.error) print('ERROR: ' + m.error);
    },
    onFirstFrame: (ms) => {
      $('first').textContent = (ms / 1000).toFixed(2) + ' s';
      consoleEl.hidden = true;
      canvas.focus();
    },
    onLog: (line) => console.log(line),
    onError: (e) => {
      print('ERROR: ' + e.message);
      print(CHECK);
    },
  });
  total = game.files.size(game.files.id(iwad));
  window.rangeplay = game;   // for the console: rangeplay.takeRecording() with ?record=1
  $('clear').onclick = async () => {
    await game.clearCache();
    location.reload();
  };
} catch (e) {
  print('ERROR: ' + e.message);
  print(CHECK);
}
