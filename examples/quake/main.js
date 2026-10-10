// quake's page. Query options: ?map=start (skip the demos and start a map; any map name works), ?install=1 (download
// the whole game in the background), ?nostore=1, ?nobootset=1, ?2d=1 (no WebGPU), ?timer=1 (keep running while the
// page is hidden), ?record=1 (record a boot set).
import { start } from '../../src/host.js';

const q = new URLSearchParams(location.search);
const map = q.get('map');
const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const CHECK = 'Does this browser have what the game needs? Test it: ' + new URL('../check/', location.href).href;
const canvas = $('view'), consoleEl = $('console');
let total = 0;

$(map ? 'play' : 'demos').style.fontWeight = '650';

function print(line) {
  consoleEl.append(line + '\n');
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

try {
  const game = await start({
    canvas,
    manifest: './dist/manifest.json',
    // recorded boot sets: start-up and the first demo's level, or start-up and the episode-select level
    bootset: q.has('nobootset') || q.has('record') ? null : !map ? './bootset.json' : map === 'start' ? './bootset-start.json' : null,
    engine: new URL('./engine.js', import.meta.url),
    gpuHandlers: new URL('./gpu.js', import.meta.url),
    engineOptions: { args: map ? ['+map', map] : [] },
    // The whole game is 210 MB, and a level needs a few of them: by default only what the engine reads is downloaded.
    io: { backgroundFill: q.has('install') ? ['id1/pak0.pak', 'id1/pak1.pak'] : null },
    record: q.has('record'),
    persist: !q.has('nostore'),
    prefer2d: q.has('2d'),
    pacing: q.has('timer') ? 'timer' : 'raf',
    pointerLock: true,   // click the game to aim with the mouse; Esc gives the pointer back
    fineTimers: true,
    onStats: (s) => {
      const installed = s.fill.state === 'done' ? ', installed' : s.fill.runs ? `, installing ${Math.round((100 * s.fill.done) / s.fill.runs)}%` : '';
      $('net').textContent = `${mb(s.bytesFetched)} of ${mb(total)}${installed}`;
      $('reads').textContent = `${s.reads}, ${s.readsWaited} waited`;
      $('store').innerHTML = s.store.persistent ? '<span class="ok">on this device</span>' : '<span class="warn">memory only</span>';
    },
    onMessage: (m) => {
      if (m.log) print(m.log.replace(/\s+$/, ''));
      if (m.error) {
        print('ERROR: ' + m.error);
        consoleEl.hidden = false;
      }
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
      consoleEl.hidden = false;
    },
  });
  for (let id = 0; id < game.files.count; id++) total += game.files.size(id);
  window.rangeplay = game;   // for the console: rangeplay.takeRecording() with ?record=1
  $('clear').onclick = async () => {
    await game.clearCache();
    location.reload();
  };
} catch (e) {
  print('ERROR: ' + e.message);
  print(CHECK);
}
