# Freedoom: a complete game, streamed

The Doom engine, compiled from C to WebAssembly with Emscripten, plays [Freedoom](https://freedoom.github.io/), a
complete free game: Phase 1 has 36 levels and Phase 2 has 32. Every WAD read the engine makes goes through
`rp_read`, so the game data streams from the CDN as the engine asks for it, instead of being downloaded whole before
the first frame. That whole-download approach is what the engine's stock Emscripten port does with `--preload-file`.

This is the example to read if you are bringing a native engine to rangeplay. The engine itself is unchanged.
Everything rangeplay-specific is in one file:

- **[platform.c](platform.c):** the engine's platform layer. It provides the WAD file class (open and read through
  `rp_read`), frame output through the command ring, key input from the input ring, and the clock.
- **[engine.js](engine.js):** the engine worker. It loads the Emscripten module, hands its memory to rangeplay's
  workers (`attachWasm`), registers the manifest's files with the engine, and calls `main()`.
- **[gpu.js](gpu.js):** uploads each frame to a texture and draws it at 4:3 (WebGPU, or a 2D canvas).
- **[main.js](main.js):** the page. It uses a recorded boot set (`bootset-1.json`, `bootset-2.json`), then installs
  the rest of the game in the background (`io: { backgroundFill: [iwad] }`).

## What happens on a first visit

1. The page starts the IO worker. It begins fetching the boot set at once: the 14.7 MB of the WAD that the engine
   reads between start-up and the first demo level, as about 1,200 ranges.
2. In parallel, the 405 KB engine downloads and compiles, and `main()` starts on a pthread.
3. The engine mounts the WAD (header and lump directory), then reads palettes, textures, sprites, the status bar and
   the first level, about 2,600 reads in all. Reads the boot set has already brought are served from the cache;
   the rest block their thread until their bytes arrive.
4. Once the boot set is in, the rest of the WAD downloads at low priority. Reads the engine blocks on always go
   first.

Return visits read everything from the cache on the device.

Without the boot set (`?nobootset=1`), those 2,600 start-up reads are one network round trip each. On a link with
40 ms of latency, that is most of a minute before the first frame.

## Build

```bash
node examples/freedoom/build.js
```

This downloads Freedoom 0.13.0 (SHA-256 checked), extracts the WADs and packs them into `dist/`.

```bash
node examples/freedoom/build-wasm.js
```

This rebuilds `wasm/doom.js` and `wasm/doom.wasm` (needs Emscripten; set `EMSDK`). It fetches doomgeneric at a pinned
commit and compiles it with `platform.c`. The output is committed, so the demo builds without Emscripten.

## Two lessons from the port

- **`emscripten_get_now()` counts from the Unix epoch in threaded builds.** Cast to a 32-bit millisecond counter, it
  saturates, so the engine's clock stops and it waits forever for its first tic. Count from the first call instead.
- **Find hangs with `game.debug()`.** It shows what the IO worker and GPU worker see in shared memory: whether an
  engine thread waits on a read, and whether frames are being submitted and drawn.

## Licenses

- Freedoom's data is BSD-3-Clause (see [COPYING](https://github.com/freedoom/freedoom/blob/master/COPYING.adoc)). The
  build copies its `COPYING.txt` and `CREDITS.txt` next to the data it serves.
- The Doom engine source is GPL-2.0 (id Software; [doomgeneric](https://github.com/ozkl/doomgeneric) by ozkl, based
  on Chocolate Doom). The compiled `wasm/doom.wasm` is therefore GPL-2.0. Its source is doomgeneric at commit
  `dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284` plus `platform.c`, and `build-wasm.js` reproduces it.
- `platform.c`, `engine.js`, `gpu.js`, `main.js` and the build scripts are MIT, like the rest of rangeplay.
