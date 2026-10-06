# Deploying

rangeplay needs a static host that serves byte ranges, which almost every host and CDN does. Two things need
configuring: headers and caching.

## Headers

The page needs **cross-origin isolation**, or browsers turn SharedArrayBuffer off:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Under `require-corp`, every resource the page loads must allow it. Same-origin resources get
`Cross-Origin-Resource-Policy: same-origin`; resources from another origin need `cross-origin` (or CORS). Third-party
scripts, fonts, iframes and analytics that do not send these headers stop loading. Check them first.
`Cross-Origin-Embedder-Policy: credentialless` is a softer alternative, supported in Chromium and Firefox.

The data objects (`data/xx/<hash>`) should be served:

```
Cache-Control: public, max-age=31536000, immutable
Content-Type: application/octet-stream
```

They never change, so they can be cached for a year and need no invalidation on deploy. `application/octet-stream`
keeps CDNs from compressing them on the fly. Compressing a response breaks byte ranges, because a range then counts
bytes of the compressed body.

`rangeplay headers <target>` prints both sets of headers for Cloudflare Pages, Netlify, nginx, Caddy or Vercel:

```bash
npx rangeplay headers cloudflare --data-prefix /game/
```

`--data-prefix` is the URL path of the folder that holds `manifest.json`.

## Checking a deployment

```bash
curl -sI https://example.com/game/ | grep -i cross-origin
```

```bash
curl -s -o /dev/null -D - -H "Range: bytes=0-99" https://example.com/game/data/ab/ab12...
```

The first should show both isolation headers. The second should answer `206 Partial Content` with
`Content-Range: bytes 0-99/<size>` and the immutable `Cache-Control`. A `200` means the host ignores ranges. The
runtime copes, but every read then downloads the file from its start.

## Data on another origin

To serve the objects from a CDN domain other than the page's:

- the CDN must send `Cross-Origin-Resource-Policy: cross-origin` (required under `require-corp`);
- and CORS: `Access-Control-Allow-Origin` (your page's origin, or `*`), `Access-Control-Allow-Headers: Range`,
  `Access-Control-Expose-Headers: Content-Range, Content-Length`. Without exposed headers the runtime cannot check
  `Content-Range`. It still works, but cannot detect a misbehaving cache.

Pack with `--data-url https://cdn.example.com/my-game/data/` (it sets `dataPath` in the manifest) and upload
`dist/data/` there. `rangeplay serve --cross-origin` sends these headers for
local testing.

## Throughput

A CDN on HTTP/2 or HTTP/3 multiplexes every request over one connection. Over HTTP/1.1, browsers open at most six
connections per host, which caps how many reads and prefetches run at once. The dev server is HTTP/1.1, so the
demo's numbers are conservative.

Some hosts limit the speed of each stream rather than of the connection. Then the number of requests in flight sets
the throughput, so raise `hintConcurrency`, `bootConcurrency` and `speculativeConcurrency` (`start({ io: { ... } })`)
and lower `demandSliceBytes`. Measure with the stats from `onStats`: `bytesFetched` over time, `fetchesActive`, and
`waitMs / readsWaited` for how long engine threads wait.

## Updating

Run `rangeplay pack` into the same output folder. Only new or changed files produce new objects. Upload the new
objects first and `manifest.json` last. Keep old objects for a while: players who loaded the old manifest are still
reading them.

Give `manifest.json` (and `bootset.json`) a short cache lifetime, or `no-cache`, since they are the only files whose
contents change at the same URL.
