# Using rangeplay from a C or C++ engine (Emscripten)

This is how [`examples/freedoom`](../examples/freedoom) runs the Doom engine: an unmodified C engine, compiled with
Emscripten 6, reading a 27 MB game through rangeplay. Every snippet below comes from that example, which runs in CI
and in the [live demo](https://rangeplay.vercel.app/examples/freedoom/).

## 1. Build

Build with threads, and keep the engine's main loop off the page's main thread. Browsers do not allow
`Atomics.wait` on the page's main thread, and `rp_read` waits. From [`build-wasm.js`](../examples/freedoom/build-wasm.js):

```
-pthread -sPROXY_TO_PTHREAD                main() runs on a pthread, where rp_read may block
-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createGame
-sENVIRONMENT=web,worker                   loaded inside rangeplay's engine worker (a module worker)
-sINVOKE_RUN=0                             the engine worker calls main() after handing over the memory
-sINITIAL_MEMORY=128MB -sALLOW_MEMORY_GROWTH=0
-sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB
-sEXPORTED_FUNCTIONS=_main,_rp_setup,_rp_register_file
-sEXPORTED_RUNTIME_METHODS=wasmMemory,HEAPU32,FS,callMain,ccall
-I path/to/rangeplay/native
```

`wasmMemory` in the exported runtime methods gives the engine worker the shared `WebAssembly.Memory` to hand over.
With `-sALLOW_MEMORY_GROWTH` rangeplay copes, because the workers refresh their views when the memory grows, but a
fixed size is simpler and avoids Emscripten's slower growable-memory paths with threads.

## 2. Allocate the shared structures

In exactly one source file:

```c
#define RANGEPLAY_IMPLEMENTATION
#include "rangeplay.h"
#include "rangeplay_keys.h"   /* RP_KEY_* codes for input events */
#include <emscripten.h>
#include <stdlib.h>

void *rp_ctl, *rp_gpu, *rp_input;

/* Called from the engine worker before main(): allocates the structures, returns their addresses. */
EMSCRIPTEN_KEEPALIVE uint32_t *rp_setup(void) {
  static uint32_t offsets[3];
  rp_ctl = aligned_alloc(64, rp_io_bytes(16, 1024));      /* 16 slots: at least one per thread that reads */
  rp_io_init(rp_ctl, 16, 1024);
  rp_gpu = aligned_alloc(64, rp_ring_bytes(8u << 20));   /* a record may use up to half the ring */
  rp_ring_init(rp_gpu, 8u << 20);
  rp_input = aligned_alloc(64, rp_records_bytes(256, RP_INPUT_WORDS));
  rp_records_init(rp_input, 256, RP_INPUT_WORDS);
  offsets[0] = (uint32_t)(uintptr_t)rp_ctl;
  offsets[1] = (uint32_t)(uintptr_t)rp_gpu;
  offsets[2] = (uint32_t)(uintptr_t)rp_input;
  return offsets;
}
```

With `-sMEMORY64`, return 64-bit offsets; the protocol carries 64-bit addresses.

## 3. The engine worker

`host.js` starts your engine as a module worker. `waitForStart()` gives you the host's start message (the manifest,
your `engineOptions`), and `attachWasm()` hands the engine's memory to the IO and GPU workers. From
[`examples/freedoom/engine.js`](../examples/freedoom/engine.js):

```js
import { attachWasm, postToPage, waitForStart } from 'rangeplay/engine';   // import statically
import { FileTable } from 'rangeplay/manifest';
import createGame from './wasm/game.js';

const start = await waitForStart();
const Module = await createGame({ print: (t) => postToPage({ log: t }), printErr: (t) => postToPage({ log: t }) });

const at = Module._rp_setup() >>> 2;
const [ioOffset, gpuOffset, inputOffset] = Module.HEAPU32.subarray(at, at + 3);
attachWasm(start, { memory: Module.wasmMemory, ioOffset, gpuOffset, inputOffset });

const files = new FileTable(start.manifest, start.manifestUrl);
for (let id = 0; id < files.count; id++) {
  Module.ccall('rp_register_file', null, ['string', 'number', 'number'], [files.path(id), id, files.size(id)]);
}
Module.callMain([]);
```

`rp_register_file` is yours: keep a small path → (id, size) table in C. The Doom example also writes an empty file
with each name into Emscripten's in-memory file system, because the engine checks that its data file exists with
`fopen()` before opening it through its own file layer.

## 4. Route the file layer

Most engines already read through one place: a file class, a virtual file system, or archive code. Implement it
with `rp_read`. Doom's, from [`platform.c`](../examples/freedoom/platform.c):

```c
static size_t read_wad(wad_file_t *wad, unsigned int offset, void *buffer, size_t len) {
  int64_t n = rp_read(rp_ctl, ((rp_wad_file_t *)wad)->id, offset, buffer, (uint32_t)len, 0);
  if (n < 0) I_Error("rangeplay: reading the WAD failed (%d)", (int)n);
  return (size_t)n;
}
```

`rp_read` is safe from any pthread and blocks only the calling thread. Where the engine queues reads for a streaming
thread, hint each request as it is queued:

```c
rp_hint(rp_ctl, file_id, offset, len, 0);   /* 1 for "might not be needed" */
```

## 5. Render through the command ring

Doom renders in software, so one opcode carries a whole frame:

```c
void DG_DrawFrame(void) {
  rp_frame_begin(rp_gpu, 2);   /* paces the engine to the display: waits while two frames are queued */
  uint32_t *p = rp_ring_reserve(rp_gpu, OP_FRAME, 8 + W * H * 4);
  p[0] = W;
  p[1] = H;
  memcpy(p + 2, DG_ScreenBuffer, W * H * 4);
  rp_ring_commit(rp_gpu);
  rp_frame_end(rp_gpu);
}
```

The GPU worker imports your handler module (`gpuHandlers` in `start()`) and calls one function per opcode with the
payload's address in the engine's memory. [`examples/freedoom/gpu.js`](../examples/freedoom/gpu.js) uploads the frame
with `writeTexture` straight from shared memory. For a GPU renderer, design opcodes around what the engine already
batches (pipelines, buffer updates, draws), and keep GPU objects in tables on the worker's side, indexed by ids the
engine chooses.

## 6. Input

Poll the input ring once per frame. Key codes are `RP_KEY_*` from `rangeplay_keys.h`:

```c
for (int32_t *ev; (ev = rp_records_peek(rp_input)); rp_records_release(rp_input)) {
  if (ev[RP_IN_TYPE] == RP_EV_KEY_DOWN && ev[RP_IN_CODE] == RP_KEY_Space) { /* ... */ }
}
```

## 7. Boot set and background install

Load the game with `record: true`, play to where you want a fresh visit to land (the title screen, the first level),
and save `game.takeRecording()` as the boot set. With `io: { backgroundFill: ['data.pak'] }` the rest of those files
then download at low priority, so the game ends up fully installed while it is played.

## Pitfalls we hit

- **`emscripten_get_now()` counts from the Unix epoch in threaded builds.** It is far beyond 2^32 milliseconds, so a
  `(uint32_t)` cast saturates and the engine's clock never moves. Subtract the value from the first call.
- **A stalled engine is easiest to find in shared memory.** `await game.debug()` shows each IO slot (idle, or waiting
  for a read of which file and offset) and the command ring's frame counters. In the Doom port it showed an idle
  slot and an empty ring, which pointed straight at the clock.
- **Saves and settings** belong in IndexedDB, not the block cache, which is keyed to the game's data. Restore them
  into Emscripten's file system before calling `main()`.
