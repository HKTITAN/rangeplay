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

Before you upload, check the folder. Every object must exist, have its size and hash to its own name:

```bash
npx rangeplay verify dist
```

After you deploy, ask the host:

```bash
npx rangeplay doctor https://example.com/game/
```

`doctor` loads the page and checks the isolation headers, finds the manifest (next to the page, or in `dist/`; pass
`--manifest <url>` otherwise), then samples objects with Range requests. It fails a deployment whose objects are
missing, answer with an HTML fallback page, ignore ranges (`200` instead of `206`), report another size, are compressed
on the fly, or live on another origin without CORS. It warns about objects not cached as immutable, a manifest cached
for long, and a boot set recorded against files that are gone. It downloads the smallest object whole to check that
its bytes hash to its name, and it exits with status 1 when something blocks the game, so it fits in a deploy
pipeline.

By hand, the same two key checks:

```bash
curl -sI https://example.com/game/ | grep -i cross-origin
```

```bash
curl -s -o /dev/null -D - -H "Range: bytes=0-99" https://example.com/game/data/ab/ab12...
```

The first should show both isolation headers. The second should answer `206 Partial Content` with
`Content-Range: bytes 0-99/<size>` and the immutable `Cache-Control`. A `200` means the host ignores ranges. The
runtime copes, but every read then downloads the file from its start.

Players can check their own browser at `examples/check/` (on the demo site: `/examples/check/`): shared memory, the
on-device cache, WebGPU and its adapter, and the network path to a game's data (`?manifest=<url>`), with a report they
can paste into a bug report.

## Many small files

If `rangeplay inspect dist/manifest.json` reports hundreds of files under 64 KB, pack with `--pack-small 64k`. They go
into packs of a few MB, so a start-up that reads hundreds of them costs a handful of requests, and the host stores a
handful of objects instead of thousands (some hosts limit the number of files in a deployment). Add
`--order bootset.json` to lay the packs out in the order the engine reads them. See "Packs for small files" in
[architecture.md](architecture.md) for the trade-off.

## Data on another origin

To serve the objects from a CDN domain other than the page's, the CDN must answer CORS: `Access-Control-Allow-Origin`
(your page's origin, or `*`), `Access-Control-Allow-Headers: Range`,
`Access-Control-Expose-Headers: Content-Range, Content-Length`. The runtime fetches objects with CORS, which
`require-corp` accepts; `Cross-Origin-Resource-Policy: cross-origin` does no harm. Without exposed headers the runtime
cannot check `Content-Range`. It still works, but cannot detect a misbehaving cache.

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

## Moving or archiving a game

```bash
npx rangeplay mirror https://example.com/game/dist/manifest.json --out ./game-copy
```

`mirror` downloads a published game, object by object, and checks each one against its name (and each file in a
pack against its hash) before keeping it. An interrupted mirror resumes where it stopped, and nothing that fails a
check is kept. It also copies `bootset.json` when one sits next to the manifest. It writes `manifest.json` last, only
when every object checks out, so an unfinished copy never looks finished. Upload the folder to the new host, or serve
it locally with `rangeplay serve`.
