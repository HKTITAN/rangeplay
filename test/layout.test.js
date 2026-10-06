import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as layout from '../src/shared/layout.js';

test('native/rangeplay.h and src/shared/layout.js define the same protocol', async () => {
  const header = await readFile(new URL('../native/rangeplay.h', import.meta.url), 'utf8');
  const defines = new Map();
  for (const m of header.matchAll(/^#define (RP_[A-Z0-9_]+) \(?(-?(?:0x[0-9a-fA-F]+|\d+))u?\)?\s*$/gm)) {
    defines.set(m[1].slice(3), Number(m[2]));
  }
  const exported = Object.entries(layout).filter(([, v]) => typeof v === 'number');
  assert.ok(exported.length > 50);
  for (const [name, value] of exported) {
    assert.ok(defines.has(name), `RP_${name} is missing from rangeplay.h`);
    assert.equal(defines.get(name), value, `RP_${name}`);
  }
  for (const [name] of defines) {
    assert.ok(name in layout, `RP_${name} in rangeplay.h has no counterpart in layout.js`);
  }
});

test('native/rangeplay_keys.h is generated from KEY_CODES (run node tools/gen-keys.js)', async () => {
  const { keysHeader } = await import('../tools/gen-keys.js');
  const header = await readFile(new URL('../native/rangeplay_keys.h', import.meta.url), 'utf8');
  assert.equal(header.replace(/\r\n/g, '\n'), keysHeader());
});
