// Fetches Freedoom (a complete, free game for the Doom engine: BSD-3-Clause) and packs it for streaming.
//   node examples/freedoom/build.js
// Output: examples/freedoom/dist (manifest.json, data/, COPYING.txt). The engine itself is prebuilt in wasm/ (see
// build-wasm.js); this script needs only Node.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from '../../tools/pack.js';
import { download, unzip } from '../shared/fetch.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const FREEDOOM = {
  url: 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip',
  sha256: '3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59',
};

const zip = await download(FREEDOOM.url, join(here, '.build', 'freedoom-0.13.0.zip'), FREEDOOM.sha256);
const files = unzip(zip, (name) => /\/(freedoom[12]\.wad|COPYING\.txt|CREDITS\.txt)$/.test(name));
const assets = join(here, '.assets'), dist = join(here, 'dist');
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  const base = name.split('/').pop();
  if (base.endsWith('.wad')) await writeFile(join(assets, base), bytes);
  else await writeFile(join(here, '.build', base), bytes);
}
await rm(dist, { recursive: true, force: true });
await pack({ src: assets, out: dist, name: 'freedoom', log: console.log });
// The license asks binary redistributions to carry it: it is served next to the data.
await copyFile(join(here, '.build', 'COPYING.txt'), join(dist, 'COPYING.txt'));
await copyFile(join(here, '.build', 'CREDITS.txt'), join(dist, 'CREDITS.txt'));
console.log('freedoom: ready in examples/freedoom/dist');
