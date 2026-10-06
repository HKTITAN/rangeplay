# Shared-memory protocol (layout version 1)

All structures are little-endian 32-bit words in one shared memory: a SharedArrayBuffer, or a shared
`WebAssembly.Memory`. Every structure starts on an 8-byte boundary. Counters are unsigned 32-bit values that wrap
around; compare them with `(a - b) mod 2^32`. Words marked *atomic* are only read and written with atomic operations
(`Atomics.*` in JavaScript, `__atomic_*` in C). [`src/shared/layout.js`](../src/shared/layout.js) and
[`native/rangeplay.h`](../native/rangeplay.h) define the same constants, and `test/layout.test.js` checks they match.

## IO control block

```
header   16 words
slots    SLOT_CAP x 16 words
hints    HINT_CAP x 8 words
size     (16 + 16 * SLOT_CAP + 8 * HINT_CAP) * 4 bytes
```

| Header word | Name        | Written by                   | Meaning                                                    |
| ----------- | ----------- | ---------------------------- | ---------------------------------------------------------- |
| 0           | MAGIC       | engine (init)                | `0x594c5052` ("RPLY"), stored last at init                 |
| 1           | VERSION     | engine (init)                | 1                                                          |
| 2           | DOORBELL    | engine, atomic add + notify  | bumped after every request and every hint                  |
| 3           | SLOT_CAP    | engine (init)                | number of slots                                            |
| 4           | SLOT_NEXT   | engine threads, atomic add   | slots handed out; a thread claims slot `add(SLOT_NEXT, 1)` |
| 5           | HINT_CAP    | engine (init)                | hint ring entries: a power of two (at least 2), or 0       |
| 6           | HINT_HEAD   | engine threads, atomic add   | hints claimed                                              |
| 7           | HINT_TAIL   | IO worker, atomic store      | hints consumed                                             |
| 8           | READY       | IO worker, atomic + notify   | 1 once the IO worker serves this block                     |
| 9..15       |             |                              | reserved, zero                                             |

### Slots

Each engine thread that reads owns one slot. It claims the slot on its first read and keeps it.

| Word | Name     | Meaning                                                                         |
| ---- | -------- | ------------------------------------------------------------------------------- |
| 0    | STATE    | atomic: 0 idle, 1 requested, 2 taken, 3 done                                    |
| 1    | FILE     | file id: the index of the file in `manifest.json`'s `files` array               |
| 2, 3 | OFF      | file offset, low then high 32 bits                                              |
| 4, 5 | DST      | destination: byte address in the shared memory, low then high 32 bits           |
| 6    | LEN      | bytes wanted, 0 to 2^31 - 1                                                     |
| 7    | RESULT   | bytes read (fewer at end of file, 0 past it) or -5 (I/O), -9 (bad file), -22 (invalid) |
| 8    | FLAGS    | bit 0: no read-ahead for this read                                              |

```
engine thread                                   IO worker
-------------                                   ---------
write FILE, OFF, DST, LEN, FLAGS
atomic store STATE = 1
atomic add DOORBELL, notify DOORBELL  ───────►  wakes (waitAsync on DOORBELL)
                                                CAS STATE 1 → 2 (takes it)
wait on STATE while it is not 3                 fetch / copy bytes to DST
                                                write RESULT
                                     ◄───────   atomic store STATE = 3, notify STATE
read RESULT
atomic store STATE = 0
```

The IO worker reads DOORBELL *before* scanning the slots and waits for it to change from that value, so a request
made during a scan is never missed. Requests are served concurrently: a slow read does not hold up the others.

### Hint ring

Each entry is 8 words: SEQ, FILE, OFF low, OFF high, LEN_FLAGS, then 3 reserved. LEN_FLAGS holds the length in its
low 30 bits; bit 30 marks a *speculative* hint, which might not be read and is fetched at low priority after
announced reads.

Producers (any engine thread):

1. `i = atomic add(HINT_HEAD, 1)`; the entry is `i mod HINT_CAP`.
2. Atomic store SEQ = `~(i + 1)`: "being written".
3. Write FILE, OFF and LEN_FLAGS.
4. Atomic store SEQ = `i + 1`: published.
5. Bump and notify DOORBELL.

The IO worker consumes entries from HINT_TAIL in order. For entry `t` it expects SEQ = `t + 1`:

- **SEQ matches:** it reads the fields, then checks that SEQ has not changed meanwhile (if it has, the entry was
  overwritten and is skipped).
- **SEQ is the published value of a later lap** (it differs from `t + 1` by a positive multiple of HINT_CAP):
  producers wrapped around and overwrote this hint, so it is skipped.
- **Anything else** (an earlier lap, or the "being written" marker): the producer has not finished. The IO worker
  stops and waits for the doorbell.

The "being written" value `~(i + 1)` can never equal a published value for the same entry, because
`2 * entry + 3` is odd and HINT_CAP is even. If producers get more than HINT_CAP ahead of HINT_TAIL, the IO worker
jumps to `HINT_HEAD - HINT_CAP`. Entries are never cleared. Hints are advisory: when two producers race for the same
entry a lap apart, the result costs at most one useless fetch, and the IO worker validates the file id and range.

## Command ring

```
header  16 words
data    CAP bytes (a power of two, at least 256)
```

| Header word | Name             | Written by                    |
| ----------- | ---------------- | ----------------------------- |
| 0           | MAGIC            | `0x43475052` ("RPGC")         |
| 1           | CAP              | init                          |
| 2           | WRITE            | producer, atomic + notify     |
| 3           | READ             | consumer, atomic + notify     |
| 4           | FRAMES_SUBMITTED | producer, atomic add          |
| 5           | FRAMES_DONE      | consumer, atomic add + notify |

A record is `[u32 op][u32 payload bytes][payload]`, padded to a multiple of 8 bytes. Positions are
`WRITE mod CAP` and `READ mod CAP`, and the ring holds `WRITE - READ` bytes. A record never wraps. When it does not fit
before the end of the data area, the producer first writes an `OP_PAD` (0) record covering the rest; the consumer
skips it. A record may be at most CAP / 2 bytes.

The producer writes a record, then publishes it with an atomic store of WRITE and a notify. While the ring is full it
waits on READ. The consumer handles each record in place, then stores READ and notifies.

Opcodes: 0 `OP_PAD`, 1 `OP_FRAME_END`, 2 to 15 reserved, 16 and up for the application.

Frame pacing: the producer ends a frame with an `OP_FRAME_END` record, then adds 1 to FRAMES_SUBMITTED. The GPU
worker, on reaching `OP_FRAME_END`, waits for an animation frame, draws, and adds 1 to FRAMES_DONE. `beginFrame(n)`
waits on FRAMES_DONE while `FRAMES_SUBMITTED - FRAMES_DONE >= n`.

## Record rings

These carry fixed-size records (the input events, and the engine's own work queues), with one producer and one
consumer.

| Header word | Name         |                                                  |
| ----------- | ------------ | ------------------------------------------------ |
| 0           | MAGIC        | `0x52525052` ("RPRR")                            |
| 1           | CAP          | records, a power of two                          |
| 2           | RECORD_WORDS |                                                  |
| 3           | WRITE        | records committed (atomic add + notify)          |
| 4           | READ         | records consumed (atomic add + notify)           |
| 5           | DROPPED      | records the producer dropped because it was full |
| 6, 7        |              | reserved                                         |

Record `i` starts at word `8 + (i mod CAP) * RECORD_WORDS`.

### Input events

Input events use a record ring with 8-word records. The page writes them, never blocking: when the ring is full the
event is dropped and DROPPED counts it. Float fields hold float32 bit patterns.

| Word | Field  | Key events             | Pointer events                     | Wheel          | Resize             |
| ---- | ------ | ---------------------- | ---------------------------------- | -------------- | ------------------ |
| 0    | type   | 1 down, 2 up           | 3 down, 4 up, 5 move               | 6              | 7                  |
| 1    | code   | index in `KEY_CODES`   | button                             | 0              | 0                  |
| 2, 3 | x, y   |                        | position in CSS pixels             | position       | width, height      |
| 4, 5 | dx, dy |                        | movement                           | delta (pixels) | dx: device pixel ratio |
| 6    | mods   | shift 1, ctrl 2, alt 4, meta 8 | same, plus `buttons << 8`  | modifiers      |                    |
| 7    | time   | `performance.now()` of the page, ms (float32) |                    |                |                    |

Type 8 (blur) means the page lost focus: treat every key as released. `KEY_CODES` (in `layout.js`) lists
`KeyboardEvent.code` values. Its indices are part of the protocol, and the list only grows.

## Manifest

```json
{
  "format": "rangeplay-manifest@1",
  "name": "my-game",
  "version": "9f2c41d07a1b3e55",
  "blockSize": 4096,
  "dataPath": "data/",
  "files": [["levels/level1.pak", 52428800, "ab12…32 hex…"], ["…", 0, "…"]]
}
```

File ids are indices into `files`. The object for a file is `dataPath + hash[0..2] + "/" + hash`, resolved against
the manifest's URL. `hash` is the first 32 hex digits of the SHA-256 of the file's bytes. `version` changes whenever
any file changes. `name` names the persistent cache on the player's device.

## Boot set

```json
{ "format": "rangeplay-bootset@1", "files": [["path", [[start, endInclusive], ...]], ...] }
```

Files come in order of first touch. Paths missing from the current manifest are skipped, so a boot set recorded
against an older version still helps.
