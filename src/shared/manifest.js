// The manifest: the file table every thread agrees on. File ids are indices into it.
//
// {
//   "format": "rangeplay-manifest@1",
//   "name": "tile-world",                 // names the browser-side store
//   "version": "9f2c...",                 // hash of the file list: changes whenever any file changes
//   "blockSize": 4096,                    // cache granularity
//   "dataPath": "data/",                  // where objects live, relative to the manifest
//   "files": [["world.json", 1234, "<32 hex: sha-256 prefix of the content>"], ...]
// }
//
// Objects are content-addressed (data/<first 2 hex>/<hash>), so a URL's bytes never change: CDNs and browsers can keep
// them forever, identical files are stored once, and a new version only invalidates the files that changed.
//
// Format 2 adds packs: small files stored back to back in one object, so that one Range request fetches many of them.
//   "packs": [["<32 hex: hash of the pack>", size], ...],
//   "files": [["shaders/water.wgsl", 2210, "<hash of the file>", <pack index>, <offset in the pack>], ...]
// A file entry with five fields lives in a pack; one with three has an object of its own. `rangeplay pack` writes
// format 1 whenever nothing is packed, so older runtimes keep reading those manifests.
//
// Inside the runtime, the engine's file ids index `files`. The IO worker and the block stores work on *store ids*:
// a file that has its own object keeps its id; pack i is store id `count + i`. A packed file has no store id of its
// own: locate it with sid() and base().

export const MANIFEST_FORMAT = 'rangeplay-manifest@1';
export const MANIFEST_FORMAT_PACKS = 'rangeplay-manifest@2';
const HASH_RE = /^[0-9a-f]{32}$/;

export function objectPath(hash) {
  return hash.slice(0, 2) + '/' + hash;
}

export class FileTable {
  constructor(json, manifestUrl) {
    const format = json?.format;
    if (format !== MANIFEST_FORMAT && format !== MANIFEST_FORMAT_PACKS) throw new Error('not a rangeplay manifest (format ' + JSON.stringify(format) + ')');
    const bs = json.blockSize ?? 4096;
    if (!Number.isInteger(bs) || bs < 512 || (bs & (bs - 1))) throw new Error('blockSize must be a power of two, at least 512');
    if (!Array.isArray(json.files)) throw new Error('manifest has no file list');
    const packs = format === MANIFEST_FORMAT_PACKS ? json.packs ?? [] : [];
    if (!Array.isArray(packs)) throw new Error('manifest packs must be a list');
    this.json = json;
    this.name = String(json.name || 'default');
    this.version = String(json.version || '');
    this.blockSize = bs;
    this.count = json.files.length;
    this.packCount = packs.length;
    this.objects = this.count + this.packCount;   // store ids: files, then packs
    this.paths = new Array(this.count);
    this.sizes = new Float64Array(this.objects);
    this.hashes = new Array(this.objects);
    this.packOf = new Int32Array(this.count).fill(-1);
    this.packBase = new Float64Array(this.count);
    this.index = new Map();
    packs.forEach((entry, i) => {
      const [hash, size] = Array.isArray(entry) ? entry : [];
      if (!HASH_RE.test(hash) || !Number.isSafeInteger(size) || size <= 0) throw new Error('bad pack ' + i + ': ' + JSON.stringify(entry));
      this.sizes[this.count + i] = size;
      this.hashes[this.count + i] = hash;
    });
    json.files.forEach((entry, id) => {
      const [path, size, hash, pack, offset] = Array.isArray(entry) ? entry : [];
      if (typeof path !== 'string' || !Number.isSafeInteger(size) || size < 0 || !HASH_RE.test(hash)) {
        throw new Error('bad manifest entry ' + id + ': ' + JSON.stringify(entry));
      }
      if (entry.length > 3) {
        if (!Number.isInteger(pack) || pack < 0 || pack >= this.packCount || !Number.isSafeInteger(offset) || offset < 0 ||
            offset + size > this.sizes[this.count + pack]) {
          throw new Error('bad pack location in manifest entry ' + id + ': ' + JSON.stringify(entry));
        }
        this.packOf[id] = pack;
        this.packBase[id] = offset;
      }
      if (this.index.has(path)) throw new Error('duplicate path in manifest: ' + path);
      this.paths[id] = path;
      this.sizes[id] = size;
      this.hashes[id] = hash;
      this.index.set(path, id);
    });
    this.dataBase = manifestUrl ? new URL(json.dataPath ?? 'data/', manifestUrl).href : (json.dataPath ?? 'data/');
  }

  id(path) {
    const id = this.index.get(path);
    return id === undefined ? -1 : id;
  }

  // An engine file id (store ids of packs are not valid file ids).
  valid(id) {
    return Number.isInteger(id) && id >= 0 && id < this.count;
  }

  packed(id) {
    return id < this.count && this.packOf[id] >= 0;
  }

  isPack(sid) {
    return sid >= this.count;
  }

  // Where a file's bytes live: store id sid(id), starting at byte base(id) of it.
  sid(id) {
    const p = this.packOf[id];
    return p >= 0 ? this.count + p : id;
  }

  base(id) {
    return this.packBase[id];
  }

  // The rest take store ids. For a file id they describe the file itself.
  path(sid) {
    return sid < this.count ? this.paths[sid] : 'pack ' + (sid - this.count) + ' (' + this.hashes[sid] + ')';
  }

  size(sid) {
    return this.sizes[sid];
  }

  hash(sid) {
    return this.hashes[sid];
  }

  // The object holding the store id's bytes. A packed file has none of its own (its bytes are at url(sid(id))).
  url(sid) {
    return this.packed(sid) ? null : this.dataBase + objectPath(this.hashes[sid]);
  }

  blocks(sid) {
    return Math.ceil(this.sizes[sid] / this.blockSize);
  }

  blockLen(sid, block) {
    return Math.min(this.blockSize, this.sizes[sid] - block * this.blockSize);
  }

  // 64-bit identity of the content (first 16 hex digits of the hash) as [lo, hi]: keys the persistent store, so cached
  // blocks survive a manifest update as long as the object's bytes did not change.
  contentKey(sid) {
    const h = this.hashes[sid];
    return [parseInt(h.slice(8, 16), 16) >>> 0, parseInt(h.slice(0, 8), 16) >>> 0];
  }

  // The game's size: every file once, as the engine sees them.
  totalBytes() {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.sizes[i];
    return n;
  }

  // The objects a host serves for this manifest, each once: { hash, size, sid, pack (index or -1) }.
  objectList() {
    const seen = new Set(), out = [];
    for (let sid = 0; sid < this.objects; sid++) {
      if (this.packed(sid) || seen.has(this.hashes[sid])) continue;
      seen.add(this.hashes[sid]);
      out.push({ hash: this.hashes[sid], size: this.sizes[sid], sid, pack: sid < this.count ? -1 : sid - this.count });
    }
    return out;
  }

  // What downloading the whole game costs: the size of every object once.
  downloadBytes() {
    let n = 0;
    for (const o of this.objectList()) n += o.size;
    return n;
  }
}

export function parseManifest(json, manifestUrl) {
  return new FileTable(json, manifestUrl);
}
