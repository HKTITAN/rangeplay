// Generates tile-world's data (a procedural landscape, ~150 MB), packs it, and writes a starting boot set.
//   node examples/tile-world/build.js [--regions 6]
// Output: examples/tile-world/.assets (raw files), examples/tile-world/dist (manifest.json, bootset.json, data/)

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pack } from '../../tools/pack.js';
import { BOOTSET_FORMAT } from '../../src/shared/bootset.js';
import { HEADER_BYTES, REGION_MAGIC, regionPath, tocBytes } from './world.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({ options: { regions: { type: 'string' } } });
const REGIONS = Number(values.regions || 6);
const REGION_TILES = 8;
const TILE = 128;
const WORLD_TILES = REGIONS * REGION_TILES;
const WORLD_PX = WORLD_TILES * TILE;
const SPAWN = [WORLD_TILES / 2, WORLD_TILES / 2];

// ---- terrain: fractal value noise, coloured by height, lit from the north-west ----
const PERM = new Uint8Array(512);
{
  let s = 1234567;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const smooth = (t) => t * t * (3 - 2 * t);
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const v = (a, b) => PERM[PERM[a] + b] / 255;
  const u = smooth(xf), w = smooth(yf);
  const a = v(X, Y) + u * (v(X + 1, Y) - v(X, Y));
  const b = v(X, Y + 1) + u * (v(X + 1, Y + 1) - v(X, Y + 1));
  return a + w * (b - a);
}
function height(px, py) {
  const x = px / WORLD_PX, y = py / WORLD_PX;
  let h = 0, amp = 0.5, f = 3;
  for (let o = 0; o < 8; o++) {
    h += amp * noise(x * f + o * 17.3, y * f + o * 9.1);
    amp *= o < 3 ? 0.5 : 0.56;   // keep some fine detail: it is what you see up close
    f *= 2.03;
  }
  // an island: lower towards the edges
  const dx = x - 0.5, dy = y - 0.5;
  return h - Math.max(0, Math.sqrt(dx * dx + dy * dy) - 0.32) * 1.6;
}
const SEA = 0.4;
// colour ramp by height: deep sea, shallows, beach, grass, forest, rock, snow
const STOPS = [
  [0.20, [10, 34, 84]], [0.36, [24, 76, 140]], [0.395, [52, 128, 170]], [0.40, [214, 200, 150]], [0.415, [198, 186, 132]],
  [0.44, [118, 160, 74]], [0.54, [78, 132, 58]], [0.62, [44, 94, 48]], [0.69, [96, 98, 76]], [0.75, [128, 120, 108]],
  [0.80, [160, 156, 150]], [0.84, [236, 238, 242]],
];
function colour(h) {
  if (h <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    if (h < STOPS[i][0]) {
      const [h0, c0] = STOPS[i - 1], [h1, c1] = STOPS[i], t = (h - h0) / (h1 - h0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return STOPS[STOPS.length - 1][1];
}
const grain = (x, y) => {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) & 255) / 255 - 0.5;
};

function renderTile(tx, ty) {
  const out = new Uint8Array(TILE * TILE * 4);
  // heights on a grid of 2-pixel steps (with a border), bilinear in between: 4x fewer noise evaluations
  const G = TILE / 2 + 3, hs = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) hs[j * G + i] = height(tx * TILE + i * 2 - 2, ty * TILE + j * 2 - 2);
  const H = (x, y) => {
    const gx = (x + 2) / 2, gy = (y + 2) / 2, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const a = hs[j * G + i], b = hs[j * G + i + 1], c = hs[(j + 1) * G + i], d = hs[(j + 1) * G + i + 1];
    return a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fy;
  };
  const sum = [0, 0, 0];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const h = H(x, y);
      let [r, g, b] = colour(h);
      let shade;
      if (h < SEA) {
        shade = 1 + grain(tx * TILE + x, ty * TILE + y) * 0.04;
      } else {
        // light from the north-west: compare with the height two pixels towards the light
        const slope = (H(x - 2, y - 2) - H(x + 1, y + 1)) * 160;
        shade = Math.min(1.45, Math.max(0.5, 1 + slope)) + grain(tx * TILE + x, ty * TILE + y) * 0.07;
      }
      if (x === 0 || y === 0) shade *= 0.9;   // a faint tile grid, to see tiles arrive
      const o = (y * TILE + x) * 4;
      out[o] = Math.min(255, Math.max(0, r * shade));
      out[o + 1] = Math.min(255, Math.max(0, g * shade));
      out[o + 2] = Math.min(255, Math.max(0, b * shade));
      out[o + 3] = 255;
      sum[0] += out[o];
      sum[1] += out[o + 1];
      sum[2] += out[o + 2];
    }
  }
  const n = TILE * TILE;
  return { pixels: out, average: [sum[0] / n, sum[1] / n, sum[2] / n] };
}

const assets = join(here, '.assets'), dist = join(here, 'dist');
await rm(assets, { recursive: true, force: true });
await mkdir(join(assets, 'world'), { recursive: true });

const t0 = Date.now();
const minimap = new Uint8Array(WORLD_TILES * WORLD_TILES * 4);
const toc = tocBytes(REGION_TILES), tileBytes = TILE * TILE * 4;
for (let ry = 0; ry < REGIONS; ry++) {
  for (let rx = 0; rx < REGIONS; rx++) {
    const count = REGION_TILES * REGION_TILES;
    const file = new Uint8Array(toc + count * tileBytes);
    const dv = new DataView(file.buffer);
    dv.setUint32(0, REGION_MAGIC, true);
    dv.setUint32(4, TILE, true);
    dv.setUint32(8, REGION_TILES, true);
    dv.setUint32(12, count, true);
    for (let k = 0; k < count; k++) {
      const tx = rx * REGION_TILES + (k % REGION_TILES), ty = ry * REGION_TILES + Math.floor(k / REGION_TILES);
      const { pixels, average } = renderTile(tx, ty);
      const at = toc + k * tileBytes;
      dv.setUint32(HEADER_BYTES + k * 8, at, true);
      dv.setUint32(HEADER_BYTES + k * 8 + 4, tileBytes, true);
      file.set(pixels, at);
      minimap.set([...average, 255], (ty * WORLD_TILES + tx) * 4);
    }
    await writeFile(join(assets, ...regionPath(rx, ry).split('/')), file);
  }
  process.stdout.write(`\rgenerating: ${Math.round(((ry + 1) / REGIONS) * 100)}%`);
}
await writeFile(join(assets, 'minimap.bin'), minimap);
await writeFile(join(assets, 'world.json'), JSON.stringify({ tileSize: TILE, regionTiles: REGION_TILES, regions: REGIONS, spawn: SPAWN }));
console.log(`\ngenerated ${WORLD_TILES}x${WORLD_TILES} tiles in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await rm(dist, { recursive: true, force: true });
await pack({ src: assets, out: dist, name: 'tile-world', log: console.log });

// A starting boot set: what the engine reads before its first frame (world.json, the minimap, every region's table of
// contents) plus the tiles around the spawn point. A real game records this instead: start it with ?record=1, play
// the opening, press "Save boot set" and merge recordings with `rangeplay bootset merge`.
const files = [['world.json', [[0, 1 << 20]]], ['minimap.bin', [[0, minimap.length - 1]]]];
for (let ry = 0; ry < REGIONS; ry++) for (let rx = 0; rx < REGIONS; rx++) files.push([regionPath(rx, ry), [[0, toc - 1]]]);
const near = new Map();
for (let ty = SPAWN[1] - 5; ty < SPAWN[1] + 5; ty++) {
  for (let tx = SPAWN[0] - 8; tx < SPAWN[0] + 8; tx++) {
    const p = regionPath(Math.floor(tx / REGION_TILES), Math.floor(ty / REGION_TILES));
    const k = (ty % REGION_TILES) * REGION_TILES + (tx % REGION_TILES);
    if (!near.has(p)) near.set(p, []);
    near.get(p).push([toc + k * tileBytes, toc + (k + 1) * tileBytes - 1]);
  }
}
for (const [p, ranges] of near) files.push([p, ranges]);
await writeFile(join(dist, 'bootset.json'), JSON.stringify({ format: BOOTSET_FORMAT, files }));
console.log('wrote dist/bootset.json');
