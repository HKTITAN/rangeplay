// `rangeplay verify <dist | manifest URL>` and `rangeplay mirror <manifest URL> --out <dir>`.
//
// Objects are named after the SHA-256 of their bytes, so checking a copy of a game needs no checksum file: every
// object must exist, have the size the manifest gives, and hash to its own name. Packs are also checked file by file.
//
// verify on a directory reads the objects from disk: run it before you upload a dist, to catch a copy cut short. On a
// URL it downloads every object and checks it as it arrives, which is what players will get. mirror does the same and
// keeps the bytes: a verified copy of a published game, to move it to another host or keep it offline. It resumes
// where it stopped, never keeps an object that fails its check, and writes manifest.json last, so a mirror that is not
// finished never looks finished.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileTable, objectPath } from '../src/shared/manifest.js';

const HASH_RE = /^[0-9a-f]{32}$/;
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

function hashStream(stream, h = createHash('sha256')) {
  return new Promise((resolve, reject) => {
    stream.on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h));
  });
}

// For a pack: the files it holds, as [path, offset, size, hash].
function packMembers(files) {
  const members = new Map();
  for (let id = 0; id < files.count; id++) {
    if (!files.packed(id)) continue;
    const sid = files.sid(id);
    if (!members.has(sid)) members.set(sid, []);
    members.get(sid).push([files.path(id), files.base(id), files.size(id), files.hash(id)]);
  }
  return members;
}

function checkMembers(body, members = []) {
  for (const [path, at, size, hash] of members) {
    if (createHash('sha256').update(body.subarray(at, at + size)).digest('hex').slice(0, 32) !== hash) return path;
  }
  return null;
}

// Runs fn over items, `concurrency` at a time.
async function each(items, concurrency, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function progress(log, total, totalBytes) {
  let done = 0, bytes = 0, last = 0;
  return (n) => {
    done++;
    bytes += n;
    const t = Date.now();
    if (done === total || t - last > 2000) {
      last = t;
      log(`  ${done}/${total} objects, ${mb(bytes)} of ${mb(totalBytes)}`);
    }
  };
}

// ---- a dist on disk ---------------------------------------------------------------------------------------------------

export async function verifyDir({ dist, concurrency = 4, log = () => {} }) {
  const files = new FileTable(JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8')));
  const objects = files.objectList(), members = packMembers(files);
  const dataDir = join(dist, files.json.dataPath && !/^[a-z]+:/i.test(files.json.dataPath) ? files.json.dataPath : 'data');
  const report = { objects: objects.length, bytes: 0, missing: [], corrupt: [], unused: 0, unusedBytes: 0 };
  const tick = progress(log, objects.length, files.downloadBytes());
  await each(objects, concurrency, async (o) => {
    const path = join(dataDir, ...objectPath(o.hash).split('/'));
    const size = await sizeOf(path);
    if (size < 0) report.missing.push(o.hash);
    else if (size !== o.size) report.corrupt.push(`${o.hash}: ${size} bytes, the manifest says ${o.size}`);
    else if (o.pack >= 0) {
      const body = await readFile(path);
      const bad = createHash('sha256').update(body).digest('hex').slice(0, 32) !== o.hash ? 'its hash' : checkMembers(body, members.get(o.sid));
      if (bad) report.corrupt.push(`${o.hash} (pack ${o.pack}): ${bad} does not match`);
    } else if ((await hashStream(createReadStream(path))).digest('hex').slice(0, 32) !== o.hash) {
      report.corrupt.push(`${o.hash} (${files.path(o.sid)}): its bytes do not match its name`);
    }
    report.bytes += Math.max(0, size);
    tick(Math.max(0, size));
  });
  // Objects the manifest does not use: earlier versions (safe to delete once no player runs them).
  const used = new Set(objects.map((o) => o.hash));
  for (const d of await readdir(dataDir).catch(() => [])) {
    for (const f of await readdir(join(dataDir, d)).catch(() => [])) {
      if (HASH_RE.test(f) && !used.has(f)) {
        report.unused++;
        report.unusedBytes += Math.max(0, await sizeOf(join(dataDir, d, f)));
      }
    }
  }
  report.ok = !report.missing.length && !report.corrupt.length;
  return report;
}

// ---- a published game ---------------------------------------------------------------------------------------------------

// Downloads one object, checking it as it arrives. With dest, keeps it: resumes from dest + '.partial', and renames it
// into place only once it checks out. Retries transient failures, resuming after the bytes already received.
async function fetchObject({ url, size, hash, members, dest, fetchImpl, retries = 4 }) {
  if (dest && (await sizeOf(dest)) === size) {
    const h = await hashStream(createReadStream(dest));
    if (h.digest('hex').slice(0, 32) === hash) return { skipped: true, bytes: 0 };
    await rm(dest, { force: true });
  }
  const partial = dest ? dest + '.partial' : null;
  if (dest) await mkdir(join(dest, '..'), { recursive: true });
  if (size === 0) {   // nothing to download (an empty file's object)
    if (createHash('sha256').digest('hex').slice(0, 32) !== hash) throw Object.assign(new Error('bytes do not match the object name'), { fatal: true });
    if (dest) await writeFile(dest, '');
    return { skipped: false, bytes: 0 };
  }
  for (let attempt = 0; ; attempt++) {
    let have = partial ? Math.max(0, await sizeOf(partial)) : 0;
    if (have > size) {
      await rm(partial, { force: true });
      have = 0;
    }
    const h = createHash('sha256');
    const keep = members?.length ? [] : null;   // packs are small: keep the body to check the files in it
    if (have) {
      await hashStream(createReadStream(partial), h);
      if (keep) keep.push(await readFile(partial));
    }
    let received = 0, fh = null;
    try {
      if (have < size) {
        const res = await fetchImpl(url, { headers: { Range: `bytes=${have}-${size - 1}` } });
        if (res.status === 404) throw Object.assign(new Error('HTTP 404 (missing)'), { fatal: true });
        if (res.status !== 206 && res.status !== 200) throw new Error('HTTP ' + res.status);
        if (/^text\/html\b/i.test(res.headers.get('content-type') || '')) throw Object.assign(new Error('answered with an HTML page'), { fatal: true });
        let skip = 0;
        if (res.status === 200) skip = have;   // the host ignored the range: skip what we have
        else {
          const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') || '');
          if (cr && Number(cr[1]) !== have) throw new Error('asked for bytes from ' + have + ', got ' + cr[0]);
          if (cr && cr[3] !== '*' && Number(cr[3]) !== size) throw Object.assign(new Error(`is ${cr[3]} bytes, the manifest says ${size}`), { fatal: true });
        }
        if (partial) fh = await open(partial, have ? 'a' : 'w');
        for await (let chunk of res.body) {
          if (skip) {
            const d = Math.min(skip, chunk.length);
            skip -= d;
            chunk = chunk.subarray(d);
          }
          if (!chunk.length) continue;
          if (have + received + chunk.length > size) throw Object.assign(new Error('longer than the manifest says'), { fatal: true });
          h.update(chunk);
          keep?.push(Buffer.from(chunk));
          if (fh) await fh.write(chunk);
          received += chunk.length;
        }
        await fh?.close();
        fh = null;
        if (have + received !== size) throw new Error(`body ended after ${have + received} of ${size} bytes`);
      }
      if (h.digest('hex').slice(0, 32) !== hash) {
        if (partial) await rm(partial, { force: true });
        throw Object.assign(new Error('bytes do not match the object name'), { fatal: attempt >= 1 });
      }
      const bad = keep ? checkMembers(Buffer.concat(keep), members) : null;
      if (bad) throw Object.assign(new Error('packed file ' + bad + ' does not match'), { fatal: true });
      if (dest) await rename(partial, dest);
      return { skipped: false, bytes: received };
    } catch (e) {
      await fh?.close().catch(() => {});
      if (e.fatal || attempt >= retries) throw e;
      await sleep(Math.min(8000, 250 * 2 ** attempt));
    }
  }
}

// verify (out omitted) or mirror (out given) a published game.
export async function verifyUrl({ manifestUrl, out = null, bootset = true, concurrency = 6, fetch: fetchImpl = globalThis.fetch, log = () => {} }) {
  const res = await fetchImpl(manifestUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error('manifest: HTTP ' + res.status + ' for ' + manifestUrl);
  const text = await res.text();
  const files = new FileTable(JSON.parse(text), manifestUrl);
  const objects = files.objectList(), members = packMembers(files);
  const report = { objects: objects.length, bytes: 0, skipped: 0, missing: [], corrupt: [], files: files.count };
  log(`${files.name} version ${files.version}: ${files.count} files in ${objects.length} objects, ${mb(files.downloadBytes())}`);
  const tick = progress(log, objects.length, files.downloadBytes());
  await each(objects, concurrency, async (o) => {
    try {
      const r = await fetchObject({
        url: files.url(o.sid), size: o.size, hash: o.hash, members: members.get(o.sid), fetchImpl,
        dest: out ? join(out, 'data', ...objectPath(o.hash).split('/')) : null,
      });
      report.bytes += r.bytes;
      if (r.skipped) report.skipped++;
    } catch (e) {
      (/404/.test(e.message) ? report.missing : report.corrupt).push(`${o.hash} (${files.path(o.sid)}): ${e.message}`);
    }
    tick(o.size);
  });
  report.ok = !report.missing.length && !report.corrupt.length;
  if (out && report.ok) {
    // The mirror serves its objects next to its manifest, whatever the original's dataPath was.
    const json = JSON.parse(text);
    json.dataPath = 'data/';
    if (bootset) {
      const b = await fetchImpl(new URL(typeof bootset === 'string' ? bootset : 'bootset.json', manifestUrl), { cache: 'no-store' }).catch(() => null);
      if (b?.ok && !/^text\/html\b/i.test(b.headers.get('content-type') || '')) {
        await writeFile(join(out, 'bootset.json'), await b.text());
        report.bootset = true;
      }
    }
    await writeFile(join(out, 'manifest.json'), JSON.stringify(json));
  }
  return report;
}
