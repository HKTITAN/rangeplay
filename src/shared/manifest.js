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

export const MANIFEST_FORMAT = 'rangeplay-manifest@1';
const HASH_RE = /^[0-9a-f]{32}$/;

export function objectPath(hash) {
  return hash.slice(0, 2) + '/' + hash;
}

export class FileTable {
  constructor(json, manifestUrl) {
    if (!json || json.format !== MANIFEST_FORMAT) throw new Error('not a ' + MANIFEST_FORMAT + ' manifest');
    const bs = json.blockSize ?? 4096;
    if (!Number.isInteger(bs) || bs < 512 || (bs & (bs - 1))) throw new Error('blockSize must be a power of two, at least 512');
    if (!Array.isArray(json.files)) throw new Error('manifest has no file list');
    this.json = json;
    this.name = String(json.name || 'default');
    this.version = String(json.version || '');
    this.blockSize = bs;
    this.count = json.files.length;
    this.paths = new Array(this.count);
    this.sizes = new Float64Array(this.count);
    this.hashes = new Array(this.count);
    this.index = new Map();
    json.files.forEach(([path, size, hash], id) => {
      if (typeof path !== 'string' || !Number.isSafeInteger(size) || size < 0 || !HASH_RE.test(hash)) {
        throw new Error('bad manifest entry ' + id + ': ' + JSON.stringify([path, size, hash]));
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

  valid(id) {
    return Number.isInteger(id) && id >= 0 && id < this.count;
  }

  path(id) {
    return this.paths[id];
  }

  size(id) {
    return this.sizes[id];
  }

  hash(id) {
    return this.hashes[id];
  }

  url(id) {
    return this.dataBase + objectPath(this.hashes[id]);
  }

  blocks(id) {
    return Math.ceil(this.sizes[id] / this.blockSize);
  }

  blockLen(id, block) {
    return Math.min(this.blockSize, this.sizes[id] - block * this.blockSize);
  }

  // 64-bit identity of the content (first 16 hex digits of the hash) as [lo, hi]: keys the persistent store, so cached
  // blocks survive a manifest update as long as the file's bytes did not change.
  contentKey(id) {
    const h = this.hashes[id];
    return [parseInt(h.slice(8, 16), 16) >>> 0, parseInt(h.slice(0, 8), 16) >>> 0];
  }

  totalBytes() {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.sizes[i];
    return n;
  }
}

export function parseManifest(json, manifestUrl) {
  return new FileTable(json, manifestUrl);
}
