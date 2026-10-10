#!/usr/bin/env node
// rangeplay command line: pack, serve, bootset, headers, inspect, verify, mirror, doctor.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { bootsetBytes, mergeBootsets } from '../src/shared/bootset.js';
import { FileTable } from '../src/shared/manifest.js';
import { doctor } from './doctor.js';
import { TARGETS, headersFor } from './headers.js';
import { pack } from './pack.js';
import { createServer } from './serve.js';
import { verifyDir, verifyUrl } from './verify.js';

const HELP = `rangeplay: play-as-you-download for the web

  rangeplay pack <dir> --out <dist> [--name <name>] [--block-size 4096] [--data-url <url>] [--link]
                 [--pack-small <size>] [--pack-max 4m] [--order <bootset.json>]
      Hash every file of <dir> into content-addressed objects under <dist>/data/ and write <dist>/manifest.json.
      --data-url: where players fetch the objects, if not next to the manifest (e.g. https://cdn.example.com/game/data/).
      --pack-small: store files under this size (e.g. 64k) back to back in packs of at most --pack-max, so that one
      request fetches many of them. --order: lay packs out in a boot set's order of first touch.

  rangeplay serve [root] [--port 8080] [--host 127.0.0.1] [--latency <ms>] [--rate <KB/s per response>]
                  [--fail-rate <0..1>] [--cross-origin] [--quiet]
      Development server: cross-origin isolation headers, HTTP Range, immutable objects, network imitation.

  rangeplay bootset merge <recording.json>... -o <bootset.json> [--gap <bytes>]
      Combine boot set recordings (saved from a session started with record: true).

  rangeplay headers <${TARGETS.join('|')}> [--data-prefix /path/to/dist/]
      Print the response headers the runtime needs, as configuration for that host.

  rangeplay inspect <manifest.json>
      Summarise a manifest: files, objects, packs, the biggest files.

  rangeplay verify <dist | manifest URL>
      Check that every object exists, has the right size and hashes to its name (packs: every file in them). A URL
      downloads the whole game, as players would.

  rangeplay mirror <manifest URL> --out <dir> [--no-bootset]
      Download a published game into <dir>, checking every object. Resumes where it stopped; manifest.json is written
      last, once everything checks out.

  rangeplay doctor <page or manifest URL> [--manifest <url>] [--bootset <url>] [--sample 6]
      Check a deployment: isolation headers, the manifest, byte ranges, compression, caching, CORS, the boot set.
`;

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// "64k", "4m", "1.5MB", "65536" -> bytes
function parseSize(text, flag) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)(i?b)?$/i.exec(String(text).trim());
  if (!m) throw new Error(`${flag}: not a size: "${text}" (try 64k or 4m)`);
  return Math.round(Number(m[1]) * 1024 ** ' kmg'.indexOf(m[2].toLowerCase() || ' '));
}

const isUrl = (s) => /^https?:\/\//i.test(s || '');

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'pack': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        out: { type: 'string', short: 'o' }, name: { type: 'string' }, 'block-size': { type: 'string' }, link: { type: 'boolean' },
        'data-url': { type: 'string' }, 'pack-small': { type: 'string' }, 'pack-max': { type: 'string' }, order: { type: 'string' },
      } });
      if (!positionals[0] || !values.out) throw new Error('usage: rangeplay pack <dir> --out <dist>');
      await pack({
        src: positionals[0], out: values.out, name: values.name, hardlink: !!values.link, dataPath: values['data-url'] || 'data/',
        blockSize: values['block-size'] ? Number(values['block-size']) : 4096, log: console.log,
        packSmall: values['pack-small'] ? parseSize(values['pack-small'], '--pack-small') : 0,
        ...(values['pack-max'] && { packMax: parseSize(values['pack-max'], '--pack-max') }),
        order: values.order ? JSON.parse(await readFile(values.order, 'utf8')) : null,
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
      if (!rest[0]) throw new Error('usage: rangeplay inspect <manifest.json>');
      const files = new FileTable(JSON.parse(await readFile(rest[0], 'utf8')));
      const ids = [...Array(files.count).keys()].sort((a, b) => files.size(b) - files.size(a));
      const objects = files.objectList();
      let packed = 0, small = 0;
      for (let id = 0; id < files.count; id++) {
        if (files.packed(id)) packed++;
        else if (files.size(id) > 0 && files.size(id) < 65536) small++;
      }
      console.log(`${files.name} version ${files.version}: ${files.count} files, ${mb(files.totalBytes())}, block size ${files.blockSize}`);
      console.log(`  served as ${objects.length} objects, ${mb(files.downloadBytes())}` +
        (files.packCount ? `; ${packed} small files in ${files.packCount} packs` : ''));
      for (const id of ids.slice(0, 10)) console.log(`  ${mb(files.size(id)).padStart(10)}  ${files.path(id)}`);
      if (small >= 200) console.log(`\n${small} files under 64 KB have objects of their own: rangeplay pack --pack-small 64k stores them in packs.`);
      return;
    }
    case 'verify': {
      if (!rest[0]) throw new Error('usage: rangeplay verify <dist | manifest URL>');
      const report = isUrl(rest[0])
        ? await verifyUrl({ manifestUrl: rest[0], log: console.log })
        : await verifyDir({ dist: rest[0], log: console.log });
      printReport(report, 'verified', isUrl(rest[0]) ? 'downloaded' : 'read');
      if (report.unused) console.log(`${report.unused} objects (${mb(report.unusedBytes)}) in data/ belong to no file of this manifest (older versions)`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case 'mirror': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        out: { type: 'string', short: 'o' }, 'no-bootset': { type: 'boolean' },
      } });
      if (!isUrl(positionals[0]) || !values.out) throw new Error('usage: rangeplay mirror <manifest URL> --out <dir>');
      const report = await verifyUrl({ manifestUrl: positionals[0], out: values.out, bootset: !values['no-bootset'], log: console.log });
      printReport(report, 'mirrored');
      if (report.ok) console.log(`${values.out}: ready (manifest.json${report.bootset ? ', bootset.json' : ''}, data/). Serve it with rangeplay serve, or upload it.`);
      else {
        console.log('not finished: run the same command again to resume.');
        process.exitCode = 1;
      }
      return;
    }
    case 'doctor': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        manifest: { type: 'string' }, bootset: { type: 'string' }, sample: { type: 'string' }, page: { type: 'string' },
      } });
      if (!isUrl(positionals[0])) throw new Error('usage: rangeplay doctor <page or manifest URL> [--manifest <url>]');
      const tags = { ok: '[ok]  ', note: '[note]', warn: '[warn]', fail: '[FAIL]' };
      const result = await doctor({
        url: positionals[0], page: values.page || null, manifest: values.manifest || null, bootset: values.bootset || null,
        sample: values.sample ? Number(values.sample) : 6,
        log: ({ level, what, detail }) => console.log(`${tags[level]} ${what}` + (detail ? `\n       ${detail}` : '')),
      });
      const n = (l) => result.checks.filter((c) => c.level === l).length;
      console.log(`\n${result.ok ? 'no blocking problems' : n('fail') + ' blocking problem(s)'}` + (n('warn') ? `, ${n('warn')} warning(s)` : ''));
      if (!result.ok) process.exitCode = 1;
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

function printReport(r, verb, how = 'downloaded') {
  for (const m of r.missing) console.log('missing: ' + m);
  for (const c of r.corrupt) console.log('bad:     ' + c);
  const fetched = r.bytes ? `, ${mb(r.bytes)} ${how}` : '';
  console.log(`${verb} ${r.objects - r.missing.length - r.corrupt.length} of ${r.objects} objects` +
    (r.skipped ? ` (${r.skipped} already there)` : '') + fetched +
    (r.ok ? '' : `: ${r.missing.length} missing, ${r.corrupt.length} bad`));
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
