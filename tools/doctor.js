// `rangeplay doctor <page or manifest URL>`: checks a deployment for what makes a game fail to start or start slowly,
// and says what to change. Most of these failures look the same to a player (a page that never starts, or a black
// canvas), so it is worth asking the host directly:
//
// - the page: cross-origin isolation headers (without them there is no shared memory, and no engine threads);
// - the manifest: reachable, valid, not cached for long by the CDN, readable from the page's origin;
// - a sample of objects: present, answering byte ranges with 206 and the right Content-Range, not an HTML fallback
//   page, not compressed on the fly (ranges would count bytes of the compressed body), cached as immutable, CORS when
//   they live on another origin; and the bytes of one of them must hash to its name;
// - the boot set: present, and recorded against files that still exist.
//
// Every check yields { level: 'ok' | 'note' | 'warn' | 'fail', what, detail }.

import { createHash } from 'node:crypto';
import { FileTable } from '../src/shared/manifest.js';
import { validateBootset } from '../src/shared/bootset.js';

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function maxAge(cacheControl) {
  const m = /(?:^|,)\s*(?:s-)?max-age=(\d+)/i.exec(cacheControl || '');
  return m ? Number(m[1]) : null;
}

export async function doctor({ url, page = null, manifest = null, bootset = null, sample = 6, fetch: fetchImpl = globalThis.fetch, log = () => {} }) {
  const checks = [];
  const add = (level, what, detail = '') => {
    checks.push({ level, what, detail });
    log({ level, what, detail });
  };
  const get = async (target, init = {}) => {
    const t0 = performance.now();
    const res = await fetchImpl(target, { redirect: 'follow', cache: 'no-store', ...init });
    res.ms = performance.now() - t0;
    return res;
  };

  // ---- which URL is which ----
  let manifestUrl = manifest;
  if (!manifestUrl && /\.json(\?|#|$)/.test(url)) manifestUrl = url;
  else if (!page) page = url;
  if (page) {
    // ".../examples/quake" means the folder: relative URLs resolve against ".../examples/quake/"
    const u = new URL(page);
    if (!u.pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(u.pathname)) u.pathname += '/';
    page = u.href;
  }
  const candidates = manifestUrl ? [manifestUrl] : [new URL('manifest.json', page).href, new URL('dist/manifest.json', page).href];

  // ---- the page ----
  let pageOrigin = null;
  if (page) {
    try {
      const res = await get(page);
      await res.body?.cancel();
      pageOrigin = new URL(res.url || page).origin;
      if (!res.ok) add('fail', 'page answers HTTP ' + res.status, page);
      else add('ok', 'page answers 200', page);
      const coop = res.headers.get('cross-origin-opener-policy') || '';
      const coep = res.headers.get('cross-origin-embedder-policy') || '';
      if (/^same-origin\b/i.test(coop)) add('ok', 'Cross-Origin-Opener-Policy: ' + coop);
      else add('fail', 'Cross-Origin-Opener-Policy is ' + (coop ? '"' + coop + '"' : 'missing'),
        'set it to same-origin, or the page gets no SharedArrayBuffer and the engine cannot start (rangeplay headers <host> prints the configuration)');
      if (/^(require-corp|credentialless)\b/i.test(coep)) add('ok', 'Cross-Origin-Embedder-Policy: ' + coep);
      else add('fail', 'Cross-Origin-Embedder-Policy is ' + (coep ? '"' + coep + '"' : 'missing'),
        'set it to require-corp (or credentialless), or the page gets no SharedArrayBuffer');
    } catch (e) {
      add('fail', 'page did not load: ' + e.message, page);
    }
  }

  // ---- the manifest ----
  let files = null, res = null;
  for (const candidate of candidates) {
    try {
      res = await get(candidate);
      if (res.ok) {
        manifestUrl = res.url || candidate;
        break;
      }
      await res.body?.cancel();
    } catch (e) {
      res = { status: e.message };
    }
  }
  if (!res?.ok) {
    add('fail', 'no manifest at ' + candidates.join(' or ') + ' (' + (typeof res?.status === 'number' ? 'HTTP ' : '') + res?.status + ')',
      'pass the manifest URL: rangeplay doctor <page> --manifest <url>');
    return finish(checks);
  }
  try {
    const text = await res.text();
    if (/^\s*</.test(text)) throw new Error('it is an HTML page');
    files = new FileTable(JSON.parse(text), manifestUrl);
  } catch (e) {
    add('fail', 'manifest is not valid: ' + e.message, manifestUrl);
    return finish(checks);
  }
  const objects = files.objectList();
  const packs = objects.filter((o) => o.pack >= 0).length;
  add('ok', `manifest: ${files.name} version ${files.version}`, `${files.count} files in ${objects.length} objects` +
    (packs ? ` (${packs} packs)` : '') + `, ${mb(files.downloadBytes())}`);
  const age = maxAge(res.headers.get('cache-control'));
  if (/immutable/i.test(res.headers.get('cache-control') || '') || age > 600) {
    add('warn', 'manifest is cached for long (Cache-Control: ' + res.headers.get('cache-control') + ')',
      'players can keep starting an old version after you deploy: serve manifest.json with no-cache or a short max-age');
  }
  const origin = pageOrigin || new URL(manifestUrl).origin;
  const corsOk = (r) => {
    const allow = r.headers.get('access-control-allow-origin');
    return allow === '*' || allow === origin;
  };
  if (pageOrigin && new URL(manifestUrl).origin !== pageOrigin && !corsOk(res)) {
    add('fail', 'manifest is on another origin without CORS', 'send Access-Control-Allow-Origin: ' + pageOrigin + ' (or *)');
  }
  if (files.json.format === 'rangeplay-manifest@1') {
    let small = 0;
    for (let id = 0; id < files.count; id++) if (files.size(id) > 0 && files.size(id) < 65536) small++;
    if (small >= 200) {
      add('note', `${small} files are under 64 KB, each an object of its own`,
        'rangeplay pack --pack-small 64k stores them in packs: far fewer requests, and far fewer objects on the host');
    }
  }

  // ---- a sample of objects ----
  const pick = new Map();
  const sized = objects.filter((o) => o.size > 0).sort((a, b) => a.size - b.size);
  if (sized.length) {
    pick.set(sized[0].hash, sized[0]);
    pick.set(sized[sized.length - 1].hash, sized[sized.length - 1]);
    const firstPack = sized.find((o) => o.pack >= 0);
    if (firstPack) pick.set(firstPack.hash, firstPack);
    for (let i = 1; pick.size < Math.min(sample, sized.length); i++) {
      const o = sized[Math.floor((i * sized.length) / (sample + 1))];
      pick.set(o.hash, o);
    }
  }
  const problems = new Map();   // one line per kind of problem, with how many objects have it
  const problem = (level, what, detail) => {
    const p = problems.get(what) || { level, what, detail, n: 0 };
    p.n++;
    problems.set(what, p);
  };
  const times = [];
  for (const o of pick.values()) {
    const objectUrl = files.url(o.sid);
    const crossOrigin = new URL(objectUrl).origin !== origin;
    const start = Math.floor(o.size / 2), end = Math.min(o.size - 1, start + 15);
    let r;
    try {
      r = await get(objectUrl, { headers: { Range: `bytes=${start}-${end}` } });
      times.push(r.ms);
      await r.body?.cancel();
    } catch (e) {
      problem('fail', 'objects do not load', e.message);
      continue;
    }
    if (r.status === 404) {
      problem('fail', 'objects are missing (HTTP 404)', 'upload the data/ folder next to manifest.json; e.g. ' + objectUrl);
      continue;
    }
    if (/^text\/html\b/i.test(r.headers.get('content-type') || '')) {
      problem('fail', 'objects answer with an HTML page', 'a fallback route (single-page app rewrite) catches data/: exclude it; e.g. ' + objectUrl);
      continue;
    }
    if (r.status === 200) {
      problem('fail', 'the host ignores Range (HTTP 200)', 'every read would download its file from the start: serve the objects from a host or path that answers ranges');
      continue;
    }
    if (r.status !== 206) {
      problem('fail', 'objects answer HTTP ' + r.status, objectUrl);
      continue;
    }
    const enc = r.headers.get('content-encoding');
    if (enc && enc !== 'identity') {
      problem('fail', 'objects are compressed on the fly (Content-Encoding: ' + enc + ')',
        'ranges then count bytes of the compressed body: serve data/ as application/octet-stream and turn compression off for it');
    }
    const cr = r.headers.get('content-range');
    if (!cr) {
      problem(crossOrigin ? 'warn' : 'fail', 'Content-Range is not readable',
        crossOrigin ? 'expose it (Access-Control-Expose-Headers: Content-Range, Content-Length) so the runtime can check sizes' : 'the host answers 206 without Content-Range');
    } else {
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr);
      if (!m || Number(m[1]) !== start) problem('fail', 'objects answer the wrong range', `asked for bytes ${start}-${end}, got "${cr}"`);
      else if (m[3] !== '*' && Number(m[3]) !== o.size) problem('fail', 'objects have the wrong size', `${objectUrl} is ${m[3]} bytes, the manifest says ${o.size}: a stale or different upload`);
    }
    if (crossOrigin && !corsOk(r)) problem('fail', 'objects are on another origin without CORS', 'send Access-Control-Allow-Origin: ' + origin + ' (or *) on data/');
    const cc = r.headers.get('cache-control') || '';
    if (!/immutable/i.test(cc) && !(maxAge(cc) >= 86400)) {
      problem('warn', 'objects are not cached as immutable' + (cc ? ' (Cache-Control: ' + cc + ')' : ''),
        'their bytes never change: Cache-Control: public, max-age=31536000, immutable saves revalidation round trips');
    }
    const type = r.headers.get('content-type') || '';
    if (/^text\//i.test(type)) problem('warn', 'objects are served as ' + type, 'use application/octet-stream, so no CDN compresses or rewrites them');
  }
  for (const p of problems.values()) add(p.level, p.what + (pick.size > 1 ? ` (${p.n} of ${pick.size} sampled)` : ''), p.detail);
  if (pick.size && !problems.size) add('ok', `${pick.size} sampled objects answer byte ranges correctly`, 'cached as immutable' + (times.length ? `; median time to answer ${Math.round(times.sort((a, b) => a - b)[times.length >> 1])} ms` : ''));

  // The bytes themselves: the smallest object, whole, must hash to its name.
  if (sized.length && sized[0].size <= 4 * 1048576 && ![...problems.values()].some((p) => p.level === 'fail')) {
    try {
      const r = await get(files.url(sized[0].sid));
      const body = Buffer.from(await r.arrayBuffer());
      if (createHash('sha256').update(body).digest('hex').slice(0, 32) === sized[0].hash) add('ok', 'object bytes match their names', 'checked ' + sized[0].hash);
      else add('fail', 'object bytes do not match their names', sized[0].hash + ' was changed on its way (a transform, or a broken upload): run rangeplay verify ' + manifestUrl);
    } catch (e) {
      add('warn', 'could not download an object whole: ' + e.message);
    }
  }

  // ---- the boot set: where it was asked for, else bootset.json next to the manifest or the page ----
  const bootsetUrls = bootset ? [bootset] : [...new Set([new URL('bootset.json', manifestUrl).href, page && new URL('bootset.json', page).href].filter(Boolean))];
  let bootsetUrl = bootsetUrls[0], text = '';
  try {
    for (const candidate of bootsetUrls) {
      const r = await get(candidate);
      text = r.ok ? await r.text() : (await r.body?.cancel(), '');
      if (r.ok && !/^\s*</.test(text)) {
        bootsetUrl = candidate;
        break;
      }
      text = '';
    }
    if (!text) {
      add('note', 'no boot set at ' + bootsetUrls.join(' or '),
        'start-up reads then wait one round trip each: record one (README, "Record a boot set"). If it lives elsewhere, pass --bootset <url>');
    } else {
      const set = validateBootset(JSON.parse(text));
      let gone = 0, bytes = 0;
      for (const [path, ranges] of set.files) {
        if (files.id(path) < 0) gone++;
        for (const [a, b] of ranges) bytes += b - a + 1;
      }
      if (gone) add('warn', `boot set: ${gone} of ${set.files.length} files are not in this manifest`, 'it was recorded against another version: record it again');
      else add('ok', `boot set: ${set.files.length} files, ${mb(bytes)}`, bootsetUrl);
    }
  } catch (e) {
    add('warn', 'boot set is not valid: ' + e.message, bootsetUrl);
  }
  return finish(checks);
}

function finish(checks) {
  return { checks, ok: !checks.some((c) => c.level === 'fail') };
}
