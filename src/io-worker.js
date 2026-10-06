// The IO worker (a module worker, started by host.js). It owns the block store and the network; engine threads talk
// to it through the IO control block in shared memory (src/engine.js on the JS side, native/rangeplay.h for wasm).
//
// Messages from the page:   { type: 'init', manifest, manifestUrl, bootsetUrl, record, persist, options, enginePort }
//                           { type: 'take-recording' }  -> { type: 'recording', bootset }
//                           { type: 'clear' }           -> { type: 'cleared' }  (closes and deletes the store)
//                           { type: 'close' }           (the page is going away: release the store for the next load)
// Messages from the engine (enginePort): { type: 'attach', memory, controlOffset }  memory: SharedArrayBuffer or a
//                                        shared WebAssembly.Memory
// To the page:              { type: 'ready', store }, { type: 'stats', stats }, { type: 'log', text }, { type: 'error', message }

import { IoCore } from './io/core.js';
import { Fetcher } from './io/fetcher.js';
import { MemoryStore } from './io/store-memory.js';
import { deleteOpfsStore, openOpfsStore } from './io/store-opfs.js';
import { FileTable } from './shared/manifest.js';

let core = null;
let ready = null;
let files = null;
let statsTimer = 0;
let lastStats = '';

const log = (text) => self.postMessage({ type: 'log', text });

async function init(m) {
  files = new FileTable(m.manifest, m.manifestUrl);
  const options = m.options || {};
  let store = m.persist === false ? null : await openOpfsStore({ files, log, maxBytes: options.maxStoreBytes });
  // Without a persistent store the browser's HTTP cache is the only cache across visits: let it keep responses.
  const fetcher = new Fetcher({ log, cache: store ? 'no-store' : 'default' });
  if (!store) store = new MemoryStore({ files, maxBytes: options.memoryCacheBytes ?? 256 * 1048576 });
  core = new IoCore({ files, store, fetcher, options, log });
  if (m.record) core.startRecording();
  self.postMessage({ type: 'ready', store: store.stats() });
  statsTimer = setInterval(postStats, 250);
  if (m.bootsetUrl && !m.record) {
    fetch(m.bootsetUrl, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((set) => set && core.prefetchBootset(set))
      .catch((e) => log('[io] no boot set (' + e.message + ')'));
  }
}

function postStats() {
  if (!core) return;
  const s = core.snapshot();
  const text = JSON.stringify(s);
  if (text === lastStats) return;
  lastStats = text;
  self.postMessage({ type: 'stats', stats: s });
}

function onEngineMessage(ev) {
  const m = ev.data;
  if (m?.type !== 'attach') return;
  ready
    .then(() => core.attach(m.memory, m.controlOffset))
    .catch((e) => self.postMessage({ type: 'error', message: 'IO attach failed: ' + e.message }));
}

self.onmessage = async (ev) => {
  const m = ev.data;
  switch (m?.type) {
    case 'init':
      m.enginePort.onmessage = onEngineMessage;
      ready = init(m).catch((e) => {
        self.postMessage({ type: 'error', message: 'IO init failed: ' + e.message });
        throw e;
      });
      break;
    case 'take-recording':
      await ready;
      self.postMessage({ type: 'recording', bootset: core.takeRecording() });
      break;
    case 'clear':
      await ready.catch(() => {});
      clearInterval(statsTimer);
      core?.close();
      try {
        await deleteOpfsStore(files.name);
      } catch (e) {
        log('[io] could not delete the store: ' + e.message);
      }
      self.postMessage({ type: 'cleared' });
      break;
    case 'close':
      clearInterval(statsTimer);
      core?.close();
      break;
  }
};
