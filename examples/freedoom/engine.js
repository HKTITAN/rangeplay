// freedoom's engine worker (started by host.js): loads the Doom engine compiled to WebAssembly, hands its memory to
// rangeplay's IO and GPU workers, tells it which files the manifest has, and starts main() on a pthread. From then on
// the engine runs on its own; every WAD read it makes is an rp_read (see platform.c).

import { attachWasm, postToPage, waitForStart } from '../../src/engine.js';
import { FileTable } from '../../src/shared/manifest.js';
import createDoom from './wasm/doom.js';

const start = await waitForStart();
const log = (text) => postToPage({ log: text });
const Module = await createDoom({
  print: log,
  printErr: log,
  onAbort: (what) => postToPage({ error: 'the engine stopped: ' + what }),
});

// rp_setup allocates the IO control block, the command ring and the input ring in the engine's memory.
const at = Module._rp_setup() >>> 2;
const [ioOffset, gpuOffset, inputOffset] = Module.HEAPU32.subarray(at, at + 3);
attachWasm(start, { memory: Module.wasmMemory, ioOffset, gpuOffset, inputOffset });

const files = new FileTable(start.manifest, start.manifestUrl);
for (let id = 0; id < files.count; id++) {
  Module.ccall('rp_register_file', null, ['string', 'number', 'number'], [files.path(id), id, files.size(id)]);
  Module.FS.writeFile('/' + files.path(id), '');   // the engine checks that its IWAD exists with fopen()
}

Module.callMain(['-iwad', start.options.iwad || 'freedoom2.wad']);
