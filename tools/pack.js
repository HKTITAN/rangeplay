// `rangeplay pack <dir> --out <dist>`: turns a directory of game data into a manifest plus content-addressed objects
// that any static host or CDN can serve with HTTP Range requests and cache forever.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { MANIFEST_FORMAT, objectPath } from '../src/shared/manifest.js';

async function walk(dir, root = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    else if (e.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex').slice(0, 32)));
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function pack({ src, out, name, blockSize = 4096, dataPath = 'data/', hardlink = false, log = () => {} }) {
  if (!Number.isInteger(blockSize) || blockSize < 512 || (blockSize & (blockSize - 1))) throw new Error('--block-size must be a power of two, at least 512');
  const paths = await walk(src);
  const files = [];
  let bytes = 0, stored = 0, objects = 0;
  const seen = new Set();
  for (const p of paths) {
    const full = join(src, ...p.split('/'));
    const [{ size }, hash] = await Promise.all([stat(full), hashFile(full)]);
    files.push([p, size, hash]);
    bytes += size;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const dest = join(out, 'data', ...objectPath(hash).split('/'));
    if (!(await exists(dest))) {
      await mkdir(join(dest, '..'), { recursive: true });
      if (hardlink) await link(full, dest).catch(() => copyFile(full, dest));
      else await copyFile(full, dest);
      stored += size;
      objects++;
    }
  }
  const version = createHash('sha256').update(JSON.stringify([blockSize, files])).digest('hex').slice(0, 16);
  // dataPath: where clients fetch the objects from (relative to the manifest, or an absolute CDN URL)
  const manifest = { format: MANIFEST_FORMAT, name: name || 'default', version, blockSize, dataPath, files };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
  log(`packed ${files.length} files (${(bytes / 1048576).toFixed(1)} MB), ${seen.size} unique objects; wrote ${objects} new (${(stored / 1048576).toFixed(1)} MB). version ${version}`);
  return { manifest, files: files.length, bytes, uniqueObjects: seen.size, newObjects: objects, newBytes: stored };
}
