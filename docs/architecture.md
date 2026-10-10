# Architecture

rangeplay runs a game the way a console runs "play as you download". The executable comes first, the data arrives
while the game starts, and the game reads whatever it needs, waiting only for the bytes that are not there yet. Here
the executable is a WebAssembly (or JavaScript) engine in a browser tab, and the data lives on a CDN.

## Threads

| Thread                | Started by     | Owns                                              | Blocks?                                  |
| --------------------- | -------------- | ------------------------------------------------- | ---------------------------------------- |
| Page (main thread)    | the browser    | the DOM, the canvas element, input events         | never                                    |
| Engine thread(s)      | `host.js`      | the game: logic, physics, asset streaming         | yes: on reads, on frame pacing           |
| IO worker             | `host.js`      | the network, the block cache (OPFS)               | never (event loop, `Atomics.waitAsync`)  |
| GPU worker            | `host.js`      | the WebGPU device and the canvas (OffscreenCanvas)| never                                    |

They share memory: one SharedArrayBuffer, or the engine's shared `WebAssembly.Memory`. The engine allocates three
structures in it and hands their offsets to the workers. The IO control block holds read slots and a hint ring. The
command ring carries GPU commands. The input ring carries input events from the page. [protocol.md](protocol.md)
gives the byte layouts.

## A read, step by step

1. An engine thread fills its slot (file id, offset, length, destination address), sets the slot to *requested*, bumps
   the doorbell word and waits on the slot with `Atomics.wait`.
2. The IO worker wakes on the doorbell (`Atomics.waitAsync`), takes the slot, and checks which cache blocks the read
   covers.
3. Blocks already in the store are copied straight into the destination. A `FileSystemSyncAccessHandle.read` goes into
   a view of shared memory, with no intermediate buffer.
4. Missing blocks are fetched with HTTP Range requests. If another fetch is already bringing them (a hint, read-ahead,
   the boot set), the read joins it and promotes it to high priority. Otherwise the read starts its own fetch, split
   into parallel slices when it is large. Response bodies are written into the store chunk by chunk as they arrive.
5. When every block is in, the IO worker copies the bytes, writes the result, sets the slot to *done* and notifies.
   The engine thread wakes up and continues.

## Decisions, and why

**Engine threads block; the IO worker does not.** Native engines read files synchronously from many threads.
Rewriting that as async code is the most expensive part of a port, so rangeplay keeps it. Blocking is fine in a
worker (`Atomics.wait`). The network work happens in one worker that never blocks and so always has an event loop
for fetch.

**Why not synchronous XHR from each engine thread?** It works, and it is what most ports try first. But every
response becomes a fresh JavaScript buffer in the thread that made the request. A thread that spends its life inside
wasm or blocked in `Atomics.wait` rarely runs garbage collection, so the buffers pile up, and a few gigabytes of reads
can mean gigabytes of renderer memory. In rangeplay, response chunks go from `fetch` straight into the OPFS store and
from the store straight into engine memory. No thread holds on to response buffers.

**Small cache blocks (4 KB by default), large fetches.** Engines open many archives at start-up and read only each
one's table of contents: a few kilobytes at the front of a large file. With large cache blocks, every such read would
download far more than it needs. So the cache works in small blocks, while fetches stay large. Adjacent missing blocks
become one request, sequential reads trigger read-ahead, and boot-set ranges close together are merged.

**Read-ahead only for large sequential reads.** A read that continues the previous read of the same file, and is at
least 64 KB, starts a read-ahead window that doubles up to 1 MB. Small scattered reads fetch only themselves. All of
these thresholds are options of `IoCore`.

**Distrust the network.** A response that delivers no bytes for 15 s is abandoned and retried from where it stopped.
An HTML page, or a file whose size disagrees with the manifest, is refused rather than cached: think of a missing
object behind a single-page app's fallback route, or a stale cache. A server that caps range sizes is asked for the
rest. When one slice of a read fails, its sibling slices are cancelled.

**Two priorities, and promotion.** Reads an engine thread is blocked on are fetched at once with `priority: 'high'`.
Hints go through a lane of 32 concurrent fetches. Read-ahead and speculative hints use a lane of 8 at
`priority: 'low'`; the boot set has its own 16 low-priority fetches. Without this, a blocked read can sit behind
megabytes of speculation on the same connection. When a blocked read needs blocks still queued in a lane, that fetch
is promoted: it starts immediately at high priority.

**Blocked reads are sliced.** On many hosts a single stream is limited by round trips rather than bandwidth. A large
read the engine waits on is fetched as parallel 256 KB slices, which shortens the wait. Background fetches stay whole,
because for them the number in flight is what sets the speed.

**Hint every queued read.** Engines often keep a streaming queue served by one thread, one read at a time. Each read
then costs a full round trip, so a hundred queued reads take a hundred round trips. If the engine hints each request
when it queues it, the IO worker fetches them all at once and the streaming thread mostly finds its bytes waiting. The
tile-world demo does this, and it took its cold fill from about 11 s to about 7 s.

**Boot sets.** An engine reads almost the same bytes on every start. A recorded list of those ranges, in
first-touch order, can be fetched in parallel while the engine's own code is still downloading and compiling.
Without it, start-up is a chain of blocking reads, one round trip each. In the demo it is the difference between
2.4 s and 0.6 s to the first frame.

**Content-addressed objects.** `rangeplay pack` stores each file under its SHA-256 prefix (`data/ab/ab12…`):

- A URL's bytes never change, so the CDN and the browser can cache it for a year (`immutable`), with no
  invalidations on deploy.
- Identical files are stored and downloaded once.
- A new version changes only the URLs of files that changed. Old objects can stay published for players still running
  the old manifest.
- The persistent cache keys blocks by content hash, not by path or version, so after an update the player keeps
  everything that did not change.

**Packs for small files.** A large game can ship thousands of small files: shaders, scripts, configs. As objects of
their own, each costs a request even when a boot set fetches them in parallel, and the host stores thousands of
objects. `rangeplay pack --pack-small 64k` stores files under 64 KB back to back in packs (format 2 in
[protocol.md](protocol.md)). The IO worker reads a packed file as a range of its pack, so neighbouring files merge into
one Range request, in the boot set and in the cache alike.

- *Why not a batch endpoint?* A server could take a list of ranges of many files and answer them in one response. That
  needs code on the server, and rangeplay runs on any static host. Packs get the same effect from plain Range requests,
  and the CDN can cache them.
- *Where a pack ends depends on paths, not on running totals.* A pack ends before a file whose path hashes to a
  multiple of a stride, chosen so that packs average a quarter of `--pack-max` (4 MB by default). If packs were filled
  up to the cap instead, one file that grew would shift every pack after it, and an update would invalidate all of
  them. This way an update changes the pack of the file that changed, and rarely the next one.
- `--order bootset.json` lays packs out in the order of first touch, so start-up reads sit next to each other.
- A read that continues the previous read of the same pack starts read-ahead whatever its size: that is a loader
  walking through small files in order, which then finds the next files already fetched.
- A pack that would hold one file is left out: that file keeps its own object.

On the dev server's simulated network (40 ms latency, 3 MB/s per response), loading 600 files of 1 to 24 KB, out of
2,000, one after another on one thread:

| Layout                       | Without a boot set        | With a boot set        | Objects on the host |
| ---------------------------- | ------------------------- | ---------------------- | ------------------- |
| One object per file          | 35.7 s, 600 requests      | 2.2 s, 600 requests    | 2,001               |
| Packs (`--pack-small 64k`)   | 3.0 s, 263 requests       | 0.5 s, 19 requests     | 20                  |

The cost: changing one small file re-downloads its pack (up to `--pack-max`), not just the file.

**Append-only store with a journal.** `data.bin` only grows: a fetch reserves room at the end and streams into it.
`journal.bin` records which block lives where, and is written only after the data it points to is flushed. Entries
are 32 bytes, so none straddles a disk page. Each carries a checksum and the store's generation (new at every reset),
and the journal is reset before the data. Damaged or stale entries are dropped, and the journal is rewritten without
them. A crash or a closed tab can lose recent blocks, but never index unwritten data. On load, entries for files not in the current
manifest are dead space. When more than half of a store over 64 MB is dead, it starts over. Real compaction is on the
roadmap.

**One tab owns the store.** Sync access handles are exclusive. A Web Lock decides which tab gets the persistent store;
a second tab falls back to an in-memory cache instead of waiting forever. At `pagehide` the page hands the store back:
it flushes and closes it, and switches to the memory cache. The next page, or another tab, can take it. If the page
comes back from the back/forward cache, it takes the store again.

**When OPFS is unavailable or full,** the IO worker caches in memory (an LRU of fetched runs) and lets the browser's
HTTP cache keep responses (`cache: 'default'` instead of `'no-store'`). A read pins its blocks until it has copied
them, so concurrent fetches cannot evict them first.

**The GPU in its own worker.** Requesting an adapter and a device, mapping buffers, catching errors and presenting a
frame all need an event loop, and WebGPU objects cannot move between threads. Engine threads have neither. So one
worker owns the device and the canvas, and the engine writes commands into a ring. The GPU worker executes them,
waits for an animation frame at each `OP_FRAME_END`, and counts the frame as done. Waiting for that count paces the
engine to the display: `beginFrame()` blocks while two frames are in flight.

**A lost GPU device is replaced.** Drivers reset, the browser's GPU process crashes, laptops switch GPUs: WebGPU
reports each as a lost device, and everything drawn with it stops. The GPU worker then requests a new device,
reconfigures the canvas and runs the handlers' `setup()` again (with `ctx.restored` counting restorations), while
commands wait in the ring. Handlers that draw what each frame brings, like the Doom and Quake examples, recover with
no help; handlers that uploaded resources once must upload them again. A device lost twice within 10 s, or more than
three times, is reported through `onError` instead, since retrying would only loop. The page hears of each loss and
restoration (`onGpuLost`, `onGpuRestored`).

**Say which GPU.** A black canvas looks the same whatever its cause. The GPU worker records the adapter (vendor,
architecture, description), whether it is a software fallback, its features and key limits, why it fell back to the 2D
canvas if it did, and counts uncaptured WebGPU errors (logging the first few, not one per frame). `game.gpu()` returns
it, and `game.debug()` includes it. The browser check page (`examples/check/`) runs the same tests without a game, plus
the on-device cache and the network path to the data, and gives the player a report to paste into a bug report.

**Commands are yours.** rangeplay moves bytes and defines `OP_FRAME_END`. What the other opcodes mean is up to the
engine's renderer and its handler module (see `examples/tile-world/gpu.js`). Translating an engine's renderer into
such commands is the real porting work, and rangeplay does not do it for you.

**Audio is a ring an AudioWorklet drains.** The engine's mixer runs wherever the engine runs and writes float PCM into
a ring in shared memory. An AudioWorklet copies 128 frames per render quantum from that ring to the speakers. There
are no messages and no copies through the page, and the worklet never waits: if the ring runs short, it plays silence
and counts an underrun. The engine keeps a modest amount queued, about 85 ms in the Doom example, so latency stays low
and a slow frame does not starve the speakers. Browsers allow audio only after a user gesture, so the host creates the
AudioContext on the first click or key press. A level meter in the ring header shows whether sound is actually
reaching the worklet, not just samples.

**Input goes through shared memory too.** The page writes DOM events into a ring of fixed-size records and never
blocks: if the ring is full, the event is dropped and counted. The engine polls the ring once per frame.

**A stall watchdog.** Before the first frame, the host compares the IO statistics every 2 s. If nothing has changed for
`stallMs` (30 s by default), it calls `onStall` with `game.debug()`: what each engine thread is waiting for and where
the command ring stands. A tab that runs out of memory dies without a word, but a stalled or deadlocked one can still
report.

**Short waits on Windows.** Chrome on Windows rounds an `Atomics.wait` timeout up to the system timer tick, 15.6 ms,
unless the process has a short timer pending. We measured a 1 ms wait taking 15.4 ms on Chromium 152. An engine that
sleeps 1 ms at a time then runs in 15.6 ms steps. `fineTimers: true` keeps an empty 1 ms interval running on the
page, a known workaround. It is off by default because it costs a little power, and we have not been able to confirm
its effect in our own test setup, whose browser pane was hidden.

## What a port still needs

- The engine compiled to wasm with threads (Emscripten `-pthread`), its main loop off the page's main thread.
- Its file layer routed to `rp_read`, its streaming queue sending `rp_hint`s.
- A renderer that emits commands, plus a handler module that turns them into WebGPU calls.
- Its saves written somewhere persistent (IndexedDB from a worker is enough; the block cache is not the place for them).
- A recorded boot set.

## Measured in the demo

On the dev server (localhost, HTTP/1.1, 40 ms added latency, 3 MB/s per response) in Chromium 152:

| Visit                          | Engine start (archives mounted) | Downloaded before the first frame |
| ------------------------------ | -------------------------------- | --------------------------------- |
| First, with the boot set       | 0.59 s                           | 10 MB (prefetched in 1.3 s)       |
| First, without the boot set    | 2.35 s                           | about 0.2 MB, one round trip at a time |
| Return visit (OPFS warm)       | 0.09 to 0.15 s                   | nothing                           |

The dev server speaks HTTP/1.1, so the browser opens at most six connections to it. A CDN on HTTP/2 or HTTP/3
multiplexes every fetch over one connection, so numbers there will differ, mostly in rangeplay's favour.
