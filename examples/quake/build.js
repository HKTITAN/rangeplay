// Fetches LibreQuake (a complete, free game for the Quake engine) and packs it for streaming.
//   node examples/quake/build.js
// Output: examples/quake/dist (manifest.json, data/, the licenses). The engine itself is prebuilt in wasm/ (see
// build-wasm.js); this script needs only Node.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from '../../tools/pack.js';
import { download, unzip } from '../shared/fetch.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const LIBREQUAKE = {
  url: 'https://github.com/lavenderdotpet/LibreQuake/releases/download/v0.09-beta/full.zip',
  sha256: '623e463b35811216244f9ba15e0c45abc1765288650b5e3d36a899b35e4bcf3d',
};
// What the engine can use: the two paks (the campaign), the deathmatch maps and the small config files. Left out: the
// music (Ogg Vorbis, which this 1996 engine cannot play) and the project's artwork.
const GAME = /^full\/(id1\/(pak\d\.pak|[^/]+\.cfg|maps\/[^/]+))$/;
const LICENSES = {
  'full/id1/docs/COPYING': 'COPYING.txt',                                // BSD-3-Clause: maps, models, textures, sounds
  'full/id1/docs/CREDITS': 'CREDITS.txt',
  'full/id1/docs/misc-docs/COPYING': 'COPYING-GPL-2.0.txt',             // GPL-2.0: the game code (progs.dat) and pop.lmp
  'full/id1/docs/README-IMPORTANT-LICENCE-INFO': 'LICENSES.txt',
};

const zip = await download(LIBREQUAKE.url, join(here, '.build', 'librequake-0.09-beta-full.zip'), LIBREQUAKE.sha256);
const files = unzip(zip, (name) => GAME.test(name) || name in LICENSES);
const assets = join(here, '.assets'), dist = join(here, 'dist');
await rm(assets, { recursive: true, force: true });
for (const [name, bytes] of Object.entries(files)) {
  if (name in LICENSES) continue;
  const path = join(assets, name.match(GAME)[1]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
await rm(dist, { recursive: true, force: true });
await pack({ src: assets, out: dist, name: 'librequake', log: console.log });
// The licenses ask binary redistributions to carry them: they are served next to the data.
for (const [name, as] of Object.entries(LICENSES)) await writeFile(join(dist, as), files[name]);
console.log('quake: ready in examples/quake/dist');
