// Builds Quake (quakegeneric, GPL-2.0, plus id Software's sound mixer) with rangeplay's platform layer into
// examples/quake/wasm/.
//   node examples/quake/build-wasm.js        (needs Emscripten: emcc on PATH, or EMSDK set)
// The output is committed, so the demo builds without Emscripten; rebuild it after changing platform.c or engine.patch.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from '../shared/fetch.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
const QUAKEGENERIC = { repo: 'https://github.com/erysdren/quakegeneric.git', commit: '13052102577c629650cf07a46151a4b6e1b19c3c' };
// quakegeneric leaves sound out (snd_null.c); the mixer comes from id Software's own source release, unchanged
const ID_QUAKE = 'https://raw.githubusercontent.com/id-Software/Quake/bf4ac424ce754894ac8f1dae6a3981954bc9852d/WinQuake/';
const ID_SOUND = {
  'snd_dma.c': 'ca673f06d97ce7744fc4de913b89a6693dd630ac1f383a83484fe11686b5c2fd',
  'snd_mem.c': '6d6626624232b9e92037750642249fc15e4278eea3ee8cb6f95870aebc8b8d11',
  'snd_mix.c': 'f3c417099df02fc065bcfc8dc2cd77bad1c05a93a809e57fd32b4f2d29a5df35',
};

// quakegeneric's meson.build, minus sys_null, vid_null, snd_null and its main loop (platform.c replaces them)
const SOURCES = `cd_null chase cl_demo cl_input cl_main cl_parse cl_tent cmd common console crc cvar d_edge d_fill d_init
  d_modech d_part d_polyse d_scan d_sky d_sprite d_surf d_vars d_zpoint draw host_cmd host in_null keys mathlib menu
  model net_loop net_main net_none net_vcr nonintel pr_cmds pr_edict pr_exec r_aclip r_alias r_bsp r_draw r_edge
  r_efrag r_light r_main r_misc r_part r_sky r_sprite r_surf r_vars sbar screen sv_main sv_move sv_phys sv_user view
  wad world zone`.split(/\s+/);

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'inherit' });
}

const src = join(here, '.build', 'quakegeneric');
if (!existsSync(join(src, '.git'))) {
  await mkdir(src, { recursive: true });
  git(['init', '-q'], src);
  git(['remote', 'add', 'origin', QUAKEGENERIC.repo], src);
}
git(['fetch', '-q', '--depth', '1', 'origin', QUAKEGENERIC.commit], src);
git(['checkout', '-q', '--force', QUAKEGENERIC.commit], src);

// LibreQuake's maps are built for today's Quake engines, and engine.patch brings this 1996 engine up to what they need
// (it is GPL-2.0, like the code it changes):
// - Bigger maps: more than 32,767 faces, mark surfaces or clip nodes (the original reads them as signed 16-bit numbers),
//   more than 8,192 leafs, and maps in the BSP2 format. Larger fixed tables for entities, messages and sounds.
// - FitzQuake's protocol (666), which the server now speaks: it allows more than 256 models and sounds. The client also
//   plays demos recorded with it and with RMQ's protocol (999), as LibreQuake's are.
// The patch applies to LF line endings, whatever the platform's git checks out.
for (const name of await readdir(join(src, 'source'))) {
  if (!/\.[ch]$/.test(name)) continue;
  const path = join(src, 'source', name);
  await writeFile(path, (await readFile(path, 'latin1')).replace(/\r\n/g, '\n'), 'latin1');
}
git(['apply', '--whitespace=nowarn', join(here, 'engine.patch')], src);

const sound = join(here, '.build', 'id-sound');
for (const [name, sha256] of Object.entries(ID_SOUND)) await download(ID_QUAKE + name, join(sound, name), sha256);

const emsdk = process.env.EMSDK;
const emcc = emsdk ? join(emsdk, 'upstream', 'emscripten', process.platform === 'win32' ? 'emcc.exe' : 'emcc') : 'emcc';
const env = { ...process.env };
if (emsdk && !env.EM_CONFIG) env.EM_CONFIG = join(emsdk, '.emscripten');

const qg = join(src, 'source');
const out = join(here, 'wasm');
await mkdir(out, { recursive: true });
const args = [
  ...SOURCES.map((s) => join(qg, s + '.c')),
  ...Object.keys(ID_SOUND).map((s) => join(sound, s)),
  join(here, 'platform.c'),
  '-I', qg, '-I', join(root, 'native'),
  '-std=gnu99',                                // 1996 C: false and true are an enum, not C23 keywords
  '-O2', '-w', ...(process.env.DEBUG_WASM ? ['--profiling-funcs', '-sASSERTIONS=1', ...(process.env.DEBUG_WASM === 'ubsan' ? ['-fsanitize=undefined', '-g'] : [])] : []),
  '-pthread', '-sPROXY_TO_PTHREAD',            // main() runs in a pthread, where rp_read may block
  '-sMODULARIZE', '-sEXPORT_ES6', '-sEXPORT_NAME=createQuake',
  '-sENVIRONMENT=web,worker',                  // loaded inside rangeplay's engine worker
  '-sINVOKE_RUN=0',                            // the engine worker calls main() after handing over the memory
  '-sINITIAL_MEMORY=256MB', '-sALLOW_MEMORY_GROWTH=0',   // a 96 MB hunk: LibreQuake's maps are far bigger than 1996's
  '-sSTACK_SIZE=4MB', '-sDEFAULT_PTHREAD_STACK_SIZE=4MB', // the renderer keeps its edge and surface lists on the stack
  '-Wl,--wrap=fopen',                          // demos are opened with fopen: platform.c serves game files itself
  '-sEXPORTED_FUNCTIONS=_main,_rp_setup,_rp_register_file',
  '-sEXPORTED_RUNTIME_METHODS=wasmMemory,HEAPU32,FS,callMain,ccall',
  '-o', join(out, 'quake.js'),
];
console.log('compiling ' + (SOURCES.length + 4) + ' files with ' + emcc);
execFileSync(emcc, args, { stdio: 'inherit', env });
console.log('wrote examples/quake/wasm/quake.js and quake.wasm');
