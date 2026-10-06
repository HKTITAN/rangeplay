// Builds the deployable demo into site/: the runtime (src/), the tile-world page and its generated data, with the
// same paths as in the repository, so the page's relative imports work unchanged.
//   node scripts/build-site.js [--regions 6]
// vercel.json runs this and serves site/ with the headers the runtime needs.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { regions: { type: 'string' } } });
const site = join(root, 'site');
const demo = join(root, 'examples', 'tile-world');

execFileSync(process.execPath, [join(demo, 'build.js'), '--regions', values.regions || '6'], { stdio: 'inherit' });

await rm(site, { recursive: true, force: true });
await mkdir(join(site, 'examples', 'tile-world'), { recursive: true });
await cp(join(root, 'src'), join(site, 'src'), { recursive: true });
for (const f of ['index.html', 'main.js', 'engine.js', 'streamer.js', 'gpu.js', 'world.js']) {
  await cp(join(demo, f), join(site, 'examples', 'tile-world', f));
}
await cp(join(demo, 'dist'), join(site, 'examples', 'tile-world', 'dist'), { recursive: true });
await writeFile(join(site, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>rangeplay</title>
<meta http-equiv="refresh" content="0; url=/examples/tile-world/">
<a href="/examples/tile-world/">tile-world: the rangeplay demo</a>
`);
console.log('site/ ready');
