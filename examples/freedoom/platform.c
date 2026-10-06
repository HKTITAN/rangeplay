/* rangeplay platform layer for doomgeneric (https://github.com/ozkl/doomgeneric).
 *
 * The stock Emscripten port preloads the whole WAD before the first frame. Here the engine's WAD reads go through
 * rp_read instead: each lump is fetched from the CDN (and cached on the device) the first time the engine asks for it.
 * Frames go to the GPU worker through the command ring, sound effects to the page's AudioWorklet through the audio
 * ring, and keys and mouse movement come from the input ring.
 *
 * This file replaces doomgeneric_*.c, w_file_stdc.c and i_sdlsound.c in the build (see build-wasm.js). It is
 * MIT-licensed like the rest of rangeplay; the program it is linked into is GPL-2.0, like the engine.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <emscripten.h>

#define RANGEPLAY_IMPLEMENTATION
#include "rangeplay.h"
#include "rangeplay_keys.h"

#include "d_event.h"
#include "doomgeneric.h"
#include "doomkeys.h"
#include "i_sound.h"
#include "i_system.h"
#include "m_misc.h"
#include "w_file.h"
#include "w_wad.h"
#include "z_zone.h"

#define OP_FRAME (RP_OP_USER + 0) /* [u32 width][u32 height] then width * height xrgb8888 pixels */
#define RING_BYTES (8u << 20)
#define AUDIO_RATE 48000
#define AUDIO_FRAMES 16384u /* ring capacity: 0.34 s of stereo */
#define AUDIO_TARGET 4096u  /* keep about 85 ms queued: more than a game tic (28.6 ms), little latency */

void *rp_ctl, *rp_gpu, *rp_input, *rp_audio;

/* ---- set-up, called from the engine worker before main() ---- */

EMSCRIPTEN_KEEPALIVE uint32_t *rp_setup(void) {
  static uint32_t offsets[4];
  rp_ctl = rp_alloc(rp_io_bytes(16, 1024));
  rp_gpu = rp_alloc(rp_ring_bytes(RING_BYTES));
  rp_input = rp_alloc(rp_records_bytes(256, RP_INPUT_WORDS));
  rp_audio = rp_alloc(rp_audio_bytes(AUDIO_FRAMES, 2));
  if (!rp_ctl || !rp_gpu || !rp_input || !rp_audio) return NULL;
  rp_io_init(rp_ctl, 16, 1024);
  rp_ring_init(rp_gpu, RING_BYTES);
  rp_records_init(rp_input, 256, RP_INPUT_WORDS);
  rp_audio_init(rp_audio, AUDIO_FRAMES, 2, AUDIO_RATE);
  offsets[0] = (uint32_t)(uintptr_t)rp_ctl;
  offsets[1] = (uint32_t)(uintptr_t)rp_gpu;
  offsets[2] = (uint32_t)(uintptr_t)rp_input;
  offsets[3] = (uint32_t)(uintptr_t)rp_audio;
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

/* ---- sound effects: an 8-channel mixer writing 48 kHz stereo into the audio ring ---- */

/* the engine's configuration file refers to these (normally defined by its SDL sound code) */
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

#define CHANNELS 8

typedef struct {
  const uint8_t *samples; /* 8-bit unsigned PCM */
  uint32_t length;        /* samples */
  uint32_t rate;          /* Hz */
} sound_t;

static struct {
  const sound_t *sound;
  uint64_t pos;  /* position in samples, 32.32 fixed point */
  uint64_t step; /* source samples per output frame, 32.32 */
  float left, right;
} channels[CHANNELS];

static boolean use_prefix;

/* A sound lump: [u16 format 3][u16 rate][u32 samples] then the samples, with 16 padding samples at each end. It is read
 * through the WAD, so a sound not played before is fetched (and cached) the first time it plays. */
static const sound_t *load_sound(sfxinfo_t *sfx) {
  if (sfx->driver_data) return sfx->driver_data;
  if (sfx->lumpnum < 0) return NULL;
  const uint8_t *data = W_CacheLumpNum(sfx->lumpnum, PU_STATIC);
  uint32_t lumplen = W_LumpLength(sfx->lumpnum);
  if (lumplen < 8 || data[0] != 3 || data[1] != 0) return NULL;
  sound_t *s = Z_Malloc(sizeof *s, PU_STATIC, 0);
  s->rate = data[2] | (data[3] << 8);
  s->length = data[4] | (data[5] << 8) | (data[6] << 16) | ((uint32_t)data[7] << 24);
  if (s->length > lumplen - 8) s->length = lumplen - 8;
  s->samples = data + 8;
  if (s->length > 32) {
    s->samples += 16;
    s->length -= 32;
  }
  if (!s->rate) s->rate = 11025;
  sfx->driver_data = s;
  return s;
}

static void set_params(int channel, int vol, int sep) {
  /* vol 0..127, sep 0 (left) .. 128 (centre) .. 254 (right) */
  float v = vol / 127.0f * 0.5f; /* headroom: eight channels can play at once */
  float l = (254 - sep) / 127.0f, r = sep / 127.0f;
  channels[channel].left = v * (l > 1 ? 1 : l);
  channels[channel].right = v * (r > 1 ? 1 : r);
}

static void mix_audio(void) {
  static float buf[AUDIO_TARGET * 2];
  uint32_t queued = rp_audio_queued(rp_audio);
  if (queued >= AUDIO_TARGET) return;
  uint32_t n = AUDIO_TARGET - queued;
  memset(buf, 0, n * 2 * sizeof(float));
  for (int c = 0; c < CHANNELS; c++) {
    const sound_t *s = channels[c].sound;
    if (!s) continue;
    for (uint32_t i = 0; i < n; i++) {
      uint32_t at = (uint32_t)(channels[c].pos >> 32);
      if (at >= s->length) {
        channels[c].sound = NULL;
        break;
      }
      float x = (s->samples[at] - 128) / 128.0f;
      buf[i * 2] += x * channels[c].left;
      buf[i * 2 + 1] += x * channels[c].right;
      channels[c].pos += channels[c].step;
    }
  }
  for (uint32_t i = 0; i < n * 2; i++) buf[i] = buf[i] > 1 ? 1 : buf[i] < -1 ? -1 : buf[i];
  rp_audio_write(rp_audio, buf, n);
}

static boolean snd_init(boolean prefix) {
  use_prefix = prefix;
  return true;
}

static void snd_shutdown(void) {}

static int snd_lump(sfxinfo_t *sfx) {
  char name[9];
  if (sfx->link) sfx = sfx->link;
  M_snprintf(name, sizeof name, use_prefix ? "ds%s" : "%s", sfx->name);
  return W_CheckNumForName(name);
}

static void snd_update(void) {
  mix_audio();
}

static void snd_params(int channel, int vol, int sep) {
  if (channel >= 0 && channel < CHANNELS) set_params(channel, vol, sep);
}

static int snd_start(sfxinfo_t *sfx, int channel, int vol, int sep) {
  if (channel < 0 || channel >= CHANNELS) return -1;
  const sound_t *s = load_sound(sfx);
  if (!s) return -1;
  channels[channel].sound = s;
  channels[channel].pos = 0;
  channels[channel].step = ((uint64_t)s->rate << 32) / AUDIO_RATE;
  set_params(channel, vol, sep);
  return channel;
}

static void snd_stop(int channel) {
  if (channel >= 0 && channel < CHANNELS) channels[channel].sound = NULL;
}

static boolean snd_playing(int channel) {
  return channel >= 0 && channel < CHANNELS && channels[channel].sound != NULL;
}

static void snd_cache(sfxinfo_t *sounds, int num) {
  (void)sounds;
  (void)num; /* sounds load the first time they play */
}

static snddevice_t sound_devices[] = {SNDDEVICE_SB, SNDDEVICE_PAS, SNDDEVICE_GUS, SNDDEVICE_WAVEBLASTER, SNDDEVICE_SOUNDCANVAS, SNDDEVICE_AWE32};

sound_module_t DG_sound_module = {
  sound_devices, sizeof sound_devices / sizeof sound_devices[0],
  snd_init, snd_shutdown, snd_lump, snd_update, snd_params, snd_start, snd_stop, snd_playing, snd_cache,
};

/* No music yet: Doom's music is MIDI and needs a synthesizer. */
static boolean mus_init(void) { return false; }
static void mus_shutdown(void) {}
static void mus_volume(int volume) { (void)volume; }
static void mus_pause(void) {}
static void mus_resume(void) {}
static void *mus_register(void *data, int len) { (void)data; (void)len; return NULL; }
static void mus_unregister(void *handle) { (void)handle; }
static void mus_play(void *handle, boolean looping) { (void)handle; (void)looping; }
static void mus_stop(void) {}
static boolean mus_playing(void) { return false; }
static void mus_poll(void) {}

music_module_t DG_music_module = {
  NULL, 0, mus_init, mus_shutdown, mus_volume, mus_pause, mus_resume, mus_register, mus_unregister, mus_play, mus_stop, mus_playing, mus_poll,
};

/* ---- input ---- */

#define KEYQ 64
static uint16_t keyq[KEYQ];
static unsigned keyq_read, keyq_write;
static uint8_t held[256];
static int mouse_buttons;

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

/* Mouse: the browser's buttons (0 left, 1 middle, 2 right) as Doom's (bit 0 fire, bit 1 strafe, bit 2 forward); turning
 * only while the pointer is locked, so moving over the page does not spin the view. */
static void post_mouse(int buttons, int dx) {
  event_t ev = {ev_mouse, buttons, dx * 2, 0, 0};
  D_PostEvent(&ev);
}

static int doom_buttons(int browser_buttons) {
  return (browser_buttons & 1 ? 1 : 0) | (browser_buttons & 2 ? 2 : 0) | (browser_buttons & 4 ? 4 : 0);
}

static void poll_input(void) {
  for (int32_t *ev; (ev = rp_records_peek(rp_input)); rp_records_release(rp_input)) {
    int mods = ev[RP_IN_MODS], locked = mods & 16;
    float dx;
    memcpy(&dx, &ev[RP_IN_DX], sizeof dx);
    switch (ev[RP_IN_TYPE]) {
      case RP_EV_KEY_DOWN: push_key(1, doom_key(ev[RP_IN_CODE])); break;
      case RP_EV_KEY_UP: push_key(0, doom_key(ev[RP_IN_CODE])); break;
      case RP_EV_POINTER_DOWN:
      case RP_EV_POINTER_UP:
        /* without pointer lock, the first click (which asks for the lock) does not fire */
        if (locked || ev[RP_IN_TYPE] == RP_EV_POINTER_UP) {
          mouse_buttons = doom_buttons(mods >> 8);
          post_mouse(mouse_buttons, 0);
        }
        break;
      case RP_EV_POINTER_MOVE:
        if (locked && dx != 0) post_mouse(mouse_buttons, (int)lrintf(dx));
        break;
      case RP_EV_BLUR:
        for (int k = 0; k < 256; k++) push_key(0, (unsigned char)k);
        mouse_buttons = 0;
        post_mouse(0, 0);
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
  mix_audio(); /* also between game tics, so the ring never runs dry while frames are drawn */
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
