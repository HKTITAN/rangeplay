// Builds the deployable demo site into site/: the runtime (src/), each example's page and its data, at the same paths
// as in the repository (so the pages' relative imports work unchanged), and a landing page.
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
const node = (...args) => execFileSync(process.execPath, args, { stdio: 'inherit', cwd: root });

node('examples/tile-world/build.js', '--regions', values.regions || '6');
node('examples/freedoom/build.js');
node('examples/quake/build.js');

await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(join(root, 'src'), join(site, 'src'), { recursive: true });

const EXAMPLES = {
  'tile-world': ['index.html', 'main.js', 'engine.js', 'streamer.js', 'gpu.js', 'world.js', 'dist'],
  freedoom: ['index.html', 'main.js', 'engine.js', 'gpu.js', 'wasm', 'bootset-1.json', 'bootset-2.json', 'dist'],
  quake: ['index.html', 'main.js', 'engine.js', 'gpu.js', 'wasm', 'bootset.json', 'bootset-start.json', 'dist'],
  check: ['index.html', 'check.js'],
};
for (const [name, entries] of Object.entries(EXAMPLES)) {
  for (const entry of entries) {
    await cp(join(root, 'examples', name, entry), join(site, 'examples', name, entry), { recursive: true });
  }
}
await cp(join(root, 'docs', 'tile-world.jpg'), join(site, 'tile-world.jpg'));
await cp(join(root, 'docs', 'freedoom-card.jpg'), join(site, 'freedoom.jpg'));
await cp(join(root, 'docs', 'quake-card.jpg'), join(site, 'quake.jpg'));

await writeFile(join(site, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rangeplay</title>
<meta name="description" content="Play-as-you-download for the web: a game engine runs in the browser tab and streams its data from a CDN.">
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; --bg: #0b0d12; --card: #141821; --line: rgba(255,255,255,.1); --text: #e9ecf2; --dim: #9aa3b2; --accent: #7cb7ff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font-size: 34px; line-height: 1.15; margin: 0 0 10px; letter-spacing: -.01em; }
  p.lede { color: var(--dim); max-width: 680px; margin: 0 0 18px; font-size: 17px; }
  p.watch { margin: 0 0 30px; }
  p.watch a { display: inline-block; padding: 9px 16px; border: 1px solid rgba(124,183,255,.45); border-radius: 999px; color: var(--accent); text-decoration: none; font-weight: 600; transition: background-color 150ms cubic-bezier(.25,1,.5,1); }
  p.watch a:hover { background: rgba(124,183,255,.12); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
  a.card { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; color: inherit; text-decoration: none; transition: border-color 150ms ease-out, transform 150ms ease-out; }
  a.card:hover { border-color: rgba(124,183,255,.5); transform: translateY(-2px); }
  a.card img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; object-fit: cover; background: #000; }
  .card div { padding: 14px 16px 16px; }
  .card h2 { font-size: 18px; margin: 0 0 4px; }
  .card p { margin: 0; color: var(--dim); font-size: 14px; }
  .facts { margin-top: 10px; font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
  footer { margin-top: 36px; color: var(--dim); font-size: 14px; }
  footer a { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { a.card { transition: none; } a.card:hover { transform: none; } }
</style>
</head>
<body>
<main>
  <h1>rangeplay</h1>
  <p class="lede">Play-as-you-download for the web. The game runs in your browser tab. Its data streams from a plain CDN as the
  engine asks for it and stays cached on your device. There are no game servers and no streamed video.</p>
  <p class="watch"><a href="/video/">▶ Watch the 2-minute explainer</a></p>
  <div class="grid">
    <a class="card" href="/examples/quake/">
      <img src="/quake.jpg" alt="LibreQuake's first demo, running in the browser" width="800" height="600">
      <div>
        <h2>LibreQuake</h2>
        <p>A 210 MB game for the Quake engine. Each level downloads when the engine loads it; levels you never visit never download.</p>
        <p class="facts">54 maps · 414 KB engine · boot set 23 MB · demo playing in 4 s</p>
      </div>
    </a>
    <a class="card" href="/examples/freedoom/">
      <img src="/freedoom.jpg" alt="Freedoom, running in the browser" width="789" height="444">
      <div>
        <h2>Freedoom</h2>
        <p>A complete game: the Doom engine compiled from C to WebAssembly, reading its 27 MB WAD through rangeplay.</p>
        <p class="facts">68 levels · 405 KB engine · boot set 14.7 MB · the rest installs while you play</p>
      </div>
    </a>
    <a class="card" href="/examples/tile-world/">
      <img src="/tile-world.jpg" alt="tile-world, a streamed landscape" width="1280" height="720">
      <div>
        <h2>tile-world</h2>
        <p>144 MB of terrain in 36 archives. Tiles stream in as the camera moves, ahead of it thanks to read hints.</p>
        <p class="facts">WebGPU · streamer thread · hints · OPFS cache</p>
      </div>
    </a>
  </div>
  <footer>A demo does not start? <a href="/examples/check/">Check this browser</a>.
  Source, docs and the runtime: <a href="https://github.com/HKTITAN/rangeplay">github.com/HKTITAN/rangeplay</a> (MIT).
  Freedoom and LibreQuake data: BSD-3-Clause (LibreQuake game code: GPL-2.0). Doom and Quake engines: GPL-2.0.</footer>
</main>
</body>
</html>
`);
// the explainer film, on a page of its own (the README links here: GitHub does not play repository videos inline)
await mkdir(join(site, 'video'), { recursive: true });
await cp(join(root, 'docs', 'rangeplay-explainer.mp4'), join(site, 'video', 'rangeplay-explainer.mp4'));
await cp(join(root, 'docs', 'explainer-poster.jpg'), join(site, 'video', 'poster.jpg'));
await writeFile(join(site, 'video', 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rangeplay in two minutes</title>
<meta name="description" content="A game engine in a browser tab, streaming its data like a video: how rangeplay works, drawn on one tldraw board.">
<meta property="og:title" content="rangeplay: play games the way you watch videos">
<meta property="og:image" content="https://rangeplay.vercel.app/video/poster.jpg">
<meta property="og:video" content="https://rangeplay.vercel.app/video/rangeplay-explainer.mp4">
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; --bg: #0b0d12; --text: #e9ecf2; --dim: #9aa3b2; --accent: #7cb7ff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1280px; margin: 0 auto; padding: 32px 16px 56px; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; }
  p { color: var(--dim); margin: 0 0 20px; }
  video { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; background: #000; border-radius: 10px; }
  nav { margin-top: 18px; display: flex; flex-wrap: wrap; gap: 8px 22px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>rangeplay: play games the way you watch videos</h1>
  <p>A game engine in your browser tab, streaming its data like a video. Drawn on one tldraw board.</p>
  <video src="rangeplay-explainer.mp4" poster="poster.jpg" controls playsinline preload="metadata"></video>
  <nav>
    <a href="https://github.com/HKTITAN/rangeplay">Source on GitHub</a>
    <a href="/">Try the demos</a>
    <a href="rangeplay-explainer.mp4" download>Download the MP4</a>
  </nav>
</main>
</body>
</html>
`);
console.log('site/ ready');
