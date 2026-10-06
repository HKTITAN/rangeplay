# Contributing

Thanks for helping. A few things keep this project easy to work on:

- **No runtime dependencies.** The runtime is plain ES modules that run in browsers and Node without a build step.
  Tools use only Node's standard library.
- **The protocol is shared with C.** If you change `src/shared/layout.js`, change `native/rangeplay.h` the same way.
  `npm test` checks that they agree. Changing an existing number means a new `LAYOUT_VERSION`.
- **Tests.** `npm test` runs everything in Node: real HTTP, engine threads in `worker_threads`, the persistent store
  on Node files. `npm run test:native` builds and runs the C protocol test (any C11 compiler with pthreads; set `CC`).
  A change to IO behaviour should come with a test in `test/io.test.js`.
- **Browser reports.** Say which browser, version and OS, whether the page was cross-origin isolated, and include the
  `onStats` snapshot and console lines starting with `[io]`, `[store]`, `[fetch]` or `[gpu]`.

## Content

Do not open issues or pull requests that include, link to or depend on game content you do not have the rights to.
Examples must use content generated in the repository (like `examples/tile-world`) or released under an open license.
