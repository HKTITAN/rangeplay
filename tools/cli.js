#!/usr/bin/env node
// rangeplay command line: pack, serve, bootset, headers, inspect.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { bootsetBytes, mergeBootsets } from '../src/shared/bootset.js';
import { FileTable } from '../src/shared/manifest.js';
import { TARGETS, headersFor } from './headers.js';
import { pack } from './pack.js';
import { createServer } from './serve.js';

const HELP = `rangeplay: play-as-you-download for the web

  rangeplay pack <dir> --out <dist> [--name <name>] [--block-size 4096] [--data-url <url>] [--link]
      Hash every file of <dir> into content-addressed objects under <dist>/data/ and write <dist>/manifest.json.
      --data-url: where players fetch the objects, if not next to the manifest (e.g. https://cdn.example.com/game/data/).

  rangeplay serve [root] [--port 8080] [--host 127.0.0.1] [--latency <ms>] [--rate <KB/s per response>]
                  [--fail-rate <0..1>] [--cross-origin] [--quiet]
      Development server: cross-origin isolation headers, HTTP Range, immutable objects, network imitation.

  rangeplay bootset merge <recording.json>... -o <bootset.json> [--gap <bytes>]
      Combine boot set recordings (saved from a session started with record: true).

  rangeplay headers <${TARGETS.join('|')}> [--data-prefix /path/to/dist/]
      Print the response headers the runtime needs, as configuration for that host.

  rangeplay inspect <manifest.json>
      Summarise a manifest: files, sizes, the biggest files.
`;

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'pack': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        out: { type: 'string', short: 'o' }, name: { type: 'string' }, 'block-size': { type: 'string' }, link: { type: 'boolean' },
        'data-url': { type: 'string' },
      } });
      if (!positionals[0] || !values.out) throw new Error('usage: rangeplay pack <dir> --out <dist>');
      await pack({
        src: positionals[0], out: values.out, name: values.name, hardlink: !!values.link, dataPath: values['data-url'] || 'data/',
        blockSize: values['block-size'] ? Number(values['block-size']) : 4096, log: console.log,
      });
      return;
    }
    case 'serve': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        port: { type: 'string', short: 'p' }, host: { type: 'string' }, latency: { type: 'string' }, rate: { type: 'string' },
        'fail-rate': { type: 'string' }, 'cross-origin': { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' },
      } });
      const opts = {
        root: positionals[0] || '.', latencyMs: Number(values.latency || 0), rateKBps: Number(values.rate || 0),
        failRate: Number(values['fail-rate'] || 0), crossOrigin: !!values['cross-origin'], log: values.quiet ? () => {} : console.log,
      };
      const port = Number(values.port || 8080), host = values.host || '127.0.0.1';
      const server = createServer(opts);
      server.listen(port, host, () => {
        const extras = [opts.latencyMs && `+${opts.latencyMs} ms latency`, opts.rateKBps && `${opts.rateKBps} KB/s per response`, opts.failRate && `${opts.failRate * 100}% 503s`].filter(Boolean);
        console.log(`serving ${opts.root} at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/` + (extras.length ? ` (${extras.join(', ')})` : ''));
      });
      return;
    }
    case 'bootset': {
      const [sub, ...args] = rest;
      if (sub !== 'merge') throw new Error('usage: rangeplay bootset merge <recording.json>... -o <bootset.json>');
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string', short: 'o' }, gap: { type: 'string' } } });
      if (!positionals.length || !values.out) throw new Error('usage: rangeplay bootset merge <recording.json>... -o <bootset.json>');
      const sets = await Promise.all(positionals.map(async (p) => JSON.parse(await readFile(p, 'utf8'))));
      const merged = mergeBootsets(sets, { gap: Number(values.gap || 0) });
      await writeFile(values.out, JSON.stringify(merged));
      console.log(`${values.out}: ${merged.files.length} files, ${mb(bootsetBytes(merged))} from ${sets.length} recording(s)`);
      return;
    }
    case 'headers': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'data-prefix': { type: 'string' } } });
      process.stdout.write(headersFor(positionals[0], { dataPrefix: values['data-prefix'] || '/' }));
      return;
    }
    case 'inspect': {
      const files = new FileTable(JSON.parse(await readFile(rest[0], 'utf8')));
      const ids = [...Array(files.count).keys()].sort((a, b) => files.size(b) - files.size(a));
      const unique = new Set(files.hashes).size;
      console.log(`${files.name} version ${files.version}: ${files.count} files (${unique} unique), ${mb(files.totalBytes())}, block size ${files.blockSize}`);
      for (const id of ids.slice(0, 10)) console.log(`  ${mb(files.size(id)).padStart(10)}  ${files.path(id)}`);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      throw new Error('unknown command "' + cmd + '"\n\n' + HELP);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
