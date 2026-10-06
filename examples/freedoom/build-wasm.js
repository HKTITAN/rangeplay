// Builds the Doom engine (doomgeneric, GPL-2.0) with rangeplay's platform layer into examples/freedoom/wasm/.
//   node examples/freedoom/build-wasm.js        (needs Emscripten: emcc on PATH, or EMSDK set)
// The output is committed, so the demo builds without Emscripten; rebuild it after changing platform.c.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
const DOOMGENERIC = { repo: 'https://github.com/ozkl/doomgeneric.git', commit: 'dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284' };

// doomgeneric's own Emscripten makefile, minus its SDL front end, SDL sound and stdio WAD reader (platform.c replaces them)
const SOURCES = `dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale f_wipe
  g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox m_cheat
  m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy p_floor p_inter p_lights p_map p_maputl
  p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main
  r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file
  w_main w_wad z_zone i_input i_video doomgeneric`.split(/\s+/);

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'inherit' });
}

const src = join(here, '.build', 'doomgeneric');
if (!existsSync(join(src, '.git'))) {
  await mkdir(src, { recursive: true });
  git(['init', '-q'], src);
  git(['remote', 'add', 'origin', DOOMGENERIC.repo], src);
}
git(['fetch', '-q', '--depth', '1', 'origin', DOOMGENERIC.commit], src);
git(['checkout', '-q', '--force', DOOMGENERIC.commit], src);

const emsdk = process.env.EMSDK;
const emcc = emsdk ? join(emsdk, 'upstream', 'emscripten', process.platform === 'win32' ? 'emcc.exe' : 'emcc') : 'emcc';
const env = { ...process.env };
if (emsdk && !env.EM_CONFIG) env.EM_CONFIG = join(emsdk, '.emscripten');

const dg = join(src, 'doomgeneric');
const out = join(here, 'wasm');
await mkdir(out, { recursive: true });
const args = [
  ...SOURCES.map((s) => join(dg, s + '.c')),
  join(here, 'platform.c'),
  '-I', dg, '-I', join(root, 'native'), '-I', join(here, 'compat'),
  '-DFEATURE_SOUND',                           // sound effects through platform.c's mixer and rangeplay's audio ring
  '-O2', '-w', ...(process.env.DEBUG_WASM ? ['--profiling-funcs', '-sASSERTIONS=1', ...(process.env.DEBUG_WASM === 'ubsan' ? ['-fsanitize=undefined', '-g'] : [])] : []),
  '-pthread', '-sPROXY_TO_PTHREAD',            // main() runs in a pthread, where rp_read may block
  '-sMODULARIZE', '-sEXPORT_ES6', '-sEXPORT_NAME=createDoom',
  '-sENVIRONMENT=web,worker',                  // loaded inside rangeplay's engine worker
  '-sINVOKE_RUN=0',                            // the engine worker calls main() after handing over the memory
  '-sINITIAL_MEMORY=128MB', '-sALLOW_MEMORY_GROWTH=0',
  '-sSTACK_SIZE=1MB', '-sDEFAULT_PTHREAD_STACK_SIZE=1MB',
  '-sEXPORTED_FUNCTIONS=_main,_rp_setup,_rp_register_file',
  '-sEXPORTED_RUNTIME_METHODS=wasmMemory,HEAPU32,FS,callMain,ccall',
  '-o', join(out, 'doom.js'),
];
console.log('compiling ' + (SOURCES.length + 1) + ' files with ' + emcc);
execFileSync(emcc, args, { stdio: 'inherit', env });
console.log('wrote examples/freedoom/wasm/doom.js and doom.wasm');
