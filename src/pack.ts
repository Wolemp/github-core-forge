// Packfiles: reading (v2/v3, OFS and REF deltas, thin packs) and writing (whole objects, deflated
// once and cached on the object so a hot clone is a concatenation).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { putObject, type GitObject, type ObjectStore, type ObjectType } from './gitObjects.ts';

const TYPE_CODE: Record<string, ObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};
const CODE_OF: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export class PackError extends Error {}

interface RawEntry {
  offset: number;
  kind: ObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset: number;
  baseSha: string;
}

function readVarintSize(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = pos;
  for (;;) {
    if (next >= buf.length) throw new PackError('delta header is truncated');
    const byte = buf[next];
    next += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readVarintSize(delta, 0);
  if (src.value !== base.length) throw new PackError('delta base size mismatch');
  const dst = readVarintSize(delta, src.next);
  const out = Buffer.allocUnsafe(dst.value);
  let pos = dst.next;
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] * 2 ** 24;
      if (op & 0x10) size |= delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > out.length) throw new PackError('delta copy is out of range');
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op !== 0) {
      if (pos + op > delta.length || written + op > out.length) throw new PackError('delta insert is out of range');
      delta.copy(out, written, pos, pos + op);
      pos += op;
      written += op;
    } else {
      throw new PackError('delta opcode 0 is reserved');
    }
  }
  if (written !== out.length) throw new PackError('delta result size mismatch');
  return out;
}

/**
 * Read a whole pack into `store`; thin-pack bases come from `store` too. Returns the new object ids
 * (those that were not already stored). Throws PackError on any damage.
 */
export function readPack(pack: Buffer, store: ObjectStore): string[] {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new PackError('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const body = pack.subarray(0, pack.length - 20);
  const checksum = createHash('sha1').update(body).digest();
  if (!checksum.equals(pack.subarray(pack.length - 20))) throw new PackError('pack checksum mismatch');

  const entries: RawEntry[] = [];
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const offset = pos;
    let byte = body[pos++];
    if (byte === undefined) throw new PackError('pack is truncated');
    const code = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = body[pos++];
      if (byte === undefined) throw new PackError('pack is truncated');
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const kind = TYPE_CODE[code];
    if (kind === undefined) throw new PackError(`bad object type ${code}`);
    let baseOffset = -1;
    let baseSha = '';
    if (kind === 'ofs-delta') {
      byte = body[pos++];
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        byte = body[pos++];
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = offset - rel;
    } else if (kind === 'ref-delta') {
      baseSha = body.toString('hex', pos, pos + 20);
      pos += 20;
    }
    let inflated: Buffer;
    let consumed: number;
    try {
      const result = inflateSync(body.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      inflated = result.buffer;
      consumed = result.engine.bytesWritten;
    } catch {
      throw new PackError('object data does not inflate');
    }
    if (inflated.length !== size) throw new PackError('object size mismatch');
    pos += consumed;
    entries.push({ offset, kind, data: inflated, baseOffset, baseSha });
  }

  const byOffset = new Map<number, GitObject>();
  const created: string[] = [];
  const add = (object: GitObject): string => {
    const had = store.size;
    const sha = putObject(store, object.type, object.data);
    if (store.size > had) created.push(sha);
    return sha;
  };
  const pending: RawEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'ofs-delta' || entry.kind === 'ref-delta') pending.push(entry);
    else {
      const object = { type: entry.kind, data: entry.data };
      byOffset.set(entry.offset, object);
      add(object);
    }
  }
  let remaining = pending;
  while (remaining.length > 0) {
    const next: RawEntry[] = [];
    for (const entry of remaining) {
      let base: GitObject | undefined;
      if (entry.kind === 'ofs-delta') base = byOffset.get(entry.baseOffset);
      else base = store.get(entry.baseSha);
      if (base === undefined) {
        next.push(entry);
        continue;
      }
      const object = { type: base.type, data: applyDelta(base.data, entry.data) };
      byOffset.set(entry.offset, object);
      add(object);
    }
    if (next.length === remaining.length) throw new PackError('a delta names a base that is not in the pack');
    remaining = next;
  }
  return created;
}

function entryHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (code << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

const packedCache = new WeakMap<GitObject, Buffer>();

function packedEntry(object: GitObject): Buffer {
  let entry = packedCache.get(object);
  if (entry === undefined) {
    entry = Buffer.concat([entryHeader(CODE_OF[object.type], object.data.length), deflateSync(object.data, { level: 1 })]);
    packedCache.set(object, entry);
  }
  return entry;
}

/** A complete packfile (header, whole objects, trailer) for the given ids. */
export function writePack(store: ObjectStore, ids: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  const parts: Buffer[] = [header];
  for (const id of ids) {
    const object = store.get(id);
    if (object !== undefined) parts.push(packedEntry(object));
  }
  header.writeUInt32BE(parts.length - 1, 8);
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
