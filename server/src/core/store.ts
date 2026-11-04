/**
 * Every distinct tree object a history run has read, once each, in typed arrays.
 *
 * A tree is an id (assigned the first time its oid is seen, as a root or as a subfolder of a
 * tree already read) and, once read, a run of entries: a name id, a mode and a ref. For a
 * subfolder the ref is that folder's tree id, so two snapshots share a folder exactly when they
 * hold the same id; for a file it is the first 52 bits of the blob oid, enough to tell versions
 * of one path apart. Entries are kept sorted by name (a folder's name with a trailing slash), so
 * two versions of a folder diff in one merge pass.
 *
 * Linux, 65 snapshots: about 100,000 distinct trees and 2.5M entries, 13 bytes each.
 */

import { hex } from './sha1';

export const MODE = { file: 0, exec: 1, link: 2, tree: 3, module: 4 } as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

export type Entry = { name: string; mode: Mode; oid: string };

/** Paths whose blob oid is kept whole, to read the file later. */
const KEEP_OID = new Set(['CODEOWNERS']);

export class TreeStore {
  /** Tree oids by id. */
  readonly oids: string[] = [];
  private ids = new Map<string, number>();
  private start = new Int32Array(1024);
  /** Entries of each tree, -1 until read. */
  private size = new Int32Array(1024).fill(-1);
  /** Entries anywhere below each tree, -1 until known (every tree below read). */
  private below = new Int32Array(1024).fill(-1);

  private nameOf = new Uint32Array(1 << 16);
  private modeOf = new Uint8Array(1 << 16);
  private refOf = new Float64Array(1 << 16);
  private used = 0;

  readonly names: string[] = [];
  private nameIds = new Map<string, number>();
  /**
   * Name ids by a name's UTF-8 bytes (addRaw), so a tree read from a pack names its entries
   * without making a string for each: open addressing, FNV-1a; each slot holds id + 1 and where
   * the name's bytes are kept.
   */
  private slotId = new Int32Array(1 << 12);
  private slotAt = new Int32Array(1 << 12);
  private slotLen = new Int32Array(1 << 12);
  private slotsUsed = 0;
  private nameBytes = new Uint8Array(1 << 16);
  private nameBytesUsed = 0;
  /** Whole blob oids of the few files read later (CODEOWNERS), by `tree:index`. */
  private kept = new Map<string, string>();

  /** Entries stored, across all trees. */
  get entries(): number {
    return this.used;
  }

  get trees(): number {
    return this.oids.length;
  }

  /** The id of the tree with this oid, assigned on first sight. */
  id(oid: string): number {
    let t = this.ids.get(oid);
    if (t !== undefined) return t;
    t = this.oids.length;
    this.oids.push(oid);
    this.ids.set(oid, t);
    if (t === this.size.length) {
      const n = t * 2;
      this.start = grow(this.start, n, 0);
      this.size = grow(this.size, n, -1);
      this.below = grow(this.below, n, -1);
    }
    return t;
  }

  has(oid: string): boolean {
    const t = this.ids.get(oid);
    return t !== undefined && this.size[t]! >= 0;
  }

  loaded(t: number): boolean {
    return this.size[t]! >= 0;
  }

  /** Stores tree t's entries (once; a second call is ignored). */
  add(t: number, entries: readonly Entry[]): void {
    if (this.size[t]! >= 0) return;
    const keyed = entries.map((e) => ({ e, key: e.mode === MODE.tree ? `${e.name}/` : e.name }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const n = keyed.length;
    if (this.used + n > this.nameOf.length) {
      let cap = this.nameOf.length;
      while (cap < this.used + n) cap *= 2;
      this.nameOf = grow(this.nameOf, cap, 0);
      this.modeOf = grow(this.modeOf, cap, 0);
      this.refOf = grow(this.refOf, cap, 0);
    }
    const at = this.used;
    for (let i = 0; i < n; i++) {
      const { e } = keyed[i]!;
      this.nameOf[at + i] = this.nameId(e.name);
      this.modeOf[at + i] = e.mode;
      this.refOf[at + i] = e.mode === MODE.tree ? this.id(e.oid) : blobKey(e.oid);
      if (KEEP_OID.has(e.name)) this.kept.set(`${t}:${i}`, e.oid);
    }
    this.used += n;
    this.start[t] = at;
    this.size[t] = n;
  }

  /**
   * Stores tree t's entries from a git tree object's bytes (`<mode> <name>\0<oid>` each), as
   * `add` would. git keeps a tree's entries in the store's order (a folder's name with a slash)
   * by bytes; a tree with a name past ASCII goes through `add`, whose sort is the store's.
   */
  addRaw(t: number, data: Uint8Array): void {
    if (this.size[t]! >= 0) return;
    const most = Math.ceil(data.length / 22) + 1;
    if (this.used + most > this.nameOf.length) {
      let cap = this.nameOf.length;
      while (cap < this.used + most) cap *= 2;
      this.nameOf = grow(this.nameOf, cap, 0);
      this.modeOf = grow(this.modeOf, cap, 0);
      this.refOf = grow(this.refOf, cap, 0);
    }
    const at = this.used;
    let n = 0;
    for (let p = 0; p < data.length;) {
      let sp = p;
      while (sp < data.length && data[sp] !== 0x20) sp++;
      let nul = sp + 1;
      let ascii = true;
      while (nul < data.length && data[nul] !== 0) {
        if (data[nul]! > 0x7f) ascii = false;
        nul++;
      }
      const mode = rawMode(data, p, sp);
      if (!ascii || mode < 0 || nul + 21 > data.length) {
        if (mode === -1 || nul + 21 > data.length) throw new Error('bad tree');
        this.add(t, rawEntries(data));
        return;
      }
      const i = at + n++;
      const name = this.nameIdBytes(data, sp + 1, nul);
      this.nameOf[i] = name;
      this.modeOf[i] = mode;
      const o = nul + 1;
      if (mode === MODE.tree) this.refOf[i] = this.id(hex(data, o, 20));
      else {
        let key = 0;
        for (let k = 0; k < 6; k++) key = key * 256 + data[o + k]!;
        this.refOf[i] = key * 16 + (data[o + 6]! >> 4);
        if (KEEP_OID.has(this.names[name]!)) this.kept.set(`${t}:${n - 1}`, hex(data, o, 20));
      }
      p = o + 20;
    }
    this.used += n;
    this.start[t] = at;
    this.size[t] = n;
  }

  private nameIdBytes(b: Uint8Array, from: number, to: number): number {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
    const len = to - from;
    const mask = this.slotId.length - 1;
    for (let s = h & mask; ; s = (s + 1) & mask) {
      const id = this.slotId[s]! - 1;
      if (id < 0) {
        let name = '';
        for (let i = from; i < to; i++) name += String.fromCharCode(b[i]!);
        const found = this.nameId(name);
        if (this.nameBytesUsed + len > this.nameBytes.length) {
          this.nameBytes = grow(this.nameBytes, Math.max(this.nameBytes.length * 2, len * 2), 0);
        }
        this.nameBytes.set(b.subarray(from, to), this.nameBytesUsed);
        this.slotId[s] = found + 1;
        this.slotAt[s] = this.nameBytesUsed;
        this.slotLen[s] = len;
        this.nameBytesUsed += len;
        if (++this.slotsUsed * 2 > this.slotId.length) this.rehash();
        return found;
      }
      if (this.slotLen[s] !== len) continue;
      const at = this.slotAt[s]!;
      let same = true;
      for (let i = 0; i < len; i++) {
        if (this.nameBytes[at + i] !== b[from + i]) {
          same = false;
          break;
        }
      }
      if (same) return id;
    }
  }

  private rehash(): void {
    const { slotId, slotAt, slotLen } = this;
    const size = slotId.length * 2;
    this.slotId = new Int32Array(size);
    this.slotAt = new Int32Array(size);
    this.slotLen = new Int32Array(size);
    const mask = size - 1;
    const b = this.nameBytes;
    for (let s = 0; s < slotId.length; s++) {
      if (slotId[s] === 0) continue;
      let h = 0x811c9dc5;
      for (let i = slotAt[s]!, end = i + slotLen[s]!; i < end; i++) {
        h = Math.imul(h ^ b[i]!, 0x01000193);
      }
      let t = h & mask;
      while (this.slotId[t] !== 0) t = (t + 1) & mask;
      this.slotId[t] = slotId[s]!;
      this.slotAt[t] = slotAt[s]!;
      this.slotLen[t] = slotLen[s]!;
    }
  }

  private nameId(name: string): number {
    let id = this.nameIds.get(name);
    if (id === undefined) {
      id = this.names.length;
      this.names.push(name);
      this.nameIds.set(name, id);
    }
    return id;
  }

  /** Entries of tree t (-1 before it is read). */
  length(t: number): number {
    return this.size[t]!;
  }

  name(t: number, i: number): string {
    return this.names[this.nameOf[this.start[t]! + i]!]!;
  }

  mode(t: number, i: number): Mode {
    return this.modeOf[this.start[t]! + i]! as Mode;
  }

  isTree(t: number, i: number): boolean {
    return this.modeOf[this.start[t]! + i] === MODE.tree;
  }

  /** A subfolder's tree id, or a file's oid key: equal refs, equal contents. */
  ref(t: number, i: number): number {
    return this.refOf[this.start[t]! + i]!;
  }

  /** The sort key the entries are in: the name, with a slash for a folder. */
  key(t: number, i: number): string {
    const name = this.name(t, i);
    return this.isTree(t, i) ? `${name}/` : name;
  }

  /** Index of the entry with this name and kind, or -1. */
  find(t: number, name: string, tree: boolean): number {
    const key = tree ? `${name}/` : name;
    let lo = 0;
    let hi = this.size[t]! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const k = this.key(t, mid);
      if (k === key) return mid;
      if (k < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** The whole oid of a kept file entry (CODEOWNERS), or null. */
  keptOid(t: number, i: number): string | null {
    return this.kept.get(`${t}:${i}`) ?? null;
  }

  /** Whether t and every tree below it are read. */
  complete(t: number): boolean {
    return this.count(t) >= 0;
  }

  /** Entries anywhere below t, or -1 while some tree below is unread. */
  count(t: number): number {
    const known = this.below[t]!;
    if (known >= 0) return known;
    const n = this.size[t]!;
    if (n < 0) return -1;
    let total = n;
    for (let i = 0; i < n; i++) {
      if (!this.isTree(t, i)) continue;
      const c = this.count(this.ref(t, i));
      if (c < 0) return -1;
      total += c;
    }
    this.below[t] = total;
    return total;
  }

  /** Bytes held by the store's arrays (strings and maps aside), for measurement. */
  get bytes(): number {
    return (
      this.nameOf.byteLength +
      this.modeOf.byteLength +
      this.refOf.byteLength +
      this.start.byteLength * 3
    );
  }
}

/** A tree entry's mode from its octal text in `b[from..to]`, or -1. */
function rawMode(b: Uint8Array, from: number, to: number): Mode | -1 {
  const n = to - from;
  if (n === 5) return b[from] === 0x34 ? MODE.tree : -1; // 40000
  if (n !== 6) return -1;
  const c1 = b[from + 1]!;
  const c3 = b[from + 3]!;
  const c5 = b[from + 5]!;
  if (b[from] !== 0x31) return -1;
  if (c1 === 0x30) return c3 === 0x37 && c5 === 0x35 ? MODE.exec : MODE.file; // 100755, 100644
  if (c1 === 0x32) return MODE.link; // 120000
  if (c1 === 0x36) return MODE.module; // 160000
  return -1;
}

/** A git tree object's entries, decoded (names as UTF-8). */
export function rawEntries(data: Uint8Array): Entry[] {
  const out: Entry[] = [];
  const utf8 = new TextDecoder();
  for (let p = 0; p < data.length;) {
    let sp = p;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    let nul = sp + 1;
    while (nul < data.length && data[nul] !== 0) nul++;
    const mode = rawMode(data, p, sp);
    if (mode === -1 || nul + 21 > data.length) throw new Error('bad tree');
    out.push({ name: utf8.decode(data.subarray(sp + 1, nul)), mode, oid: hex(data, nul + 1, 20) });
    p = nul + 21;
  }
  return out;
}

/** The first 52 bits of an oid, exact in a double. */
export function blobKey(oid: string): number {
  return parseInt(oid.slice(0, 13), 16);
}

function grow<A extends Int32Array | Uint32Array | Uint8Array | Float64Array>(
  a: A,
  n: number,
  fill: number,
): A {
  const b = new (a.constructor as new (n: number) => A)(n);
  b.set(a);
  if (fill !== 0) b.fill(fill, a.length);
  return b;
}
