// HTTP Range reads with retries. Responses are streamed chunk by chunk to the caller (into the store), never collected
// into one buffer.

export class HttpError extends Error {
  constructor(message, status, transient) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.transient = transient;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(value) {
  if (!value) return 0;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

export class Fetcher {
  constructor({
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    retries = 6,
    baseDelayMs = 200,
    maxDelayMs = 10000,
    cache = 'no-store',   // the store keeps the bytes; the HTTP cache would hold a second copy. null: leave it out
    random = Math.random,
    sleep = sleepMs,
    onBytes = null,
    log = () => {},
  } = {}) {
    Object.assign(this, { fetchImpl, retries, baseDelayMs, maxDelayMs, cache, random, sleep, onBytes, log });
    this.stats = { requests: 0, retries: 0, ignoredRange: 0 };
    this.warnedIgnoredRange = false;
  }

  // Streams bytes [start, end] (inclusive) of `url` to onChunk(chunk, position relative to start). Returns the number of
  // bytes delivered: fewer than asked only when the file ends first. Transient failures (network errors, 429, 5xx, a
  // body cut short) are retried with exponential backoff and full jitter, resuming after the bytes already delivered.
  async range(url, start, end, { priority = 'auto', onChunk }) {
    const total = end - start + 1;
    let got = 0;
    for (let attempt = 0; ; attempt++) {
      let wait = 0;
      try {
        const done = await this.#attempt(url, start + got, end, priority, (chunk) => {
          const room = total - got;
          if (chunk.length > room) chunk = chunk.subarray(0, room);
          if (chunk.length) {
            onChunk(chunk, got);
            got += chunk.length;
          }
          return got >= total;
        });
        if (done) return got;
      } catch (e) {
        if (e instanceof HttpError && !e.transient) throw e;
        if (attempt >= this.retries) throw e;
        wait = e.retryAfter || 0;
        this.log('[fetch] retrying ' + url + ' (' + e.message + ')');
      }
      this.stats.retries++;
      const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
      await this.sleep(Math.max(wait, this.random() * cap));
    }
  }

  // One request. Returns true when the range is complete or the file ended; false (or throws) to retry.
  async #attempt(url, from, end, priority, deliver) {
    const init = { headers: { Range: 'bytes=' + from + '-' + end }, priority };
    if (this.cache) init.cache = this.cache;
    this.stats.requests++;
    const res = await this.fetchImpl(url, init);
    if (res.status === 416) {
      res.body?.cancel().catch(() => {});
      return true;   // starts past the end of the file
    }
    if (res.status === 429 || res.status >= 500) {
      res.body?.cancel().catch(() => {});
      const e = new HttpError('HTTP ' + res.status + ' for ' + url, res.status, true);
      e.retryAfter = retryAfterMs(res.headers.get('Retry-After'));
      throw e;
    }
    if (res.status !== 206 && res.status !== 200) {
      res.body?.cancel().catch(() => {});
      throw new HttpError('HTTP ' + res.status + ' for ' + url, res.status, false);
    }

    let skip = 0, expected = end - from + 1;
    if (res.status === 200) {
      // The server ignored Range and sends the whole file: skip to the range. Correct, but every read now costs the
      // whole file's prefix. Usually a proxy or a server without range support.
      skip = from;
      this.stats.ignoredRange++;
      if (!this.warnedIgnoredRange) {
        this.warnedIgnoredRange = true;
        this.log('[fetch] ' + url + ' answered 200 to a Range request: the host does not support ranges');
      }
      const len = Number(res.headers.get('Content-Length'));
      if (Number.isFinite(len) && len > 0) expected = Math.min(expected, Math.max(0, len - from));
    } else {
      // Content-Range is only visible cross-origin when the CDN exposes it (Access-Control-Expose-Headers).
      const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('Content-Range') || '');
      if (cr) {
        if (Number(cr[1]) !== from) throw new HttpError('asked for bytes from ' + from + ', got ' + cr[0], 206, false);
        expected = Math.min(expected, Number(cr[2]) - from + 1);
      } else {
        const len = Number(res.headers.get('Content-Length'));
        if (Number.isFinite(len) && len >= 0 && res.headers.has('Content-Length')) expected = Math.min(expected, len);
      }
    }

    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.onBytes?.(value.length);
      let chunk = value;
      if (skip) {
        const d = Math.min(skip, chunk.length);
        skip -= d;
        chunk = chunk.subarray(d);
      }
      if (!chunk.length) continue;
      received += chunk.length;
      if (deliver(chunk)) {
        reader.cancel().catch(() => {});
        return true;
      }
    }
    if (received >= expected) return true;   // the file ended inside the range
    throw new HttpError('body ended after ' + received + ' of ' + expected + ' bytes: ' + url, res.status, true);
  }
}
