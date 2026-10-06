/* Native test of native/rangeplay.h: engine threads read through the IO protocol from a stand-in IO server thread that
 * follows the same rules as src/io/core.js; a producer thread fills the command ring while this thread drains it.
 * Build and run: node test/native/run.js */
#define RANGEPLAY_IMPLEMENTATION
#include "../../native/rangeplay.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARENA_BYTES (32u << 20)
#define FILE_BYTES (3u << 20)
#define THREADS 6
#define READS_PER_THREAD 3000
#define SLOTS 8
#define HINTS 64

static uint8_t *arena;
static uint8_t *file_data;
static void *ctl;
static volatile int stop_server = 0;
static long hints_seen = 0;
static int failures = 0;

#define CHECK(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)

static uint32_t rnd(uint32_t *s) {
  *s = *s * 1103515245u + 12345u;
  return *s >> 1;
}

/* The IO server: the job src/io/core.js does, minus the network. */
static void *server(void *arg) {
  (void)arg;
  int32_t *a = (int32_t *)ctl;
  uint32_t cap = (uint32_t)a[RP_IO_HINT_CAP_W];
  while (!RP__LOAD(&stop_server)) {
    int32_t n = RP__LOAD(&a[RP_IO_SLOT_NEXT_W]);
    if (n > SLOTS) n = SLOTS;
    for (int32_t i = 0; i < n; i++) {
      int32_t *s = a + RP_IO_HEADER_WORDS + i * RP_IO_SLOT_WORDS;
      int32_t expected = RP_SLOT_REQUESTED;
      if (!__atomic_compare_exchange_n(&s[RP_SLOT_STATE], &expected, RP_SLOT_TAKEN, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) continue;
      uint64_t off = (uint32_t)s[RP_SLOT_OFF_LO] | ((uint64_t)(uint32_t)s[RP_SLOT_OFF_HI] << 32);
      uint64_t dst = (uint32_t)s[RP_SLOT_DST_LO] | ((uint64_t)(uint32_t)s[RP_SLOT_DST_HI] << 32);
      int32_t len = s[RP_SLOT_LEN], result;
      if (s[RP_SLOT_FILE] != 0) result = RP_ERR_BADF;
      else if (off >= FILE_BYTES) result = 0;
      else {
        if (off + (uint64_t)len > FILE_BYTES) len = (int32_t)(FILE_BYTES - off);
        memcpy(arena + dst, file_data + off, (size_t)len);
        result = len;
      }
      s[RP_SLOT_RESULT] = result;
      RP__STORE(&s[RP_SLOT_STATE], RP_SLOT_DONE);
    }
    uint32_t head = (uint32_t)RP__LOAD(&a[RP_IO_HINT_HEAD_W]), tail = (uint32_t)RP__LOAD(&a[RP_IO_HINT_TAIL_W]);
    if (head - tail > cap) tail = head - cap;
    while (tail != head) {
      int32_t *e = a + RP_IO_HEADER_WORDS + SLOTS * RP_IO_SLOT_WORDS + (tail & (cap - 1)) * RP_IO_HINT_WORDS;
      uint32_t want = tail + 1, s1 = (uint32_t)RP__LOAD(&e[RP_HINT_SEQ]);
      if (s1 != want) {
        if (((s1 - want) & (cap - 1)) == 0 && (int32_t)(s1 - want) > 0) { tail++; continue; } /* overwritten: skip */
        break; /* not published yet */
      }
      int32_t lf = e[RP_HINT_LEN_FLAGS];
      tail++;
      if ((uint32_t)RP__LOAD(&e[RP_HINT_SEQ]) != s1) continue;
      CHECK((lf & RP_HINT_LEN_MASK) > 0, "hint with no length");
      hints_seen++;
    }
    RP__STORE(&a[RP_IO_HINT_TAIL_W], (int32_t)tail);
    sched_yield();
  }
  return 0;
}

static void *reader(void *arg) {
  uintptr_t t = (uintptr_t)arg;
  uint8_t *buf = arena + (4u << 20) + t * (1u << 20); /* this thread's area of the arena */
  uint32_t seed = (uint32_t)(t * 7919 + 1);
  for (int i = 0; i < READS_PER_THREAD; i++) {
    uint64_t off = rnd(&seed) % (FILE_BYTES + 1000);
    uint32_t len = 1 + rnd(&seed) % 300000;
    if (i % 5 == 0) rp_hint(ctl, 0, off, len, i % 10 == 0);
    int64_t n = rp_read(ctl, 0, off, buf, len, 0);
    int64_t want = off >= FILE_BYTES ? 0 : (off + len > FILE_BYTES ? (int64_t)(FILE_BYTES - off) : (int64_t)len);
    CHECK(n == want, "thread %u read %d: got %lld bytes, want %lld", (unsigned)t, i, (long long)n, (long long)want);
    if (n > 0) CHECK(memcmp(buf, file_data + off, (size_t)n) == 0, "thread %u read %d: wrong bytes", (unsigned)t, i);
  }
  int64_t bad = rp_read(ctl, 7, 0, buf, 10, 0);
  CHECK(bad == RP_ERR_BADF, "bad file id: got %lld", (long long)bad);
  return 0;
}

#define RING_CAP 4096u
#define RING_RECORDS 200000u
static void *ring_ptr;

static void *producer(void *arg) {
  (void)arg;
  for (uint32_t i = 0; i < RING_RECORDS; i++) {
    uint32_t len = (i * 13) % 200;
    uint8_t *p = (uint8_t *)rp_ring_reserve(ring_ptr, RP_OP_USER + i % 3, len);
    for (uint32_t k = 0; k < len; k++) p[k] = (uint8_t)(i + k);
    rp_ring_commit(ring_ptr);
  }
  return 0;
}

/* Consumer side of the command ring, as src/shared/ring.js drains it. */
static void drain_ring(void) {
  int32_t *h = (int32_t *)ring_ptr;
  uint8_t *data = (uint8_t *)ring_ptr + RP_RING_HEADER_WORDS * 4;
  uint32_t seen = 0;
  while (seen < RING_RECORDS) {
    uint32_t r = (uint32_t)RP__LOAD(&h[RP_RING_READ_W]), w = (uint32_t)RP__LOAD(&h[RP_RING_WRITE_W]);
    while (r != w) {
      uint32_t *rec = (uint32_t *)(data + (r & (RING_CAP - 1)));
      uint32_t op = rec[0], len = rec[1];
      r += (RP_RECORD_HEADER_BYTES + len + 7u) & ~7u;
      if (op == RP_OP_PAD) continue;
      CHECK(op == RP_OP_USER + seen % 3, "record %u: op %u", seen, op);
      CHECK(len == (seen * 13) % 200, "record %u: length %u", seen, len);
      for (uint32_t k = 0; k < len; k++) {
        if (((uint8_t *)(rec + 2))[k] != (uint8_t)(seen + k)) {
          CHECK(0, "record %u: payload byte %u", seen, k);
          break;
        }
      }
      seen++;
    }
    RP__STORE(&h[RP_RING_READ_W], (int32_t)r);
    sched_yield();
  }
}

int main(void) {
  arena = (uint8_t *)calloc(ARENA_BYTES, 1);
  file_data = (uint8_t *)malloc(FILE_BYTES);
  for (uint32_t i = 0; i < FILE_BYTES; i++) file_data[i] = (uint8_t)(i * 31 + (i >> 9));
  rp_set_memory_base(arena);

  ctl = arena + 64;
  rp_io_init(ctl, SLOTS, HINTS);
  pthread_t srv, threads[THREADS];
  pthread_create(&srv, 0, server, 0);
  for (uintptr_t t = 0; t < THREADS; t++) pthread_create(&threads[t], 0, reader, (void *)t);
  for (int t = 0; t < THREADS; t++) pthread_join(threads[t], 0);
  RP__STORE(&stop_server, 1);
  pthread_join(srv, 0);
  CHECK(hints_seen > 0, "no hints arrived");
  printf("io: %d threads x %d reads, %ld hints seen\n", THREADS, READS_PER_THREAD, hints_seen);

  ring_ptr = arena + (2u << 20);
  rp_ring_init(ring_ptr, RING_CAP);
  pthread_t prod;
  pthread_create(&prod, 0, producer, 0);
  drain_ring();
  pthread_join(prod, 0);
  printf("command ring: %u records through a %u-byte ring\n", RING_RECORDS, RING_CAP);

  void *rr = arena + (3u << 20);
  rp_records_init(rr, 4, 2);
  for (int i = 0; i < 6; i++) {
    int32_t *rec = rp_records_reserve(rr);
    if (!rec) continue;
    rec[0] = i;
    rp_records_commit(rr);
  }
  CHECK(((int32_t *)rr)[RP_RR_DROPPED_W] == 2, "record ring: dropped %d", ((int32_t *)rr)[RP_RR_DROPPED_W]);
  for (int i = 0; i < 4; i++) {
    int32_t *rec = rp_records_peek(rr);
    CHECK(rec && rec[0] == i, "record ring: record %d", i);
    rp_records_release(rr);
  }
  CHECK(rp_records_peek(rr) == 0, "record ring: not empty");

  if (failures) {
    printf("FAILED: %d check(s)\n", failures);
    return 1;
  }
  printf("ok\n");
  return 0;
}
