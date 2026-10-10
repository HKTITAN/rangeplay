# The browser check

A page that tests what rangeplay games need on a player's device, without starting a game, and builds a report to
paste into a bug report. Live at <https://rangeplay.vercel.app/examples/check/>; locally, after `npm run demo`, at
<http://localhost:8080/examples/check/>.

It checks:

- **The page:** cross-origin isolation, SharedArrayBuffer, OffscreenCanvas, `Atomics.waitAsync`, AudioWorklet, Web
  Locks, and how many cores the device reports.
- **The on-device cache:** an OPFS sync access handle in a worker (write, read back, read into shared memory), and the
  storage quota left for the site.
- **WebGPU:** the adapter (vendor, architecture, software fallback or not), its features and key limits, and a device
  that completes a submission.
- **The game data:** Range requests to a game's objects (`?manifest=<url>`, or the demos' when they are next to it),
  that they answer 206, how long they take, and that one object's bytes hash to its name, which catches proxies and
  extensions that rewrite responses.

Nothing leaves the page: the report is only shown, and copied when the player asks.

The demos link here when they cannot start. To do the same in your game, catch `start()`'s error and point players to
the page, or host a copy next to your game. It only needs `src/host.js` and the same headers as the game.
