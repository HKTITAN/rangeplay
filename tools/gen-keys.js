// Writes native/rangeplay_keys.h: the KEY_CODES table of src/shared/layout.js as C constants, so native engines can
// read input events without copying the list by hand. test/layout.test.js checks the header is up to date.
//   node tools/gen-keys.js
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { KEY_CODES } from '../src/shared/layout.js';

export function keysHeader() {
  const lines = KEY_CODES.slice(1).map((code, i) => `#define RP_KEY_${code} ${i + 1}`);
  return `/* rangeplay_keys.h: input event key codes (RP_IN_CODE of RP_EV_KEY_DOWN / RP_EV_KEY_UP), generated from KEY_CODES in
 * src/shared/layout.js by tools/gen-keys.js. Do not edit. 0 means a key without a code here. */
#ifndef RANGEPLAY_KEYS_H
#define RANGEPLAY_KEYS_H

${lines.join('\n')}

#endif /* RANGEPLAY_KEYS_H */
`;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^\/?/, process.platform === 'win32' ? '/' : '')}`) {
  await writeFile(new URL('../native/rangeplay_keys.h', import.meta.url), keysHeader());
  console.log('wrote native/rangeplay_keys.h');
}
