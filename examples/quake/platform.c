/* rangeplay platform layer for Quake (quakegeneric: https://github.com/erysdren/quakegeneric, id Software's WinQuake
 * with its platform code cut down to a few functions).
 *
 * Every file read the engine makes goes through rp_read. The game's pak files (195 MB for LibreQuake) are fetched from
 * the CDN a range at a time, as the engine asks for them, and cached on the device: a map is downloaded when it loads,
 * and data the engine never asks for (other maps, colored-light files this renderer does not use) is never downloaded.
 * Frames (8-bit pixels plus the palette) go to the GPU worker through the command ring, sound to the page's AudioWorklet
 * through the audio ring, and keys and mouse movement come from the input ring.
 *
 * This file replaces sys_null.c, vid_null.c, snd_null.c and quakegeneric.c in the build (see build-wasm.js). Sound is
 * mixed by id's own snd_dma.c, snd_mem.c and snd_mix.c; this file is their "DMA" driver. It is MIT-licensed like the
 * rest of rangeplay; the program it is linked into is GPL-2.0, like the engine.
 */
#define _GNU_SOURCE /* fopencookie */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define RANGEPLAY_IMPLEMENTATION
#include "rangeplay.h"
#include "rangeplay_keys.h"

/* Quake's headers come last, and emscripten.h not at all: it includes <stdbool.h>, whose true and false macros break
 * Quake's own boolean type (typedef enum {false, true} qboolean). */
#include "quakedef.h"
#include "d_local.h"
#include "quakegeneric.h"

#define OP_FRAME (RP_OP_USER + 0) /* [u32 width][u32 height][256 x u32 palette, RGBA][width * height palette indices] */
#define RING_BYTES (8u << 20)
#define AUDIO_RATE 22050  /* Quake's sounds are 11 kHz; the browser resamples to the device */
#define AUDIO_FRAMES 8192u /* ring capacity, 0.37 s: Quake mixes 0.1 s ahead */
#define HUNK_BYTES (96 << 20)

void *rp_ctl, *rp_gpu, *rp_input, *rp_audio;

/* ---- set-up, called from the engine worker before main() ---- */

uint32_t *rp_setup(void) {
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

/* One call per file of the manifest: its path (such as "id1/pak0.pak"), its id (index in the manifest) and its size. */
void rp_register_file(const char *path, uint32_t id, uint32_t size) {
  if (file_count == MAX_FILES || strlen(path) >= sizeof files[0].path) return;
  strcpy(files[file_count].path, path);
  files[file_count].id = id;
  files[file_count].size = size;
  file_count++;
}

/* The engine names files relative to its base directory ("./id1/pak0.pak"). */
static int find_file(const char *path) {
  while (path[0] == '.' && path[1] == '/') path += 2;
  while (path[0] == '/') path++;
  for (int i = 0; i < file_count; i++)
    if (strcmp(files[i].path, path) == 0) return i;
  return -1;
}

static int64_t read_file(int i, uint32_t offset, void *dst, uint32_t len) {
  if (offset >= files[i].size) return 0;
  if (len > files[i].size - offset) len = files[i].size - offset;
  return rp_read(rp_ctl, files[i].id, offset, dst, len, 0);
}

/* ---- files: the game's data through rp_read; anything else (config.cfg, saved games) in memory ---- */

#define MAX_HANDLES 32
static struct {
  int used;
  int file; /* index in files[], or -1 for a file in memory */
  uint32_t pos;
  FILE *f;
} handles[MAX_HANDLES];

static int new_handle(void) {
  for (int h = 1; h < MAX_HANDLES; h++)
    if (!handles[h].used) {
      memset(&handles[h], 0, sizeof handles[h]);
      handles[h].used = 1;
      handles[h].file = -1;
      return h;
    }
  Sys_Error("out of file handles");
  return -1;
}

FILE *__real_fopen(const char *path, const char *mode);

int Sys_FileOpenRead(char *path, int *hndl) {
  int i = find_file(path);
  FILE *f = NULL;
  if (i < 0 && !(f = __real_fopen(path, "rb"))) {
    *hndl = -1;
    return -1;
  }
  int h = new_handle();
  *hndl = h;
  if (i >= 0) {
    handles[h].file = i;
    return (int)files[i].size;
  }
  handles[h].f = f;
  fseek(f, 0, SEEK_END);
  int len = (int)ftell(f);
  fseek(f, 0, SEEK_SET);
  return len;
}

int Sys_FileOpenWrite(char *path) {
  FILE *f = __real_fopen(path, "wb");
  if (!f) Sys_Error("Error opening %s: %s", path, strerror(errno));
  int h = new_handle();
  handles[h].f = f;
  return h;
}

void Sys_FileClose(int h) {
  if (handles[h].f) fclose(handles[h].f);
  handles[h].used = 0;
}

void Sys_FileSeek(int h, int position) {
  if (handles[h].f) fseek(handles[h].f, position, SEEK_SET);
  else handles[h].pos = (uint32_t)position;
}

int Sys_FileRead(int h, void *dest, int count) {
  if (handles[h].f) return (int)fread(dest, 1, count, handles[h].f);
  int64_t n = read_file(handles[h].file, handles[h].pos, dest, (uint32_t)count);
  if (n < 0) Sys_Error("rangeplay: reading %s failed (%d)", files[handles[h].file].path, (int)n);
  handles[h].pos += (uint32_t)n;
  return (int)n;
}

int Sys_FileWrite(int h, void *data, int count) {
  return handles[h].f ? (int)fwrite(data, 1, count, handles[h].f) : -1;
}

int Sys_FileTime(char *path) {
  struct stat st;
  return find_file(path) >= 0 || stat(path, &st) == 0 ? 1 : -1;
}

void Sys_mkdir(char *path) {
  mkdir(path, 0777);
}

/* The engine also opens game files with fopen (demos, played straight from the pak). The link wraps fopen
 * (-Wl,--wrap=fopen): a game file opens as a stdio stream whose reads are rp_reads. */

typedef struct {
  int file;
  uint32_t pos;
  char buf[64 << 10];
} stream_t;

static ssize_t stream_read(void *cookie, char *buf, size_t len) {
  stream_t *s = cookie;
  int64_t n = read_file(s->file, s->pos, buf, (uint32_t)len);
  if (n < 0) return -1;
  s->pos += (uint32_t)n;
  return (ssize_t)n;
}

static int stream_seek(void *cookie, off_t *offset, int whence) {
  stream_t *s = cookie;
  int64_t base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? s->pos : files[s->file].size;
  int64_t to = base + *offset;
  if (to < 0) return -1;
  s->pos = (uint32_t)to;
  *offset = to;
  return 0;
}

static int stream_close(void *cookie) {
  free(cookie);
  return 0;
}

FILE *__wrap_fopen(const char *path, const char *mode) {
  int i = find_file(path);
  if (i < 0 || mode[0] != 'r') return __real_fopen(path, mode);
  stream_t *s = malloc(sizeof *s);
  if (!s) return NULL;
  s->file = i;
  s->pos = 0;
  cookie_io_functions_t io = {stream_read, NULL, stream_seek, stream_close};
  FILE *f = fopencookie(s, "rb", io);
  if (!f) {
    free(s);
    return NULL;
  }
  setvbuf(f, s->buf, _IOFBF, sizeof s->buf); /* demos read a few bytes at a time: one rp_read per 64 KB */
  return f;
}

/* ---- video: the software renderer draws 8-bit pixels; the GPU worker looks up the palette ---- */

viddef_t vid;
static int vid_w = 640, vid_h = 480;
static byte *vid_buffer;
static short *zbuffer;
static byte *surfcache;
static uint32_t palette[256];
static unsigned frames_drawn;

void VID_SetPalette(unsigned char *p) {
  for (int i = 0; i < 256; i++) palette[i] = p[i * 3] | (p[i * 3 + 1] << 8) | (p[i * 3 + 2] << 16) | 0xff000000u;
}

void VID_ShiftPalette(unsigned char *p) {
  VID_SetPalette(p); /* damage and pickup flashes, underwater tints */
}

void VID_Init(unsigned char *p) {
  int i;
  if ((i = COM_CheckParm("-width")) && i + 1 < com_argc) vid_w = Q_atoi(com_argv[i + 1]);
  if ((i = COM_CheckParm("-height")) && i + 1 < com_argc) vid_h = Q_atoi(com_argv[i + 1]);
  vid_w = vid_w < 320 ? 320 : vid_w > MAXWIDTH ? MAXWIDTH : vid_w & ~3;
  vid_h = vid_h < 200 ? 200 : vid_h > MAXHEIGHT ? MAXHEIGHT : vid_h;

  vid.width = vid.conwidth = vid_w;
  vid.height = vid.conheight = vid_h;
  vid.maxwarpwidth = WARP_WIDTH; /* the underwater view is drawn into a 320 x 200 buffer, then scaled */
  vid.maxwarpheight = WARP_HEIGHT;
  vid.aspect = ((float)vid_h / vid_w) * (320.0f / 240.0f);
  vid.numpages = 1;
  vid.colormap = host_colormap;
  vid.fullbright = 256 - LittleLong(*((int *)vid.colormap + 2048));
  vid_buffer = malloc(vid_w * vid_h);
  zbuffer = malloc(vid_w * vid_h * sizeof *zbuffer);
  vid.buffer = vid.conbuffer = vid_buffer;
  vid.rowbytes = vid.conrowbytes = vid_w;
  d_pzbuffer = zbuffer;

  int size = D_SurfaceCacheForRes(vid_w, vid_h);
  surfcache = malloc(size);
  if (!vid_buffer || !zbuffer || !surfcache) Sys_Error("out of memory for a %dx%d screen", vid_w, vid_h);
  D_InitCaches(surfcache, size);
  VID_SetPalette(p);
}

void VID_Shutdown(void) {}

void VID_Update(vrect_t *rects) {
  (void)rects;
  rp_frame_begin(rp_gpu, 2); /* paces the game to the display: waits while two frames are queued */
  uint32_t n = (uint32_t)(vid_w * vid_h);
  uint32_t *p = rp_ring_reserve(rp_gpu, OP_FRAME, 8 + sizeof palette + n);
  p[0] = (uint32_t)vid_w;
  p[1] = (uint32_t)vid_h;
  memcpy(p + 2, palette, sizeof palette);
  memcpy(p + 2 + 256, vid_buffer, n);
  rp_ring_commit(rp_gpu);
  rp_frame_end(rp_gpu);
  frames_drawn++;
}

void D_BeginDirectRect(int x, int y, byte *pbitmap, int width, int height) {
  (void)x, (void)y, (void)pbitmap, (void)width, (void)height;
}

void D_EndDirectRect(int x, int y, int width, int height) {
  (void)x, (void)y, (void)width, (void)height;
}

/* ---- sound: id's mixer paints into a circular "DMA" buffer; this driver copies what it painted into the audio ring ---- */

#define DMA_SAMPLES 16384 /* 16-bit samples, both channels: 8192 frames */
static short dma_buffer[DMA_SAMPLES];
static uint32_t submitted; /* frames written to the audio ring */
extern int paintedtime;

qboolean SNDDMA_Init(void) {
  shm = &sn;
  shm->splitbuffer = 0;
  shm->channels = 2;
  shm->samplebits = 16;
  shm->speed = AUDIO_RATE;
  shm->samples = DMA_SAMPLES;
  shm->samplepos = 0;
  shm->submission_chunk = 1;
  shm->buffer = (unsigned char *)dma_buffer;
  return true;
}

/* Where "the hardware" is playing: the frames the AudioWorklet has taken from the ring. The mixer paints from there up to
 * 0.1 s ahead. Until the page starts audio (on the first click or key) nothing is taken, so nothing more is painted. */
int SNDDMA_GetDMAPos(void) {
  uint32_t played = submitted - rp_audio_queued(rp_audio);
  shm->samplepos = (int)((played * 2) & (DMA_SAMPLES - 1));
  return shm->samplepos;
}

void SNDDMA_Submit(void) {
  static float out[1024 * 2];
  while ((int)(paintedtime - submitted) > 0) {
    uint32_t n = (uint32_t)(paintedtime - submitted);
    if (n > 1024) n = 1024;
    for (uint32_t i = 0; i < n; i++) {
      uint32_t at = ((submitted + i) * 2) & (DMA_SAMPLES - 1);
      out[i * 2] = dma_buffer[at] / 32768.0f;
      out[i * 2 + 1] = dma_buffer[at + 1] / 32768.0f;
    }
    uint32_t wrote = rp_audio_write(rp_audio, out, n);
    submitted += wrote;
    if (wrote < n) break;
  }
}

void SNDDMA_Shutdown(void) {}

/* ---- input ---- */

#define KEYQ 128
static uint16_t keyq[KEYQ];
static unsigned keyq_read, keyq_write;
static uint8_t held[256];
static float mouse_dx, mouse_dy, wheel;

static void push_key(int down, int key) {
  if (key <= 0 || key > 255 || held[key] == down) return;
  if (keyq_write - keyq_read == KEYQ) return;
  held[key] = (uint8_t)down;
  keyq[keyq_write++ % KEYQ] = (uint16_t)((down << 8) | key);
}

static int quake_key(int code) {
  if (code >= RP_KEY_KeyA && code <= RP_KEY_KeyZ) return 'a' + code - RP_KEY_KeyA;
  if (code >= RP_KEY_Digit0 && code <= RP_KEY_Digit9) return '0' + code - RP_KEY_Digit0;
  if (code >= RP_KEY_Numpad0 && code <= RP_KEY_Numpad9) return '0' + code - RP_KEY_Numpad0;
  if (code >= RP_KEY_F1 && code <= RP_KEY_F12) return K_F1 + code - RP_KEY_F1;
  switch (code) {
    case RP_KEY_ArrowUp: return K_UPARROW;
    case RP_KEY_ArrowDown: return K_DOWNARROW;
    case RP_KEY_ArrowLeft: return K_LEFTARROW;
    case RP_KEY_ArrowRight: return K_RIGHTARROW;
    case RP_KEY_Space: return K_SPACE;
    case RP_KEY_Enter: case RP_KEY_NumpadEnter: return K_ENTER;
    case RP_KEY_Escape: return K_ESCAPE;
    case RP_KEY_Tab: return K_TAB;
    case RP_KEY_Backspace: return K_BACKSPACE;
    case RP_KEY_ShiftLeft: case RP_KEY_ShiftRight: return K_SHIFT;
    case RP_KEY_ControlLeft: case RP_KEY_ControlRight: return K_CTRL;
    case RP_KEY_AltLeft: case RP_KEY_AltRight: return K_ALT;
    case RP_KEY_Insert: return K_INS;
    case RP_KEY_Delete: return K_DEL;
    case RP_KEY_Home: return K_HOME;
    case RP_KEY_End: return K_END;
    case RP_KEY_PageUp: return K_PGUP;
    case RP_KEY_PageDown: return K_PGDN;
    case RP_KEY_Minus: case RP_KEY_NumpadSubtract: return '-';
    case RP_KEY_Equal: return '=';
    case RP_KEY_NumpadAdd: return '+';
    case RP_KEY_NumpadMultiply: return '*';
    case RP_KEY_BracketLeft: return '[';
    case RP_KEY_BracketRight: return ']';
    case RP_KEY_Backslash: return '\\';
    case RP_KEY_Semicolon: return ';';
    case RP_KEY_Quote: return '\'';
    case RP_KEY_Backquote: return '`';
    case RP_KEY_Comma: return ',';
    case RP_KEY_Period: case RP_KEY_NumpadDecimal: return '.';
    case RP_KEY_Slash: case RP_KEY_NumpadDivide: return '/';
    default: return 0;
  }
}

static int mouse_key(int button) {
  return button == 0 ? K_MOUSE1 : button == 2 ? K_MOUSE2 : button == 1 ? K_MOUSE3 : 0;
}

/* Mouse buttons and turning only while the pointer is locked: the click that asks for the lock does not fire, and
 * moving over the page does not spin the view. */
static void poll_input(void) {
  for (int32_t *ev; (ev = rp_records_peek(rp_input)); rp_records_release(rp_input)) {
    int locked = ev[RP_IN_MODS] & 16;
    float dx, dy;
    memcpy(&dx, &ev[RP_IN_DX], sizeof dx);
    memcpy(&dy, &ev[RP_IN_DY], sizeof dy);
    switch (ev[RP_IN_TYPE]) {
      case RP_EV_KEY_DOWN: push_key(1, quake_key(ev[RP_IN_CODE])); break;
      case RP_EV_KEY_UP: push_key(0, quake_key(ev[RP_IN_CODE])); break;
      case RP_EV_POINTER_DOWN: if (locked) push_key(1, mouse_key(ev[RP_IN_CODE])); break;
      case RP_EV_POINTER_UP: push_key(0, mouse_key(ev[RP_IN_CODE])); break;
      case RP_EV_POINTER_MOVE:
        if (locked) {
          mouse_dx += dx;
          mouse_dy += dy;
        }
        break;
      case RP_EV_WHEEL: /* one notch of a wheel is about 100 pixels; trackpads send many small steps */
        wheel += dy;
        for (; wheel >= 40; wheel -= 40) push_key(1, K_MWHEELDOWN), push_key(0, K_MWHEELDOWN);
        for (; wheel <= -40; wheel += 40) push_key(1, K_MWHEELUP), push_key(0, K_MWHEELUP);
        break;
      case RP_EV_BLUR:
        for (int k = 1; k < 256; k++) push_key(0, k);
        mouse_dx = mouse_dy = 0;
        break;
    }
  }
}

int QG_GetKey(int *down, int *key) {
  if (keyq_read == keyq_write) return 0;
  uint16_t k = keyq[keyq_read++ % KEYQ];
  *down = k >> 8;
  *key = k & 0xff;
  return 1;
}

void QG_GetMouseMove(int *x, int *y) {
  *x = (int)mouse_dx;
  *y = (int)mouse_dy;
  mouse_dx -= *x;
  mouse_dy -= *y;
}

void QG_GetJoyAxes(float *axes) {
  (void)axes;
}

/* ---- the rest of the system interface ---- */

qboolean isDedicated;

void Sys_Error(char *error, ...) {
  char text[1024];
  va_list ap;
  va_start(ap, error);
  vsnprintf(text, sizeof text, error, ap);
  va_end(ap);
  fprintf(stderr, "Sys_Error: %s\n", text);
  abort();
}

/* The console goes to the page. Quake's text has its own character set: the high bit selects the bold variant, and
 * characters below 32 are bars and brackets. */
void Sys_Printf(char *fmt, ...) {
  char text[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(text, sizeof text, fmt, ap);
  va_end(ap);
  for (unsigned char *c = (unsigned char *)text; *c; c++) {
    *c &= 0x7f;
    if (*c < 32 && *c != '\n' && *c != '\t') *c = *c >= 0x1d ? '-' : *c == 0x10 ? '[' : *c == 0x11 ? ']' : ' ';
  }
  fputs(text, stdout);
}

void Sys_DebugLog(char *file, char *fmt, ...) {
  (void)file, (void)fmt;
}

void Sys_Quit(void) {
  Host_Shutdown();
  printf("The game has quit. Reload the page to play again.\n");
  for (;;) sleep(3600);
}

double Sys_FloatTime(void) {
  /* In threaded builds the monotonic clock counts from the Unix epoch: count from the first call */
  static double start = -1;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  double now = ts.tv_sec + ts.tv_nsec * 1e-9;
  if (start < 0) start = now - 1.0;
  return now - start;
}

char *Sys_ConsoleInput(void) {
  return NULL;
}

void Sys_Sleep(void) {
  usleep(1000);
}

void Sys_SendKeyEvents(void) {
  poll_input();
}

void Sys_MakeCodeWriteable(unsigned long startaddr, unsigned long length) {
  (void)startaddr, (void)length;
}

void Sys_HighFPPrecision(void) {}
void Sys_LowFPPrecision(void) {}

/* Limits of the engine that are settings: more room for aliases and settings (LibreQuake's config has many), and for
 * the edges and surfaces the renderer keeps in view at once (its maps are far more detailed than 1996's). */
static char *defaults[] = {"-zone", "1024", "+r_maxedges", "60000", "+r_maxsurfs", "20000"};
#define NDEFAULTS (int)(sizeof defaults / sizeof defaults[0])

int main(int argc, char **argv) {
  static quakeparms_t parms;
  static char *args[MAX_NUM_ARGVS];
  int n = 0;
  args[n++] = argv[0];
  for (int i = 0; i < NDEFAULTS; i++) args[n++] = defaults[i];
  for (int i = 1; i < argc && n < MAX_NUM_ARGVS; i++) args[n++] = argv[i];

  mkdir("/id1", 0777); /* where the engine writes config.cfg and saved games (in memory) */
  parms.memsize = HUNK_BYTES;
  parms.membase = malloc(parms.memsize);
  parms.basedir = ".";
  if (!parms.membase) Sys_Error("out of memory for the hunk");
  COM_InitArgv(n, args);
  parms.argc = com_argc;
  parms.argv = com_argv;
  Host_Init(&parms);

  double last = Sys_FloatTime();
  for (;;) {
    double now = Sys_FloatTime();
    unsigned drawn = frames_drawn;
    Host_Frame((float)(now - last)); /* runs a frame at most 72 times a second; a drawn frame waits for the display */
    last = now;
    if (frames_drawn == drawn) usleep(1000);
  }
}
