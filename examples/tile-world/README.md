# tile-world

A small "engine" built the way native engines are, to show rangeplay end to end. Everything it streams is generated
by `build.js`; there is no third-party content.

- **engine.js** (engine worker): mounts 36 region archives at start-up by reading each table of contents, then runs a
  blocking game loop paced by the GPU worker. It requests tiles that come into view, hints every request and the
  tiles a second and a half ahead of the camera, and draws a placeholder colour (from `minimap.bin`) until a tile
  arrives.
- **streamer.js** (a second engine thread): takes tile requests from a ring in shared memory and reads each with a
  blocking `readSync`.
- **gpu.js** (loaded by the GPU worker): `OP_UPLOAD` copies a tile into a 4096 x 4096 atlas texture; `OP_DRAW` draws
  the visible tiles as instanced quads. It falls back to a 2D canvas without WebGPU.
- **main.js**: starts the runtime and shows its statistics.

```bash
npm run demo:build
```

```bash
npm run demo
```

Open <http://localhost:8080/examples/tile-world/>. Query options: `?nobootset=1`, `?nostore=1` (no persistent
cache), `?2d=1` (no WebGPU), `?record=1` (record a boot set; then **Save boot set**), and `?timer=1` (keep drawing
while the page is hidden).

`build.js --regions N` sets the world size: N x N regions of 8 x 8 tiles, 4 MB per region.
