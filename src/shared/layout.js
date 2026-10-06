// Shared-memory layouts used between engine threads and the runtime's workers.
//
// Every structure here is a block of little-endian 32-bit words inside one SharedArrayBuffer or one shared
// WebAssembly.Memory. Engine code compiled to wasm (C, C++, Rust) can read and write them directly: native/rangeplay.h
// declares the same numbers, and test/layout.test.js fails if the two disagree. docs/protocol.md describes the protocol.

export const LAYOUT_VERSION = 1;

export const IO_MAGIC = 0x594c5052;            // "RPLY"
export const COMMAND_RING_MAGIC = 0x43475052;  // "RPGC"
export const RECORD_RING_MAGIC = 0x52525052;   // "RPRR"

// ---- IO control block -------------------------------------------------------------------------------------------------
// header (IO_HEADER_WORDS words), then IO slots (IO_SLOT_WORDS each), then the hint ring (IO_HINT_WORDS per entry).

export const IO_MAGIC_W = 0;
export const IO_VERSION_W = 1;
export const IO_DOORBELL_W = 2;     // incremented after every request or hint; the IO worker waits on it
export const IO_SLOT_CAP_W = 3;     // number of slots
export const IO_SLOT_NEXT_W = 4;    // slots handed out so far (a thread claims one with Atomics.add)
export const IO_HINT_CAP_W = 5;     // hint ring entries, a power of two (0 = no hint ring)
export const IO_HINT_HEAD_W = 6;    // hints claimed by producers (monotonic, wraps at 2^32)
export const IO_HINT_TAIL_W = 7;    // hints consumed by the IO worker
export const IO_READY_W = 8;        // 0 until the IO worker has attached; then 1
export const IO_HEADER_WORDS = 16;

export const IO_SLOT_WORDS = 16;
export const SLOT_STATE = 0;        // SLOT_IDLE / SLOT_REQUESTED / SLOT_TAKEN / SLOT_DONE
export const SLOT_FILE = 1;         // file id: index into the manifest's file table
export const SLOT_OFF_LO = 2;       // file offset, low and high 32 bits
export const SLOT_OFF_HI = 3;
export const SLOT_DST_LO = 4;       // destination: byte address in the shared memory, low and high 32 bits
export const SLOT_DST_HI = 5;
export const SLOT_LEN = 6;          // bytes wanted (at most 2^31 - 1)
export const SLOT_RESULT = 7;       // bytes read (0 at end of file) or a negative error
export const SLOT_FLAGS = 8;        // READ_* flags

export const SLOT_IDLE = 0;
export const SLOT_REQUESTED = 1;
export const SLOT_TAKEN = 2;
export const SLOT_DONE = 3;

export const READ_NO_READAHEAD = 1;

export const IO_HINT_WORDS = 8;
export const HINT_SEQ = 0;          // hint i is published as i + 1, and holds ~(i + 1) while being written
export const HINT_FILE = 1;
export const HINT_OFF_LO = 2;
export const HINT_OFF_HI = 3;
export const HINT_LEN_FLAGS = 4;    // length, plus HINT_SPECULATIVE
export const HINT_SPECULATIVE = 0x40000000;
export const HINT_LEN_MASK = 0x3fffffff;

export const ERR_IO = -5;
export const ERR_BADF = -9;
export const ERR_INVAL = -22;

export function ioControlBytes(slots, hintCap) {
  return (IO_HEADER_WORDS + slots * IO_SLOT_WORDS + hintCap * IO_HINT_WORDS) * 4;
}

export function ioSlotWord(slot) {
  return IO_HEADER_WORDS + slot * IO_SLOT_WORDS;
}

export function ioHintWord(slots, entry) {
  return IO_HEADER_WORDS + slots * IO_SLOT_WORDS + entry * IO_HINT_WORDS;
}

export function initIoControl(buffer, byteOffset, slots, hintCap) {
  if (byteOffset % 8) throw new RangeError('the IO control block must be 8-byte aligned');
  if (!(slots > 0)) throw new RangeError('at least one IO slot is needed');
  if (hintCap && (!isPowerOfTwo(hintCap) || hintCap < 2)) throw new RangeError('the hint ring capacity must be 0 or a power of two, at least 2');
  const words = ioControlBytes(slots, hintCap) / 4;
  const a = new Int32Array(buffer, byteOffset, words);
  a.fill(0);
  a[IO_VERSION_W] = LAYOUT_VERSION;
  a[IO_SLOT_CAP_W] = slots;
  a[IO_HINT_CAP_W] = hintCap;
  Atomics.store(a, IO_MAGIC_W, IO_MAGIC);
  return byteOffset;
}

// ---- command ring (variable-size records, one producer, one consumer) --------------------------------------------------
// header (RING_HEADER_WORDS words), then `cap` bytes of records. A record is [u32 op][u32 payload bytes][payload],
// padded to 8 bytes. A record never wraps: when it does not fit before the end, an OP_PAD record fills the rest.

export const RING_MAGIC_W = 0;
export const RING_CAP_W = 1;
export const RING_WRITE_W = 2;            // bytes committed by the producer (monotonic, wraps at 2^32)
export const RING_READ_W = 3;             // bytes consumed
export const RING_FRAMES_SUBMITTED_W = 4; // OP_FRAME_END records committed
export const RING_FRAMES_DONE_W = 5;      // frames the GPU worker has finished
export const RING_HEADER_WORDS = 16;

export const OP_PAD = 0;
export const OP_FRAME_END = 1;
export const OP_USER = 16;                // first opcode free for applications

export const RECORD_HEADER_BYTES = 8;

export function commandRingBytes(cap) {
  return RING_HEADER_WORDS * 4 + cap;
}

// ---- record ring (fixed-size records, one producer, one consumer) ------------------------------------------------------

export const RR_MAGIC_W = 0;
export const RR_CAP_W = 1;                // records, a power of two
export const RR_RECORD_WORDS_W = 2;
export const RR_WRITE_W = 3;              // records committed (monotonic)
export const RR_READ_W = 4;               // records consumed
export const RR_DROPPED_W = 5;            // records the producer dropped because the ring was full
export const RR_HEADER_WORDS = 8;

export function recordRingBytes(cap, recordWords) {
  return (RR_HEADER_WORDS + cap * recordWords) * 4;
}

// ---- input events: a record ring of INPUT_WORDS-word records, written by the page, read by the engine -------------------

export const INPUT_WORDS = 8;
export const IN_TYPE = 0;
export const IN_CODE = 1;      // key: index into KEY_CODES (0 = unknown); pointer: button; resize: 0
export const IN_X = 2;         // float32: pointer x in CSS pixels / resize width
export const IN_Y = 3;         // float32: pointer y / resize height
export const IN_DX = 4;        // float32: movement / wheel delta x / resize: device pixel ratio
export const IN_DY = 5;        // float32: movement / wheel delta y
export const IN_MODS = 6;      // bit 0 shift, 1 ctrl, 2 alt, 3 meta; pointer events: buttons << 8
export const IN_TIME = 7;      // float32: event time in ms (performance.now() clock of the page)

export const EV_KEY_DOWN = 1;
export const EV_KEY_UP = 2;
export const EV_POINTER_DOWN = 3;
export const EV_POINTER_UP = 4;
export const EV_POINTER_MOVE = 5;
export const EV_WHEEL = 6;
export const EV_RESIZE = 7;
export const EV_BLUR = 8;      // the page lost focus: release every key

// KeyboardEvent.code values; an event carries the index (unknown codes: 0). Append only: indices are part of the protocol.
export const KEY_CODES = [
  '',
  'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyM',
  'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Enter', 'Escape', 'Tab', 'Backspace',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote',
  'Comma', 'Period', 'Slash', 'CapsLock', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
];

const keyIndex = new Map(KEY_CODES.map((c, i) => [c, i]));
export function keyCodeIndex(code) {
  return keyIndex.get(code) || 0;
}

export function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function alignUp(n, a) {
  return Math.ceil(n / a) * a;
}
