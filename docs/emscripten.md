# Using rangeplay from a C or C++ engine (Emscripten)

> **Status:** this guide is a sketch. The protocol it relies on is tested from both sides: natively against
> `native/rangeplay.h` (`npm run test:native`), and from JavaScript against the IO worker's core (`npm test`). The
> Emscripten glue below has not yet run against a real build in this repository. Expect to adjust flag names to your
> Emscripten version. Please report what you change.

## 1. Build

Build with threads, and keep the engine's main loop off the page's main thread. Browsers do not allow
`Atomics.wait` on the page's main thread, and `rp_read` waits. The relevant flags:

```
-pthread                    shared memory, pthreads as workers
-sPROXY_TO_PTHREAD          main() runs in a pthread, not on the thread that loaded the module
-sENVIRONMENT=web,worker    the module is loaded inside a worker (rangeplay's engine worker)
-sMODULARIZE -sEXPORT_ES6   loadable with import from a module worker
-sIMPORTED_MEMORY           you create the WebAssembly.Memory, so you can hand it to rangeplay's workers
-sINVOKE_RUN=0              call main() yourself, after the hand-over
-sEXPORTED_FUNCTIONS=_main,_rp_setup
```

With `-sALLOW_MEMORY_GROWTH`, rangeplay copes: the IO worker refreshes its views when the memory grows. Size the
initial memory generously anyway, since growth with pthreads has a cost in Emscripten.

## 2. Allocate the shared structures

In exactly one source file:

```c
#define RANGEPLAY_IMPLEMENTATION
#include "rangeplay.h"
#include <emscripten.h>
#include <stdlib.h>

void *rp_ctl, *rp_gpu, *rp_input;

/* Called from JavaScript before main(): allocates the structures and returns their addresses. */
EMSCRIPTEN_KEEPALIVE uint32_t *rp_setup(void) {
  static uint32_t offsets[3];
  rp_ctl = aligned_alloc(64, rp_io_bytes(32, 1024));          /* 32 slots: one per thread that reads */
  rp_io_init(rp_ctl, 32, 1024);
  rp_gpu = aligned_alloc(64, rp_ring_bytes(4 << 20));
  rp_ring_init(rp_gpu, 4 << 20);
  rp_input = aligned_alloc(64, rp_records_bytes(256, RP_INPUT_WORDS));
  rp_records_init(rp_input, 256, RP_INPUT_WORDS);
  offsets[0] = (uint32_t)(uintptr_t)rp_ctl;
  offsets[1] = (uint32_t)(uintptr_t)rp_gpu;
  offsets[2] = (uint32_t)(uintptr_t)rp_input;
  return offsets;
}
```

Use 64-bit offsets if you build with `-sMEMORY64`; the protocol carries 64-bit addresses.

## 3. The engine worker

`host.js` starts your engine as a module worker and sends it `rangeplay:start` with two ports. Load the module, hand
the memory and offsets to the IO and GPU workers, then start `main()`:

```js
// engine-worker.js
import createGame from './game.js';

self.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'rangeplay:start') return;
  const memory = new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true });   // pages of 64 KB
  const Module = await createGame({ wasmMemory: memory, rangeplayManifest: data.manifest });
  const at = Module._rp_setup() >>> 2;
  const [ctl, gpu, input] = [Module.HEAPU32[at], Module.HEAPU32[at + 1], Module.HEAPU32[at + 2]];
  data.ioPort.postMessage({ type: 'attach', memory, controlOffset: ctl });
  data.gpuPort.postMessage({ type: 'attach', memory, ringOffset: gpu });
  self.postMessage({ type: 'rangeplay:input', memory, ringOffset: input });
  Module.callMain([]);
});
```

## 4. Route the file layer

Map the engine's file paths to manifest ids once at start-up (pass the manifest to C as JSON, or generate a table at
build time). Then replace the engine's reads:

```c
int64_t n = rp_read(rp_ctl, file_id, offset, dst, len, 0);
if (n < 0) { /* RP_ERR_IO / RP_ERR_BADF / RP_ERR_INVAL */ }
```

`rp_read` is safe from any pthread. Each thread claims a slot on its first call, so create the control block with as
many slots as threads that read.

Where the engine queues reads for a streaming thread, hint each request as it is queued:

```c
rp_hint(rp_ctl, file_id, offset, len, 0);   /* 1 for "might not be needed" */
```

This is the most effective single change. A streaming thread that reads its queue one request at a time pays one
round trip per read; hinted, the IO worker fetches the whole queue at once.

## 5. Render through the command ring

```c
rp_frame_begin(rp_gpu, 2);                                /* waits while 2 frames are in flight */
uint32_t *cmd = rp_ring_reserve(rp_gpu, MY_OP_DRAW, sizeof(struct draw));
/* fill *cmd */
rp_ring_commit(rp_gpu);
rp_frame_end(rp_gpu);
```

The GPU worker imports your handler module (`gpuHandlers` in `start()`) and calls one function per opcode with the
payload's address. `examples/tile-world/gpu.js` is a complete small example. For a large renderer, design the
opcodes around what your engine already batches (pipelines, buffer updates, draws), and keep resources in tables on
the GPU worker's side, indexed by ids the engine chooses.

## 6. Input

Poll the input ring once per frame:

```c
for (int32_t *ev; (ev = rp_records_peek(rp_input)); rp_records_release(rp_input)) {
  switch (ev[RP_IN_TYPE]) { /* RP_EV_KEY_DOWN ... see docs/protocol.md */ }
}
```

## 7. Saves

Keep saves and settings out of the block cache, which is keyed to the game's data. A small JavaScript library function
that posts a save to the engine worker, which writes it to IndexedDB, is enough. Restore saves before calling `main()`.
