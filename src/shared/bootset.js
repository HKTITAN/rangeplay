// Boot sets: the byte ranges an engine reads while it starts, recorded once and replayed on every later load so they
// download in parallel with engine start-up instead of one blocking read at a time.
//
// { "format": "rangeplay-bootset@1", "files": [["path", [[start, endInclusive], ...]], ...] }
// Files are listed in order of first touch; each file's ranges are sorted and merged.

export const BOOTSET_FORMAT = 'rangeplay-bootset@1';

// Sorts ranges and merges those closer than `gap` bytes (fetching the gap is cheaper than another request).
export function mergeRanges(ranges, gap = 0) {
  const sorted = ranges.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1 + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function bootsetBytes(set) {
  let n = 0;
  for (const [, ranges] of set.files) for (const [a, b] of ranges) n += b - a + 1;
  return n;
}

// Combines several recordings: files ordered by their average position across recordings, ranges unioned.
export function mergeBootsets(sets, { gap = 0 } = {}) {
  const info = new Map();
  for (const set of sets) {
    if (!set || set.format !== BOOTSET_FORMAT) throw new Error('not a ' + BOOTSET_FORMAT + ' file');
    const n = set.files.length || 1;
    set.files.forEach(([path, ranges], i) => {
      let e = info.get(path);
      if (!e) info.set(path, (e = { rank: 0, seen: 0, ranges: [] }));
      e.rank += i / n;
      e.seen++;
      e.ranges.push(...ranges);
    });
  }
  const files = [...info]
    .sort((a, b) => a[1].rank / a[1].seen - b[1].rank / b[1].seen)
    .map(([path, e]) => [path, mergeRanges(e.ranges, gap)]);
  return { format: BOOTSET_FORMAT, files };
}

export function validateBootset(set) {
  if (!set || set.format !== BOOTSET_FORMAT || !Array.isArray(set.files)) throw new Error('not a ' + BOOTSET_FORMAT + ' file');
  for (const entry of set.files) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) throw new Error('bad boot set entry');
    for (const r of entry[1]) {
      if (!Array.isArray(r) || !Number.isSafeInteger(r[0]) || !Number.isSafeInteger(r[1]) || r[0] < 0 || r[1] < r[0]) {
        throw new Error('bad range in boot set entry ' + entry[0]);
      }
    }
  }
  return set;
}
