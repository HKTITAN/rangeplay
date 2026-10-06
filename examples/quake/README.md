# LibreQuake: a 210 MB game, streamed a level at a time

The Quake engine, compiled from C to WebAssembly with Emscripten, plays [LibreQuake](https://github.com/lavenderdotpet/LibreQuake),
a free game for Quake engines. The game is 210 MB: two pak files of 95 and 101 MB with the campaign, plus 13 deathmatch
maps, 54 maps in all. Every file read the engine makes goes through `rp_read`. The engine reads a level when it
loads it, so a level is downloaded when you get there, and data the engine never asks for is never downloaded. That
includes other levels you don't visit, and 57 MB of colored-light files that this 1996 renderer doesn't use.

![LibreQuake's first demo running in the browser, with rangeplay's streaming stats](../../docs/quake.jpg)

## What happens on a first visit

1. The page starts the IO worker, which begins fetching the boot set at once: 22.9 MB in 121 ranges. That covers
   start-up (palettes, fonts, the console, the QuakeC game code, sounds) and the first demo's level.
2. In parallel, the 414 KB engine downloads and compiles, and `main()` starts on a pthread.
3. The engine opens both paks and reads their directories (two small reads of 24 KB and 7 KB), then runs `quake.rc`.
   It shows its console, then plays the first demo, which loads a 9.8 MB level.

On the dev server's simulated network (40 ms latency, 3 MB/s per response), the first frame takes 1.5 s, and the
demo's level is loaded at **4.1 s**: 8 of its 210 reads waited on the network. Without the boot set (`?nobootset=1`) it is
loaded at **19.7 s**, with 202 reads waiting one round trip each. On a return visit nothing is downloaded: first frame in
0.5 s, level loaded at 2.1 s.

**Play** (`?map=start`) starts in the episode-select level instead, with its own boot set of 7.9 MB. Any other
level name also works, such as `?map=lq_e1m1`. The whole game is not installed in the background by default, since
210 MB is a lot to send to every visitor. `?install=1` downloads it while you play.

## The files

- **[platform.c](platform.c):** the engine's platform layer. Everything rangeplay-specific in the engine is in this file:
  - **Files:** the game's files are read through `rp_read`. `config.cfg` and saved games stay in memory.
  - **Video:** 8-bit frames, plus the palette, go through the command ring.
  - **Sound:** the audio ring is the "DMA buffer" behind id's own mixer.
  - **Input:** keys and pointer-locked mouse movement come from the input ring.
  - **Main loop and clock.**
- **[engine.patch](engine.patch):** what the engine needed for LibreQuake (see below). It is GPL-2.0, like the code it changes.
- **[engine.js](engine.js):** the engine worker. It loads the module, hands its memory to rangeplay's workers,
  registers the manifest's files, and calls `main()`.
- **[gpu.js](gpu.js):** uploads each frame as an 8-bit texture and looks up the palette in the fragment shader, so a
  640 × 480 frame is 300 KB through the ring instead of 1.2 MB. The 2D canvas fallback does the lookup in JavaScript.
- **[main.js](main.js):** the page, with two recorded boot sets: [bootset.json](bootset.json) for the demos and
  [bootset-start.json](bootset-start.json) for Play.

## What the engine needed

LibreQuake's maps are built for today's Quake engines (QuakeSpasm, Ironwail, FTE), which lifted the original's limits.
The first demo's level has 39,798 faces and 11,269 leafs. The original reads face indices as signed 16-bit numbers and
sizes its visibility tables for 8,192 leafs. The result was not an error message but memory corruption, which surfaced
as a crash deep in the renderer. `engine.patch` adds what the modern engines added:

- Indices up to 65,535 for faces, mark surfaces, nodes and clip nodes, and 65,536 leafs. Maps in the BSP2 format
  (episode 2's fourth level).
- FitzQuake's network protocol (666), which the built-in server now speaks. It allows more than 256 models and sounds,
  which four levels need: the second demo's level has 400.
- Playback of demos recorded with FitzQuake's protocol and with RMQ's (999), which the third demo uses.
- Larger fixed tables for entities, static entities, messages and sound channels.
- An `objerror` in a level's QuakeC removes the faulty entity instead of ending the game, as in FitzQuake. One level has
  such an entity.

With the patch, all 54 maps load and all three demos play. A Node harness checks this headless (the engine built with
`-sNODERAWFS`, reading the files from disk).

## Build

```bash
node examples/quake/build.js
```

This downloads LibreQuake v0.09-beta (115 MB, SHA-256 checked), takes out the paks, the deathmatch maps and the
configs, and packs them into `dist/`. The music is left out: it is Ogg Vorbis, which this engine can't play.

```bash
node examples/quake/build-wasm.js
```

This rebuilds `wasm/quake.js` and `wasm/quake.wasm` (needs Emscripten; set `EMSDK`). It fetches quakegeneric at a
pinned commit and id's three sound files at a pinned commit, applies `engine.patch`, and compiles them with
`platform.c`. The output is committed, so the demo builds without Emscripten.

## Lessons from the port

- **Data can outgrow the engine it was made for.** Every limit LibreQuake hit showed up first as corrupted memory, far
  from its cause. What found the causes quickly: a build with `-sSAFE_HEAP=1`, and a Node build that plays the demos
  headless and writes the last frame to an image.
- **Not every read goes through the engine's file functions.** Quake opens demos with `fopen` and reads them with
  `fread`, straight from the pak. The link wraps `fopen` (`-Wl,--wrap=fopen`). Game files open as `fopencookie` streams
  whose reads are `rp_read`s; everything else goes to the real `fopen`.
- **`emscripten.h` includes `<stdbool.h>`.** Its `true` and `false` macros break Quake's own boolean type
  (`typedef enum {false, true} qboolean`). `platform.c` doesn't include it, and uses `clock_gettime` for time.
- **An old sound mixer fits the audio ring.** id's mixer asks where the sound card is playing, and mixes 0.1 s ahead of
  that. Here, "where it is playing" is the number of frames the AudioWorklet has taken from the ring. Until the page
  starts audio (on the first click or key press), nothing is taken, so nothing more is mixed.

## Licenses

- LibreQuake's maps, models, textures and sounds are BSD-3-Clause. Its QuakeC game code (`progs.dat`) and `pop.lmp`
  are GPL-2.0, with source in the [LibreQuake repository](https://github.com/lavenderdotpet/LibreQuake). The build
  copies the license files next to the data it serves.
- The engine source is GPL-2.0: id Software's Quake, as cut down by [quakegeneric](https://github.com/erysdren/quakegeneric)
  (erysdren), plus id's `snd_dma.c`, `snd_mem.c` and `snd_mix.c`, plus `engine.patch`. The compiled `wasm/quake.wasm`
  is therefore GPL-2.0. Its source is:
  - quakegeneric at commit `13052102577c629650cf07a46151a4b6e1b19c3c`;
  - id's sound files from [id-Software/Quake](https://github.com/id-Software/Quake) at commit `bf4ac424ce754894ac8f1dae6a3981954bc9852d`;
  - `engine.patch` and `platform.c`.

  `build-wasm.js` reproduces it.
- `platform.c`, `engine.js`, `gpu.js`, `main.js` and the build scripts are MIT, like the rest of rangeplay.
