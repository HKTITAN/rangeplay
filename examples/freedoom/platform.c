/* rangeplay platform layer for doomgeneric (https://github.com/ozkl/doomgeneric).
 *
 * The stock Emscripten port preloads the whole WAD before the first frame. Here the engine's WAD reads go through
 * rp_read instead: each lump is fetched from the CDN (and cached on the device) the first time the engine asks for it.
 * Frames go to the GPU worker through the command ring; keys come from the input ring.
 *
 * This file replaces doomgeneric_*.c and w_file_stdc.c in the build (see build-wasm.js). It is MIT-licensed like the
 * rest of rangeplay; the program it is linked into is GPL-2.0, like the engine.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <emscripten.h>

#define RANGEPLAY_IMPLEMENTATION
#include "rangeplay.h"
#include "rangeplay_keys.h"

#include "doomgeneric.h"
#include "doomkeys.h"
#include "i_system.h"
#include "w_file.h"
#include "z_zone.h"

#define OP_FRAME (RP_OP_USER + 0) /* [u32 width][u32 height] then width * height xrgb8888 pixels */
#define RING_BYTES (8u << 20)

void *rp_ctl, *rp_gpu, *rp_input;

/* ---- set-up, called from the engine worker before main() ---- */

EMSCRIPTEN_KEEPALIVE uint32_t *rp_setup(void) {
  static uint32_t offsets[3];
  rp_ctl = aligned_alloc(64, rp_io_bytes(16, 1024));
  rp_io_init(rp_ctl, 16, 1024);
  rp_gpu = aligned_alloc(64, rp_ring_bytes(RING_BYTES));
  rp_ring_init(rp_gpu, RING_BYTES);
  rp_input = aligned_alloc(64, rp_records_bytes(256, RP_INPUT_WORDS));
  rp_records_init(rp_input, 256, RP_INPUT_WORDS);
  offsets[0] = (uint32_t)(uintptr_t)rp_ctl;
  offsets[1] = (uint32_t)(uintptr_t)rp_gpu;
  offsets[2] = (uint32_t)(uintptr_t)rp_input;
  return offsets;
}

#define MAX_FILES 64
static struct {
  char path[128];
  uint32_t id;
  uint32_t size;
} files[MAX_FILES];
static int file_count;

/* One call per file of the manifest: its path, its id (index in the manifest) and its size. */
EMSCRIPTEN_KEEPALIVE void rp_register_file(const char *path, uint32_t id, uint32_t size) {
  if (file_count == MAX_FILES || strlen(path) >= sizeof files[0].path) return;
  strcpy(files[file_count].path, path);
  files[file_count].id = id;
  files[file_count].size = size;
  file_count++;
}

static int find_file(const char *path) {
  while (path[0] == '.' && path[1] == '/') path += 2;
  while (path[0] == '/') path++;
  for (int i = 0; i < file_count; i++)
    if (strcmp(files[i].path, path) == 0) return i;
  return -1;
}

/* ---- WAD files: the engine's file class, backed by rp_read (w_file.c looks for stdc_wad_file) ---- */

typedef struct {
  wad_file_t wad;
  uint32_t id;
} rp_wad_file_t;

extern wad_file_class_t stdc_wad_file;

static wad_file_t *open_wad(char *path) {
  int i = find_file(path);
  if (i < 0) return NULL;
  rp_wad_file_t *f = Z_Malloc(sizeof *f, PU_STATIC, 0);
  f->wad.file_class = &stdc_wad_file;
  f->wad.mapped = NULL;
  f->wad.length = files[i].size;
  f->id = files[i].id;
  return &f->wad;
}

static void close_wad(wad_file_t *wad) {
  Z_Free(wad);
}

static size_t read_wad(wad_file_t *wad, unsigned int offset, void *buffer, size_t len) {
  int64_t n = rp_read(rp_ctl, ((rp_wad_file_t *)wad)->id, offset, buffer, (uint32_t)len, 0);
  if (n < 0) I_Error("rangeplay: reading the WAD failed (%d)", (int)n);
  return (size_t)n;
}

wad_file_class_t stdc_wad_file = {open_wad, close_wad, read_wad};

/* ---- input ---- */

#define KEYQ 64
static uint16_t keyq[KEYQ];
static unsigned keyq_read, keyq_write;
static uint8_t held[256];

static void push_key(int pressed, unsigned char key) {
  if (!key || held[key] == pressed) return;
  held[key] = (uint8_t)pressed;
  keyq[keyq_write++ % KEYQ] = (uint16_t)((pressed << 8) | key);
}

static unsigned char doom_key(int code) {
  if (code >= RP_KEY_KeyA && code <= RP_KEY_KeyZ) {
    switch (code) {
      case RP_KEY_KeyW: return KEY_UPARROW;
      case RP_KEY_KeyS: return KEY_DOWNARROW;
      case RP_KEY_KeyA: return KEY_STRAFE_L;
      case RP_KEY_KeyD: return KEY_STRAFE_R;
      default: return (unsigned char)('a' + code - RP_KEY_KeyA);
    }
  }
  if (code >= RP_KEY_Digit0 && code <= RP_KEY_Digit9) return (unsigned char)('0' + code - RP_KEY_Digit0);
  if (code >= RP_KEY_F1 && code <= RP_KEY_F10) return (unsigned char)(KEY_F1 + code - RP_KEY_F1);
  switch (code) {
    case RP_KEY_ArrowUp: return KEY_UPARROW;
    case RP_KEY_ArrowDown: return KEY_DOWNARROW;
    case RP_KEY_ArrowLeft: return KEY_LEFTARROW;
    case RP_KEY_ArrowRight: return KEY_RIGHTARROW;
    case RP_KEY_ControlLeft: case RP_KEY_ControlRight: return KEY_FIRE;
    case RP_KEY_Space: case RP_KEY_KeyE: return KEY_USE;
    case RP_KEY_ShiftLeft: case RP_KEY_ShiftRight: return KEY_RSHIFT;
    case RP_KEY_AltLeft: case RP_KEY_AltRight: return KEY_LALT;
    case RP_KEY_Escape: return KEY_ESCAPE;
    case RP_KEY_Enter: case RP_KEY_NumpadEnter: return KEY_ENTER;
    case RP_KEY_Tab: return KEY_TAB;
    case RP_KEY_Backspace: return KEY_BACKSPACE;
    case RP_KEY_F11: return KEY_F11;
    case RP_KEY_F12: return KEY_F12;
    case RP_KEY_Minus: case RP_KEY_NumpadSubtract: return KEY_MINUS;
    case RP_KEY_Equal: case RP_KEY_NumpadAdd: return KEY_EQUALS;
    case RP_KEY_Comma: return KEY_STRAFE_L;
    case RP_KEY_Period: return KEY_STRAFE_R;
    default: return 0;
  }
}

static void poll_input(void) {
  for (int32_t *ev; (ev = rp_records_peek(rp_input)); rp_records_release(rp_input)) {
    switch (ev[RP_IN_TYPE]) {
      case RP_EV_KEY_DOWN: push_key(1, doom_key(ev[RP_IN_CODE])); break;
      case RP_EV_KEY_UP: push_key(0, doom_key(ev[RP_IN_CODE])); break;
      case RP_EV_POINTER_DOWN: if (ev[RP_IN_CODE] == 0) push_key(1, KEY_FIRE); break;
      case RP_EV_POINTER_UP: if (ev[RP_IN_CODE] == 0) push_key(0, KEY_FIRE); break;
      case RP_EV_BLUR:
        for (int k = 0; k < 256; k++) push_key(0, (unsigned char)k);
        break;
    }
  }
}

int DG_GetKey(int *pressed, unsigned char *key) {
  if (keyq_read == keyq_write) return 0;
  uint16_t k = keyq[keyq_read++ % KEYQ];
  *pressed = k >> 8;
  *key = k & 0xff;
  return 1;
}

/* ---- the rest of the platform ---- */

void DG_Init(void) {}

void DG_DrawFrame(void) {
  rp_frame_begin(rp_gpu, 2); /* paces the game to the display: waits while two frames are queued */
  uint32_t *p = rp_ring_reserve(rp_gpu, OP_FRAME, 8 + DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4);
  p[0] = DOOMGENERIC_RESX;
  p[1] = DOOMGENERIC_RESY;
  memcpy(p + 2, DG_ScreenBuffer, DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4);
  rp_ring_commit(rp_gpu);
  rp_frame_end(rp_gpu);
  poll_input();
}

void DG_SleepMs(uint32_t ms) {
  usleep(ms * 1000);
}

uint32_t DG_GetTicksMs(void) {
  /* In threaded builds emscripten_get_now() counts from the Unix epoch: far past 2^32 ms, so count from the first call */
  static double start = -1;
  double now = emscripten_get_now();
  if (start < 0) start = now;
  return (uint32_t)(now - start);
}

void DG_SetWindowTitle(const char *title) {
  (void)title;
}

int main(int argc, char **argv) {
  doomgeneric_Create(argc, argv);
  for (;;) doomgeneric_Tick();
}
