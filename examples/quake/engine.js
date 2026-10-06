// quake's engine worker (started by host.js): loads Quake compiled to WebAssembly, hands its memory to rangeplay's IO
// and GPU workers, tells it which files the manifest has, and starts main() on a pthread. From then on the engine runs
// on its own; every file read it makes is an rp_read (see platform.c).

import { attachWasm, postToPage, waitForStart } from '../../src/engine.js';
import { FileTable } from '../../src/shared/manifest.js';
import createQuake from './wasm/quake.js';

const start = await waitForStart();
const log = (text) => postToPage({ log: text });
const Module = await createQuake({
  print: log,
  printErr: log,
  onAbort: (what) => postToPage({ error: 'the engine stopped: ' + what }),
});

// rp_setup allocates the IO control block, the command ring, the input ring and the audio ring in the engine's memory.
const at = Module._rp_setup() >>> 2;
const [ioOffset, gpuOffset, inputOffset, audioOffset] = Module.HEAPU32.subarray(at, at + 4);
attachWasm(start, { memory: Module.wasmMemory, ioOffset, gpuOffset, inputOffset, audioOffset });

const files = new FileTable(start.manifest, start.manifestUrl);
for (let id = 0; id < files.count; id++) {
  Module.ccall('rp_register_file', null, ['string', 'number', 'number'], [files.path(id), id, files.size(id)]);
}

Module.callMain(start.options.args || []);
