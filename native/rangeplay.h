/* rangeplay.h: the engine side of the rangeplay shared-memory protocol, for C and C++ compiled to WebAssembly with
 * threads (Emscripten -pthread, or clang/wasi-sdk with shared memory). Single header: in exactly one source file,
 *
 *     #define RANGEPLAY_IMPLEMENTATION
 *     #include "rangeplay.h"
 *
 * The structures live in the module's own linear memory. The engine allocates and initialises them, then hands the
 * memory and the offsets to the runtime's workers from JavaScript (see docs/emscripten.md):
 *
 *     ioWorkerPort.postMessage({ type: 'attach', memory: wasmMemory, controlOffset: ctl });
 *     gpuWorkerPort.postMessage({ type: 'attach', memory: wasmMemory, ringOffset: ring });
 *
 * Blocking calls (rp_read, rp_ring_reserve on a full ring, rp_frame_begin) use memory.atomic.wait32, which browsers
 * only allow in workers: run the engine off the page's main thread (Emscripten: -sPROXY_TO_PTHREAD).
 *
 * Every number here mirrors src/shared/layout.js; test/layout.test.js fails if they drift apart. Protocol details:
 * docs/protocol.md. License: MIT.
 */
#ifndef RANGEPLAY_H
#define RANGEPLAY_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RP_LAYOUT_VERSION 1

#define RP_IO_MAGIC 0x594c5052u
#define RP_COMMAND_RING_MAGIC 0x43475052u
#define RP_RECORD_RING_MAGIC 0x52525052u

/* IO control block: header, slots, hint ring (all int32 words) */
#define RP_IO_MAGIC_W 0
#define RP_IO_VERSION_W 1
#define RP_IO_DOORBELL_W 2
#define RP_IO_SLOT_CAP_W 3
#define RP_IO_SLOT_NEXT_W 4
#define RP_IO_HINT_CAP_W 5
#define RP_IO_HINT_HEAD_W 6
#define RP_IO_HINT_TAIL_W 7
#define RP_IO_READY_W 8
#define RP_IO_HEADER_WORDS 16

#define RP_IO_SLOT_WORDS 16
#define RP_SLOT_STATE 0
#define RP_SLOT_FILE 1
#define RP_SLOT_OFF_LO 2
#define RP_SLOT_OFF_HI 3
#define RP_SLOT_DST_LO 4
#define RP_SLOT_DST_HI 5
#define RP_SLOT_LEN 6
#define RP_SLOT_RESULT 7
#define RP_SLOT_FLAGS 8

#define RP_SLOT_IDLE 0
#define RP_SLOT_REQUESTED 1
#define RP_SLOT_TAKEN 2
#define RP_SLOT_DONE 3

#define RP_READ_NO_READAHEAD 1

#define RP_IO_HINT_WORDS 8
#define RP_HINT_SEQ 0
#define RP_HINT_FILE 1
#define RP_HINT_OFF_LO 2
#define RP_HINT_OFF_HI 3
#define RP_HINT_LEN_FLAGS 4
#define RP_HINT_SPECULATIVE 0x40000000
#define RP_HINT_LEN_MASK 0x3fffffff

#define RP_ERR_IO (-5)
#define RP_ERR_BADF (-9)
#define RP_ERR_INVAL (-22)

/* command ring */
#define RP_RING_MAGIC_W 0
#define RP_RING_CAP_W 1
#define RP_RING_WRITE_W 2
#define RP_RING_READ_W 3
#define RP_RING_FRAMES_SUBMITTED_W 4
#define RP_RING_FRAMES_DONE_W 5
#define RP_RING_HEADER_WORDS 16

#define RP_OP_PAD 0
#define RP_OP_FRAME_END 1
#define RP_OP_USER 16
#define RP_RECORD_HEADER_BYTES 8

/* record ring */
#define RP_RR_MAGIC_W 0
#define RP_RR_CAP_W 1
#define RP_RR_RECORD_WORDS_W 2
#define RP_RR_WRITE_W 3
#define RP_RR_READ_W 4
#define RP_RR_DROPPED_W 5
#define RP_RR_HEADER_WORDS 8

/* input events (record ring of RP_INPUT_WORDS words) */
#define RP_INPUT_WORDS 8
#define RP_IN_TYPE 0
#define RP_IN_CODE 1
#define RP_IN_X 2
#define RP_IN_Y 3
#define RP_IN_DX 4
#define RP_IN_DY 5
#define RP_IN_MODS 6
#define RP_IN_TIME 7

#define RP_EV_KEY_DOWN 1
#define RP_EV_KEY_UP 2
#define RP_EV_POINTER_DOWN 3
#define RP_EV_POINTER_UP 4
#define RP_EV_POINTER_MOVE 5
#define RP_EV_WHEEL 6
#define RP_EV_RESIZE 7
#define RP_EV_BLUR 8

/* ---- IO ---- */
size_t rp_io_bytes(uint32_t slots, uint32_t hint_cap);
/* ctl: 8-byte aligned, rp_io_bytes() long. hint_cap: a power of two (at least 2), or 0 for no hints. */
void rp_io_init(void *ctl, uint32_t slots, uint32_t hint_cap);
/* Reads len bytes of file `file` (its index in manifest.json) at `offset` into dst. Blocks the calling thread until the
 * bytes are there. Returns the bytes read (short at end of file) or a negative RP_ERR_*. Each thread uses one slot,
 * claimed on its first call: create the control block with at least as many slots as threads that read. */
int64_t rp_read(void *ctl, uint32_t file, uint64_t offset, void *dst, uint32_t len, uint32_t flags);
/* Announces a read the engine will make soon so the bytes can be fetched now. Never blocks. */
void rp_hint(void *ctl, uint32_t file, uint64_t offset, uint32_t len, int speculative);

/* ---- command ring (one producer thread) ---- */
size_t rp_ring_bytes(uint32_t cap);
/* cap: a power of two, at least 256. */
void rp_ring_init(void *ring, uint32_t cap);
/* Reserves a command; returns where to write its payload. Waits while the ring is full. */
void *rp_ring_reserve(void *ring, uint32_t op, uint32_t payload_bytes);
void rp_ring_commit(void *ring);
/* Waits until fewer than max_in_flight frames are queued or drawing. */
void rp_frame_begin(void *ring, uint32_t max_in_flight);
void rp_frame_end(void *ring);

/* ---- record ring (one producer, one consumer) ---- */
size_t rp_records_bytes(uint32_t cap, uint32_t record_words);
void rp_records_init(void *ring, uint32_t cap, uint32_t record_words);
/* Consumer: the oldest record, or NULL. Read it, then rp_records_release(). */
int32_t *rp_records_peek(void *ring);
void rp_records_release(void *ring);
/* Producer: a free record or NULL when full (the record is counted as dropped). Fill it, then rp_records_commit(). */
int32_t *rp_records_reserve(void *ring);
void rp_records_commit(void *ring);

/* Addresses sent to the IO worker are offsets in linear memory. Native builds (tests) set the base they count from. */
void rp_set_memory_base(const void *base);

#ifdef __cplusplus
}
#endif
#endif /* RANGEPLAY_H */

#ifdef RANGEPLAY_IMPLEMENTATION
#ifndef RANGEPLAY_IMPLEMENTED
#define RANGEPLAY_IMPLEMENTED

#define RP__LOAD(p) __atomic_load_n((p), __ATOMIC_SEQ_CST)
#define RP__STORE(p, v) __atomic_store_n((p), (v), __ATOMIC_SEQ_CST)
#define RP__ADD(p, v) __atomic_fetch_add((p), (v), __ATOMIC_SEQ_CST)
#ifdef __cplusplus
#define RP__TLS thread_local
#else
#define RP__TLS _Thread_local
#endif

#if defined(__wasm__)
static void rp__wait(int32_t *addr, int32_t expected) {
  __builtin_wasm_memory_atomic_wait32((int *)addr, expected, -1);
}
static void rp__notify(int32_t *addr) {
  __builtin_wasm_memory_atomic_notify((int *)addr, 0xffffffffu);
}
#else
/* Native builds exist for testing the protocol: wait by yielding. */
#include <sched.h>
static void rp__wait(int32_t *addr, int32_t expected) {
  while (RP__LOAD(addr) == expected) sched_yield();
}
static void rp__notify(int32_t *addr) {
  (void)addr;
}
#endif

static const uint8_t *rp__base = 0;
static RP__TLS int32_t rp__slot = -1;        /* word index of this thread's IO slot */
static RP__TLS uint32_t rp__ring_pending = 0;
static RP__TLS int rp__ring_reserved = 0;

void rp_set_memory_base(const void *base) {
  rp__base = (const uint8_t *)base;
}

size_t rp_io_bytes(uint32_t slots, uint32_t hint_cap) {
  return (size_t)(RP_IO_HEADER_WORDS + slots * RP_IO_SLOT_WORDS + hint_cap * RP_IO_HINT_WORDS) * 4;
}

void rp_io_init(void *ctl, uint32_t slots, uint32_t hint_cap) {
  int32_t *a = (int32_t *)ctl;
  size_t words = rp_io_bytes(slots, hint_cap) / 4;
  for (size_t i = 0; i < words; i++) a[i] = 0;
  a[RP_IO_VERSION_W] = RP_LAYOUT_VERSION;
  a[RP_IO_SLOT_CAP_W] = (int32_t)slots;
  a[RP_IO_HINT_CAP_W] = (int32_t)hint_cap;
  RP__STORE(&a[RP_IO_MAGIC_W], (int32_t)RP_IO_MAGIC);
}

static void rp__ring_doorbell(int32_t *a) {
  RP__ADD(&a[RP_IO_DOORBELL_W], 1);
  rp__notify(&a[RP_IO_DOORBELL_W]);
}

int64_t rp_read(void *ctl, uint32_t file, uint64_t offset, void *dst, uint32_t len, uint32_t flags) {
  int32_t *a = (int32_t *)ctl;
  if (len > 0x7fffffffu) return RP_ERR_INVAL;
  if (rp__slot < 0) {
    int32_t s = RP__ADD(&a[RP_IO_SLOT_NEXT_W], 1);
    if (s >= a[RP_IO_SLOT_CAP_W]) return RP_ERR_INVAL; /* out of slots */
    rp__slot = RP_IO_HEADER_WORDS + s * RP_IO_SLOT_WORDS;
  }
  int32_t *s = a + rp__slot;
  uint64_t addr = (uint64_t)((uintptr_t)dst - (uintptr_t)rp__base);
  s[RP_SLOT_FILE] = (int32_t)file;
  s[RP_SLOT_OFF_LO] = (int32_t)(uint32_t)offset;
  s[RP_SLOT_OFF_HI] = (int32_t)(uint32_t)(offset >> 32);
  s[RP_SLOT_DST_LO] = (int32_t)(uint32_t)addr;
  s[RP_SLOT_DST_HI] = (int32_t)(uint32_t)(addr >> 32);
  s[RP_SLOT_LEN] = (int32_t)len;
  s[RP_SLOT_FLAGS] = (int32_t)flags;
  s[RP_SLOT_RESULT] = 0;
  RP__STORE(&s[RP_SLOT_STATE], RP_SLOT_REQUESTED);
  rp__ring_doorbell(a);
  for (;;) {
    int32_t st = RP__LOAD(&s[RP_SLOT_STATE]);
    if (st == RP_SLOT_DONE) break;
    rp__wait(&s[RP_SLOT_STATE], st);
  }
  int32_t res = RP__LOAD(&s[RP_SLOT_RESULT]);
  RP__STORE(&s[RP_SLOT_STATE], RP_SLOT_IDLE);
  return res;
}

void rp_hint(void *ctl, uint32_t file, uint64_t offset, uint32_t len, int speculative) {
  int32_t *a = (int32_t *)ctl;
  uint32_t cap = (uint32_t)a[RP_IO_HINT_CAP_W];
  if (!cap || !len) return;
  uint32_t i = (uint32_t)RP__ADD(&a[RP_IO_HINT_HEAD_W], 1);
  int32_t *e = a + RP_IO_HEADER_WORDS + a[RP_IO_SLOT_CAP_W] * RP_IO_SLOT_WORDS + (i & (cap - 1)) * RP_IO_HINT_WORDS;
  RP__STORE(&e[RP_HINT_SEQ], (int32_t)~(i + 1)); /* being written */
  e[RP_HINT_FILE] = (int32_t)file;
  e[RP_HINT_OFF_LO] = (int32_t)(uint32_t)offset;
  e[RP_HINT_OFF_HI] = (int32_t)(uint32_t)(offset >> 32);
  e[RP_HINT_LEN_FLAGS] = (int32_t)((len > RP_HINT_LEN_MASK ? RP_HINT_LEN_MASK : len) | (speculative ? RP_HINT_SPECULATIVE : 0));
  RP__STORE(&e[RP_HINT_SEQ], (int32_t)(i + 1)); /* published */
  rp__ring_doorbell(a);
}

size_t rp_ring_bytes(uint32_t cap) {
  return RP_RING_HEADER_WORDS * 4 + (size_t)cap;
}

void rp_ring_init(void *ring, uint32_t cap) {
  int32_t *h = (int32_t *)ring;
  for (int i = 0; i < RP_RING_HEADER_WORDS; i++) h[i] = 0;
  h[RP_RING_CAP_W] = (int32_t)cap;
  RP__STORE(&h[RP_RING_MAGIC_W], (int32_t)RP_COMMAND_RING_MAGIC);
}

void *rp_ring_reserve(void *ring, uint32_t op, uint32_t payload_bytes) {
  int32_t *h = (int32_t *)ring;
  uint8_t *data = (uint8_t *)ring + RP_RING_HEADER_WORDS * 4;
  uint32_t cap = (uint32_t)h[RP_RING_CAP_W], mask = cap - 1;
  uint32_t need = (RP_RECORD_HEADER_BYTES + payload_bytes + 7u) & ~7u;
  if (need > cap / 2) return 0;
  uint32_t w = (uint32_t)RP__LOAD(&h[RP_RING_WRITE_W]);
  for (;;) {
    int32_t r = RP__LOAD(&h[RP_RING_READ_W]);
    uint32_t tail = cap - (w & mask);
    uint32_t total = tail < need ? tail + need : need;
    if ((uint32_t)(w - (uint32_t)r) + total <= cap) {
      if (tail < need) {
        uint32_t *pad = (uint32_t *)(data + (w & mask));
        pad[0] = RP_OP_PAD;
        pad[1] = tail - RP_RECORD_HEADER_BYTES;
        w += tail;
      }
      uint32_t *rec = (uint32_t *)(data + (w & mask));
      rec[0] = op;
      rec[1] = payload_bytes;
      rp__ring_pending = w + need;
      rp__ring_reserved = 1;
      return rec + 2;
    }
    rp__wait(&h[RP_RING_READ_W], r);
  }
}

void rp_ring_commit(void *ring) {
  int32_t *h = (int32_t *)ring;
  if (!rp__ring_reserved) return;
  rp__ring_reserved = 0;
  RP__STORE(&h[RP_RING_WRITE_W], (int32_t)rp__ring_pending);
  rp__notify(&h[RP_RING_WRITE_W]);
}

void rp_frame_begin(void *ring, uint32_t max_in_flight) {
  int32_t *h = (int32_t *)ring;
  for (;;) {
    int32_t done = RP__LOAD(&h[RP_RING_FRAMES_DONE_W]);
    uint32_t submitted = (uint32_t)RP__LOAD(&h[RP_RING_FRAMES_SUBMITTED_W]);
    if ((uint32_t)(submitted - (uint32_t)done) < max_in_flight) return;
    rp__wait(&h[RP_RING_FRAMES_DONE_W], done);
  }
}

void rp_frame_end(void *ring) {
  int32_t *h = (int32_t *)ring;
  rp_ring_reserve(ring, RP_OP_FRAME_END, 0);
  rp_ring_commit(ring);
  RP__ADD(&h[RP_RING_FRAMES_SUBMITTED_W], 1);
}

size_t rp_records_bytes(uint32_t cap, uint32_t record_words) {
  return (size_t)(RP_RR_HEADER_WORDS + cap * record_words) * 4;
}

void rp_records_init(void *ring, uint32_t cap, uint32_t record_words) {
  int32_t *h = (int32_t *)ring;
  for (int i = 0; i < RP_RR_HEADER_WORDS; i++) h[i] = 0;
  h[RP_RR_CAP_W] = (int32_t)cap;
  h[RP_RR_RECORD_WORDS_W] = (int32_t)record_words;
  RP__STORE(&h[RP_RR_MAGIC_W], (int32_t)RP_RECORD_RING_MAGIC);
}

int32_t *rp_records_peek(void *ring) {
  int32_t *h = (int32_t *)ring;
  uint32_t w = (uint32_t)RP__LOAD(&h[RP_RR_WRITE_W]), r = (uint32_t)RP__LOAD(&h[RP_RR_READ_W]);
  if (w == r) return 0;
  return h + RP_RR_HEADER_WORDS + (r & ((uint32_t)h[RP_RR_CAP_W] - 1)) * (uint32_t)h[RP_RR_RECORD_WORDS_W];
}

void rp_records_release(void *ring) {
  int32_t *h = (int32_t *)ring;
  RP__ADD(&h[RP_RR_READ_W], 1);
  rp__notify(&h[RP_RR_READ_W]);
}

int32_t *rp_records_reserve(void *ring) {
  int32_t *h = (int32_t *)ring;
  uint32_t cap = (uint32_t)h[RP_RR_CAP_W];
  uint32_t w = (uint32_t)RP__LOAD(&h[RP_RR_WRITE_W]), r = (uint32_t)RP__LOAD(&h[RP_RR_READ_W]);
  if ((uint32_t)(w - r) >= cap) {
    RP__ADD(&h[RP_RR_DROPPED_W], 1);
    return 0;
  }
  return h + RP_RR_HEADER_WORDS + (w & (cap - 1)) * (uint32_t)h[RP_RR_RECORD_WORDS_W];
}

void rp_records_commit(void *ring) {
  int32_t *h = (int32_t *)ring;
  RP__ADD(&h[RP_RR_WRITE_W], 1);
  rp__notify(&h[RP_RR_WRITE_W]);
}

#endif /* RANGEPLAY_IMPLEMENTED */
#endif /* RANGEPLAY_IMPLEMENTATION */
