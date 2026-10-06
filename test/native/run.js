// Builds and runs test/native/protocol_test.c with $CC (default: cc, gcc or clang, whichever exists).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const candidates = process.env.CC ? [process.env.CC] : ['cc', 'gcc', 'clang'];
const cc = candidates.find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
if (!cc) {
  console.log('no C compiler found (set CC): skipping the native protocol test');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'rangeplay-native-'));
const exe = join(dir, process.platform === 'win32' ? 'protocol_test.exe' : 'protocol_test');
try {
  execFileSync(cc, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-pthread', join(here, 'protocol_test.c'), '-o', exe], { stdio: 'inherit' });
  execFileSync(exe, { stdio: 'inherit', timeout: 120000 });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
