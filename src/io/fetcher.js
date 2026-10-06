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

const STALLED = Symbol('stalled');

export class Fetcher {
  constructor({
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    retries = 6,
    baseDelayMs = 200,
    maxDelayMs = 10000,
    stallMs = 15000,      // a response that delivers no bytes for this long is abandoned and retried
    cache = 'no-store',   // the store keeps the bytes; the HTTP cache would hold a second copy. null: leave it out
    random = Math.random,
    sleep = sleepMs,
    onBytes = null,
    log = () => {},
  } = {}) {
    Object.assign(this, { fetchImpl, retries, baseDelayMs, maxDelayMs, stallMs, cache, random, sleep, onBytes, log });
    this.stats = { requests: 0, retries: 0, ignoredRange: 0, stalls: 0 };
    this.warnedIgnoredRange = false;
  }

  // Streams bytes [start, end] (inclusive) of `url` to onChunk(chunk, position relative to start). Returns the number of
  // bytes delivered: fewer than asked only when the file ends first. `size`, the file's size from the manifest, guards
  // against answers that are not this file (a host's HTML fallback page, a stale object). Transient failures (network
  // errors, 429, 5xx, stalls, bodies cut short) are retried with exponential backoff and full jitter, resuming after the
  // bytes already delivered. `signal` aborts for good.
  async range(url, start, end, { priority = 'auto', onChunk, size = null, signal = null }) {
    const total = end - start + 1;
    let got = 0;
    const deliver = (chunk) => {
      const room = total - got;
      if (chunk.length > room) chunk = chunk.subarray(0, room);
      if (chunk.length) {
        onChunk(chunk, got);
        got += chunk.length;
      }
      return got >= total;
    };
    for (let attempt = 0; ; ) {
      signal?.throwIfAborted();
      let wait = 0;
      try {
        const r = await this.#attempt(url, start + got, end, priority, size, deliver, signal);
        if (r === 'done') return got;
        continue;   // a partial answer (the server caps range sizes): ask for the rest at once
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        if (e instanceof HttpError && !e.transient) throw e;
        if (attempt >= this.retries) throw e;
        wait = Math.min(this.maxDelayMs, e.retryAfter || 0);
        this.log('[fetch] retrying ' + url + ' (' + e.message + ')');
      }
      this.stats.retries++;
      const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
      attempt++;
      await this.sleep(Math.max(wait, this.random() * cap));
    }
  }

  // One request. Returns 'done' when the range is complete or the file ended, 'more' when the server sent a valid but
  // partial range; throws to retry (transient) or give up.
  async #attempt(url, from, end, priority, size, deliver, signal) {
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    signal?.addEventListener('abort', onAbort);
    let timer = 0;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(STALLED), this.stallMs);
    };
    let reader = null, finished = false;
    try {
      arm();
      const init = { headers: { Range: 'bytes=' + from + '-' + end }, priority, signal: ac.signal };
      if (this.cache) init.cache = this.cache;
      this.stats.requests++;
      const res = await this.fetchImpl(url, init);
      reader = res.body?.getReader() ?? null;

      if (res.status === 416) {
        finished = true;
        reader?.cancel().catch(() => {});
        return 'done';   // starts past the end of the file
      }
      if (res.status === 429 || res.status >= 500) {
        const e = new HttpError('HTTP ' + res.status + ' for ' + url, res.status, true);
        e.retryAfter = retryAfterMs(res.headers.get('Retry-After'));
        throw e;
      }
      if (res.status !== 206 && res.status !== 200) throw new HttpError('HTTP ' + res.status + ' for ' + url, res.status, false);
      if (/^text\/html\b/i.test(res.headers.get('Content-Type') || '')) {
        throw new HttpError(url + ' answered with an HTML page, not the file (a missing object behind an HTML fallback?)', res.status, false);
      }

      let skip = 0, expected = end - from + 1, partial = false;
      const length = res.headers.has('Content-Length') ? Number(res.headers.get('Content-Length')) : NaN;
      if (res.status === 200) {
        // The server ignored Range and sends the whole file: skip to the range. Correct, but every read now costs the
        // whole file's prefix. Usually a proxy or a server without range support.
        if (size !== null && Number.isFinite(length) && length !== size) {
          throw new HttpError(url + ' is ' + length + ' bytes, the manifest says ' + size, 200, false);
        }
        skip = from;
        this.stats.ignoredRange++;
        if (!this.warnedIgnoredRange) {
          this.warnedIgnoredRange = true;
          this.log('[fetch] ' + url + ' answered 200 to a Range request: the host does not support ranges');
        }
        if (Number.isFinite(length)) expected = Math.min(expected, Math.max(0, length - from));
      } else {
        // Content-Range is only visible cross-origin when the CDN exposes it (Access-Control-Expose-Headers).
        const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('Content-Range') || '');
        if (cr) {
          const [a, b] = [Number(cr[1]), Number(cr[2])], whole = cr[3] === '*' ? null : Number(cr[3]);
          if (a !== from || b < a) throw new HttpError('asked for bytes from ' + from + ', got ' + cr[0], 206, false);
          if (size !== null && whole !== null && whole !== size) throw new HttpError(url + ' is ' + whole + ' bytes, the manifest says ' + size, 206, false);
          expected = Math.min(expected, b - from + 1);
          // fewer bytes than asked without reaching the end of the file: the server caps range sizes
          partial = b < end && (whole === null || b + 1 < whole);
        } else if (Number.isFinite(length)) {
          expected = Math.min(expected, length);
        }
      }

      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
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
          finished = true;
          return 'done';
        }
      }
      finished = true;
      if (received < expected) throw new HttpError('body ended after ' + received + ' of ' + expected + ' bytes: ' + url, res.status, true);
      return partial ? 'more' : 'done';   // 'done' with fewer bytes: the file ended inside the range
    } catch (e) {
      if (ac.signal.aborted && ac.signal.reason === STALLED) {
        this.stats.stalls++;
        throw new HttpError('no data for ' + this.stallMs / 1000 + ' s: ' + url, 0, true);
      }
      if (e instanceof HttpError || signal?.aborted) throw e;
      throw new HttpError(e.message + ': ' + url, 0, true);   // network error
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!finished) reader?.cancel().catch(() => {});
    }
  }
}
