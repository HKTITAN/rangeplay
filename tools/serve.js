// `rangeplay serve [root]`: a development server with what the runtime needs (cross-origin isolation headers, HTTP
// Range, immutable caching of content-addressed objects) and knobs to imitate real networks: added latency, a per-
// response bandwidth cap and random 503s.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};
const OBJECT_RE = /\/data\/[0-9a-f]{2}\/[0-9a-f]{32}$/;

// Parses a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range. Returns [start, end], 'unsatisfiable', or null (ignore
// the header and send the whole file, which RFC 9110 allows, e.g. for multiple ranges).
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (start >= size) return 'unsatisfiable';
  return [start, end];
}

function throttle(bytesPerSecond) {
  const t0 = Date.now();
  let sent = 0;
  return new Transform({
    transform(chunk, _enc, done) {
      sent += chunk.length;
      const wait = t0 + (sent / bytesPerSecond) * 1000 - Date.now();
      if (wait > 0) setTimeout(() => done(null, chunk), wait);
      else done(null, chunk);
    },
  });
}

export function createServer({ root, latencyMs = 0, rateKBps = 0, failRate = 0, crossOrigin = false, log = () => {} }) {
  const base = resolve(root);
  let requests = 0;
  const server = createHttpServer(async (req, res) => {
    requests++;
    const url = new URL(req.url, 'http://localhost');
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return end(res, 400);
    }
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': crossOrigin ? 'cross-origin' : 'same-origin',
      'Accept-Ranges': 'bytes',
    };
    if (crossOrigin) {
      Object.assign(headers, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      });
    }
    if (req.method === 'OPTIONS') return end(res, 204, headers);
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, headers);

    let file = normalize(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) return end(res, 403, headers);
    let st;
    try {
      st = await stat(file);
      if (st.isDirectory()) {
        if (!path.endsWith('/')) return end(res, 301, { ...headers, Location: url.pathname + '/' + url.search });
        file = join(file, 'index.html');
        st = await stat(file);
      }
    } catch {
      return end(res, 404, headers);
    }

    const isObject = OBJECT_RE.test(path);
    if (isObject && failRate > 0 && Math.random() < failRate) {
      log(`503 (injected) ${path}`);
      return end(res, 503, { ...headers, 'Retry-After': '0' });
    }
    headers['Content-Type'] = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    headers['Cache-Control'] = isObject ? 'public, max-age=31536000, immutable' : 'no-cache';
    headers['Last-Modified'] = st.mtime.toUTCString();
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    headers.ETag = etag;
    if (!isObject && req.headers['if-none-match'] === etag) return end(res, 304, headers);

    let status = 200, start = 0, last = st.size - 1;
    const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
    if (range === 'unsatisfiable') return end(res, 416, { ...headers, 'Content-Range': `bytes */${st.size}` });
    if (range) {
      [start, last] = range;
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${last}/${st.size}`;
    }
    headers['Content-Length'] = String(st.size ? last - start + 1 : 0);

    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const body = createReadStream(file, { start, end: last, highWaterMark: 16384 });
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    if (rateKBps > 0) body.pipe(throttle(rateKBps * 1024)).pipe(res);
    else body.pipe(res);
  });
  server.requests = () => requests;
  return server;
}

function end(res, status, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}
