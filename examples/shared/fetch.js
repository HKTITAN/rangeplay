// Build helpers for the examples: verified downloads and a small zip reader (Node's standard library only, so the
// examples also build where no unzip tool is installed, such as a hosting provider's build machine).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// Downloads `url` to `path` unless a file with the expected SHA-256 is already there. Returns the bytes.
export async function download(url, path, sha256) {
  try {
    const have = await readFile(path);
    if (createHash('sha256').update(have).digest('hex') === sha256) return have;
  } catch {}
  console.log('downloading ' + url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(url + ': SHA-256 ' + got + ', expected ' + sha256);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

// Returns { name: Buffer } for the entries of a zip archive whose names pass `want(name)`.
export function unzip(zip, want = () => true) {
  // end of central directory: the last "PK\x05\x06" record
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip central directory');
    // central directory entry: +10 method, +20 compressed size, +24 size, +28/30/32 name/extra/comment lengths,
    // +42 offset of the local header
    const method = zip.readUInt16LE(at + 10);
    const csize = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28), extraLen = zip.readUInt16LE(at + 30), commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !want(name)) continue;
    // the data follows the local header, whose name and extra fields can differ in length from the central copy
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + csize);
    if (method === 0) out[name] = Buffer.from(data);
    else if (method === 8) out[name] = inflateRawSync(data);
    else throw new Error(name + ': unsupported zip compression method ' + method);
    if (out[name].length !== size) throw new Error(name + ': size mismatch after extraction');
  }
  return out;
}
