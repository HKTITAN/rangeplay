// `rangeplay pack <dir> --out <dist>`: turns a directory of game data into a manifest plus content-addressed objects
// that any static host or CDN can serve with HTTP Range requests and cache forever.
//
// With packSmall, files under that many bytes are stored back to back in packs of at most packMax bytes, instead of
// one object each. A game with thousands of small files (shaders, scripts, configs) then costs a few requests instead
// of thousands: reads of neighbouring files merge into one Range request, and the host stores far fewer objects. Pass
// a boot set as `order` and packs follow the order in which the engine first touches the files, so start-up reads sit
// next to each other.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { MANIFEST_FORMAT, MANIFEST_FORMAT_PACKS, objectPath } from '../src/shared/manifest.js';

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

const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 32);

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

// Writes an object unless one of the right size is there. Objects are only ever written whole (written, then renamed),
// so an object of the right size is complete.
async function putObject(out, hash, size, write) {
  const dest = join(out, 'data', ...objectPath(hash).split('/'));
  if ((await sizeOf(dest)) === size) return false;
  await mkdir(join(dest, '..'), { recursive: true });
  const tmp = dest + '.tmp-' + process.pid;
  try {
    await write(tmp);
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return true;
}

// FNV-1a of a path: stable across runs and machines.
function pathHash(path) {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// The paths of a boot set (or a list of paths), in order of first touch.
function touchOrder(order) {
  if (!order) return new Map();
  const paths = Array.isArray(order) ? order : (order.files || []).map(([p]) => p);
  return new Map(paths.map((p, i) => [p, i]));
}

export async function pack({
  src, out, name, blockSize = 4096, dataPath = 'data/', hardlink = false, packSmall = 0, packMax = 4 * 1048576, order = null,
  log = () => {},
}) {
  if (!Number.isInteger(blockSize) || blockSize < 512 || (blockSize & (blockSize - 1))) throw new Error('--block-size must be a power of two, at least 512');
  if (!Number.isSafeInteger(packSmall) || packSmall < 0) throw new Error('--pack-small must be a size in bytes');
  if (packSmall && (!Number.isSafeInteger(packMax) || packMax < packSmall)) throw new Error('--pack-max must be at least --pack-small');
  const paths = await walk(src);
  const files = [];
  let bytes = 0;
  for (const p of paths) {
    const full = join(src, ...p.split('/'));
    const [{ size }, hash] = await Promise.all([stat(full), hashFile(full)]);
    files.push([p, size, hash]);
    bytes += size;
  }

  // Packs: small files (each content once) in order of first touch, then by path.
  const rank = touchOrder(order);
  const small = [], taken = new Set();
  for (const [[p, size, hash]] of files
    .map((f, i) => [f, i])
    .filter(([[, size]]) => size > 0 && size < packSmall)
    .sort(([[a], i], [[b], j]) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || i - j)) {
    if (!taken.has(hash)) small.push([p, size, hash]);
    taken.add(hash);
  }
  // Where packs end depends on the paths, not on running totals: a pack ends before a file whose path hashes to a
  // multiple of `every`. Filling packs up to packMax instead would let one file that grows shift every later pack, and
  // an update would invalidate all of them. This way it changes its own pack (and rarely the next, at a forced split).
  // `every` makes the average pack about a quarter of packMax, so few packs reach the cap.
  const avg = small.reduce((n, [, size]) => n + size, 0) / (small.length || 1);
  const every = Math.max(2, Math.round(packMax / (4 * avg)));
  const groups = [];
  let current = null;
  for (const [p, size, hash] of small) {
    if (!current || current.size + size > packMax || pathHash(p) % every === 0) groups.push((current = { members: [], size: 0 }));
    current.members.push([p, size, hash]);
    current.size += size;
  }
  // A pack of one file would be that file's own object under another name: those files stay as they are.
  const packs = groups.filter((g) => g.members.length > 1);
  const where = new Map();   // content hash -> [pack index, offset]
  packs.forEach((pk, i) => {
    let at = 0;
    for (const [, size, hash] of pk.members) {
      where.set(hash, [i, at]);
      at += size;
    }
  });
  let stored = 0, objects = 0;
  const packList = [];
  for (const pk of packs) {
    const body = Buffer.concat(await Promise.all(pk.members.map(([p]) => readFile(join(src, ...p.split('/'))))));
    const hash = hashBytes(body);
    packList.push([hash, body.length]);
    if (await putObject(out, hash, body.length, (tmp) => writeFile(tmp, body))) {
      stored += body.length;
      objects++;
    }
  }
  for (const f of files) if (where.has(f[2])) f.push(...where.get(f[2]));

  // Every other file is an object of its own.
  const seen = new Set();
  for (const [p, size, hash, pk] of files) {
    if (pk !== undefined || seen.has(hash)) continue;
    seen.add(hash);
    const full = join(src, ...p.split('/'));
    // --link saves space, but then editing a source file changes a published, "immutable" object: re-pack after edits.
    const write = (tmp) => (hardlink ? link(full, tmp).catch(() => copyFile(full, tmp)) : copyFile(full, tmp));
    if (await putObject(out, hash, size, write)) {
      stored += size;
      objects++;
    }
  }

  const version = createHash('sha256').update(JSON.stringify(packList.length ? [blockSize, files, packList] : [blockSize, files])).digest('hex').slice(0, 16);
  // dataPath: where clients fetch the objects from (relative to the manifest, or an absolute CDN URL)
  const manifest = packList.length
    ? { format: MANIFEST_FORMAT_PACKS, name: name || 'default', version, blockSize, dataPath, packs: packList, files }
    : { format: MANIFEST_FORMAT, name: name || 'default', version, blockSize, dataPath, files };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
  const packed = files.filter((f) => f.length > 3).length;
  const total = seen.size + packList.length;
  log(`packed ${files.length} files (${(bytes / 1048576).toFixed(1)} MB) into ${total} objects` +
    (packList.length ? ` (${packed} small files in ${packList.length} packs)` : '') +
    `; wrote ${objects} new (${(stored / 1048576).toFixed(1)} MB). version ${version}`);
  return { manifest, files: files.length, bytes, uniqueObjects: total, packs: packList.length, packedFiles: packed, newObjects: objects, newBytes: stored };
}
