/**
 * Reading many snapshot trees in one git fetch (smart HTTP, protocol v2), the primary tree reader.
 *
 * The browser asks the history Worker's `/v1/git/{owner}/{repo}/git-upload-pack` route, which
 * checks the request (`checkFetchRequest`: trees and commits only, never blobs) and streams
 * github.com's answer back untouched. The request wants the snapshot commits at depth 1 with
 * `filter blob:none`: GitHub sends every commit wanted and every tree below them, each distinct
 * object once, as a packfile. Supabase, 51 snapshots: 29k objects, 5.8 MiB; Linux, 65: 99k
 * objects, 47 MiB (GraphQL: 86 MB in 400 queries).
 *
 * `PackReader` takes the response as it streams in: pkt-lines, then the side band, then the
 * pack. Each object is inflated (inflate.ts), deltas resolved against their bases, named by its
 * SHA-1 (sha1.ts) and handed on as it comes: trees into the TreeStore, commits as tree and
 * parents. The compressed pack is kept, in segments, so that a delta's base that has left the
 * small cache of inflated objects can be inflated again; nothing else grows with the pack.
 */

import { InflateError, inflateAt } from './inflate';
import { gitOid, hex } from './sha1';
import { rawEntries, type TreeStore } from './store';

/** Wants one fetch may carry (the Worker refuses more). Snapshots are at most 65. */
export const MAX_WANTS = 256;
/** Bytes a fetch request may take: 256 wants are about 13 KB. */
export const MAX_REQUEST_BYTES = 64 * 1024;
export const UPLOAD_PACK_REQUEST = 'application/x-git-upload-pack-request';
export const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';

const enc = new TextEncoder();
const SHA = /^[0-9a-f]{40}$/;

/** One pkt-line holding `text` (a trailing newline included by the caller). */
export function pktLine(text: string): string {
  return (text.length + 4).toString(16).padStart(4, '0') + text;
}

/**
 * The v2 fetch request for these commits (or trees): each at depth 1, no blobs, no progress
 * chatter, deltas by offset, and `done` so the answer is the pack at once. ASCII throughout.
 */
export function fetchRequest(wants: readonly string[]): Uint8Array {
  return enc.encode(fetchRequestText(wants));
}

export function fetchRequestText(wants: readonly string[]): string {
  const lines = [
    pktLine('command=fetch\n'),
    pktLine('agent=repo-tree\n'),
    pktLine('object-format=sha1\n'),
    '0001',
    pktLine('no-progress\n'),
    pktLine('ofs-delta\n'),
    pktLine('deepen 1\n'),
    pktLine('filter blob:none\n'),
    ...[...new Set(wants)].map((w) => pktLine(`want ${w}\n`)),
    pktLine('done\n'),
    '0000',
  ];
  return lines.join('');
}

export type RequestCheck = { ok: true; wants: number } | { ok: false; reason: string };

/**
 * Whether a fetch request is one the Worker forwards: exactly `command=fetch`, capabilities
 * limited to an agent and sha1, and arguments limited to wants (1 to MAX_WANTS), `deepen 1`,
 * `filter blob:none`, `done` (all three required) and the harmless `no-progress`, `ofs-delta`
 * and `thin-pack`-free flags. Anything else that could pull blobs (another filter, no filter,
 * `have` negotiation, `include-tag`, `want-ref`, packfile-uris, a deeper or since/not deepen)
 * is refused.
 */
export function checkFetchRequest(body: Uint8Array): RequestCheck {
  const no = (reason: string): RequestCheck => ({ ok: false, reason });
  if (body.length > MAX_REQUEST_BYTES) return no('too large');
  const lines: (string | '0000' | '0001')[] = [];
  const dec = new TextDecoder();
  for (let at = 0; at < body.length;) {
    if (at + 4 > body.length) return no('bad pkt-line');
    const head = dec.decode(body.subarray(at, at + 4));
    if (!/^[0-9a-f]{4}$/.test(head)) return no('bad pkt-line');
    const n = parseInt(head, 16);
    if (n === 0 || n === 1) {
      lines.push(n === 0 ? '0000' : '0001');
      at += 4;
      continue;
    }
    if (n < 5 || at + n > body.length) return no('bad pkt-line');
    const text = dec.decode(body.subarray(at + 4, at + n));
    if (!/^[\x20-\x7e]*\n?$/.test(text)) return no('bad pkt-line');
    lines.push(text.endsWith('\n') ? text.slice(0, -1) : text);
    at += n;
  }
  if (lines[0] !== 'command=fetch') return no('not a fetch');
  const delim = lines.indexOf('0001');
  if (delim < 0 || lines[lines.length - 1] !== '0000') return no('bad pkt-line');
  for (const cap of lines.slice(1, delim)) {
    if (cap === 'object-format=sha1' || /^agent=[\x21-\x7e]{1,64}$/.test(cap)) continue;
    return no(`capability ${cap.slice(0, 40)}`);
  }
  const args = lines.slice(delim + 1, -1);
  let wants = 0;
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      if (!SHA.test(arg.slice(5))) return no('bad want');
      wants++;
      continue;
    }
    if (!['no-progress', 'ofs-delta', 'deepen 1', 'filter blob:none', 'done'].includes(arg)) {
      return no(`argument ${arg.slice(0, 40)}`);
    }
    if (seen.has(arg)) return no(`argument ${arg} twice`);
    seen.add(arg);
  }
  if (!seen.has('filter blob:none')) return no('no blob:none filter');
  if (!seen.has('deepen 1')) return no('not deepen 1');
  if (!seen.has('done')) return no('no done');
  if (wants === 0) return no('no wants');
  if (wants > MAX_WANTS) return no('too many wants');
  return { ok: true, wants };
}

export class PackError extends Error {}

/** Object types as a pack numbers them. */
const COMMIT = 1;
const TREE = 2;
const BLOB = 3;
const TAG = 4;
const OFS_DELTA = 6;
const REF_DELTA = 7;
const TYPE_NAME = ['', 'commit', 'tree', 'blob', 'tag'];

export type PackObject = {
  oid: string;
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Uint8Array;
};

export type PackReaderOptions = {
  /** Each object, once, as soon as it is read. */
  onObject: (o: PackObject) => void;
  /** Bytes of inflated objects kept for deltas to build on (others are inflated again). */
  cacheBytes?: number;
  /** Bytes of the compressed pack held per segment. */
  segmentBytes?: number;
};

/** What a whole read took. */
export type PackStats = {
  /** Response bytes, as received (pkt-line framing included). */
  bytes: number;
  objects: number;
  deltas: number;
  /** Delta bases no longer in the cache, inflated again. */
  reinflated: number;
  /** Bytes the kept pack segments hold. */
  held: number;
  /** Shallow commits the answer listed (the wants, at depth 1). */
  shallow: number;
};

/**
 * Reads a v2 fetch response as it arrives: `push` each chunk, then `end`. Throws PackError on
 * a malformed or failed answer: an ERR line, side band 3, a blob, a bad object or zlib stream.
 */
export class PackReader {
  readonly stats: PackStats = {
    bytes: 0,
    objects: 0,
    deltas: 0,
    reinflated: 0,
    held: 0,
    shallow: 0,
  };
  /** Objects the pack header announces (0 until read). */
  count = 0;
  private readonly opts: Required<PackReaderOptions>;

  // pkt-line framing.
  private head = '';
  private remaining = 0;
  private band = -1;
  private inPack = false;
  private line: Uint8Array[] = [];
  private finished = false;

  // The pack: segments of compressed bytes, objects never straddling two.
  private segs: Uint8Array[] = [];
  private cur = new Uint8Array(0);
  private fill = 0;
  /** Where the next unread object starts in `cur`, and its offset in the pack. */
  private at = 0;
  private packAt = 0;
  private headerRead = false;
  private retryAt = 0;

  // Objects read: pack offset, segment and position, type (resolved), by index.
  private offsets: number[] = [];
  private segOf: number[] = [];
  private posOf: number[] = [];
  private typeOf: number[] = [];
  private byOffset = new Map<number, number>();
  private byOid = new Map<string, number>();
  /**
   * Inflated objects kept for deltas, least recently used first out. The queue holds (index,
   * stamp) pairs; a pair whose stamp is no longer the entry's was used again since.
   */
  private cache = new Map<number, { data: Uint8Array; stamp: number }>();
  private cached = 0;
  private queue: number[] = [];
  private queueHead = 0;
  private stamp = 0;
  /** Ref deltas whose base had not come yet (git writes bases first; this is a fallback). */
  private pending: { index: number; base: string; delta: Uint8Array }[] = [];

  constructor(options: PackReaderOptions) {
    this.opts = { cacheBytes: 24 << 20, segmentBytes: 8 << 20, ...options };
  }

  /** Feeds the next chunk of the response body. */
  push(chunk: Uint8Array): void {
    this.stats.bytes += chunk.length;
    let i = 0;
    while (i < chunk.length) {
      if (this.finished) throw new PackError('data past the end');
      if (this.remaining === 0) {
        // A pkt-line header, maybe split across chunks.
        const take = Math.min(4 - this.head.length, chunk.length - i);
        for (let k = 0; k < take; k++) this.head += String.fromCharCode(chunk[i + k]!);
        i += take;
        if (this.head.length < 4) break;
        const head = this.head;
        this.head = '';
        if (!/^[0-9a-f]{4}$/.test(head)) throw new PackError('bad pkt-line');
        const n = parseInt(head, 16);
        if (n === 0) {
          // Flush: the end of the response.
          if (!this.inPack) throw new PackError('no packfile section');
          this.finished = true;
          continue;
        }
        if (n === 1 || n === 2) continue; // delimiter, response-end
        if (n < 5) throw new PackError('bad pkt-line');
        this.remaining = n - 4;
        this.band = this.inPack ? -2 : -1;
        continue;
      }
      if (this.band === -2) {
        // The first payload byte of a packfile pkt: its side band.
        this.band = chunk[i]!;
        i++;
        this.remaining--;
        if (this.band < 1 || this.band > 3) throw new PackError('bad side band');
        if (this.remaining === 0) this.band = -1;
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - i);
      const part = chunk.subarray(i, i + take);
      i += take;
      this.remaining -= take;
      if (this.band === 1) this.packBytes(part);
      else this.line.push(part.slice());
      if (this.remaining === 0) {
        if (this.band !== 1) this.endLine();
        this.band = -1;
      }
    }
  }

  /** The end of the body: everything must have arrived. */
  end(): PackStats {
    if (!this.finished) throw new PackError('truncated');
    this.parse(true);
    if (!this.headerRead || this.stats.objects < this.count) throw new PackError('truncated');
    for (const p of this.pending) {
      const base = this.byOid.get(p.base);
      if (base === undefined) throw new PackError('ref delta base missing');
      this.resolveDelta(p.index, base, p.delta);
    }
    this.pending = [];
    this.cache.clear();
    this.cached = 0;
    this.queue = [];
    this.stats.held = this.segs.reduce((n, s) => n + (s === this.cur ? this.fill : s.length), 0);
    return this.stats;
  }

  /** A whole pkt-line outside band 1: a section line or band 2/3. */
  private endLine(): void {
    const n = this.line.reduce((s, p) => s + p.length, 0);
    const all = new Uint8Array(n);
    let k = 0;
    for (const p of this.line) {
      all.set(p, k);
      k += p.length;
    }
    this.line = [];
    const text = new TextDecoder().decode(all).replace(/\n$/, '');
    if (this.band === 2) return; // progress
    if (this.band === 3) throw new PackError(`remote: ${text.slice(0, 200)}`);
    if (text.startsWith('ERR ')) throw new PackError(text.slice(0, 200));
    if (text === 'packfile') this.inPack = true;
    else if (text.startsWith('shallow ')) this.stats.shallow++;
  }

  private packBytes(part: Uint8Array): void {
    if (this.fill + part.length > this.cur.length) {
      // Start a new segment, carrying the unread object's bytes over.
      const carry = this.fill - this.at;
      const size = Math.max(this.opts.segmentBytes, 2 * (carry + part.length));
      const next = new Uint8Array(size);
      next.set(this.cur.subarray(this.at, this.fill));
      if (this.at > 0) this.segs[this.segs.length - 1] = this.cur.subarray(0, this.at);
      else if (this.segs.length > 0 && this.segs[this.segs.length - 1] === this.cur)
        this.segs.pop();
      this.segs.push(next);
      this.retryAt -= this.at;
      this.cur = next;
      this.fill = carry;
      this.at = 0;
    }
    this.cur.set(part, this.fill);
    this.fill += part.length;
    if (this.fill >= this.retryAt) this.parse(false);
  }

  /** Reads every whole object in the buffer. */
  private parse(complete: boolean): void {
    if (!this.headerRead) {
      if (this.fill - this.at < 12) {
        if (complete) throw new PackError('truncated');
        return;
      }
      const b = this.cur;
      const o = this.at;
      if (b[o] !== 0x50 || b[o + 1] !== 0x41 || b[o + 2] !== 0x43 || b[o + 3] !== 0x4b) {
        throw new PackError('not a pack');
      }
      const view = new DataView(b.buffer, b.byteOffset + o, 12);
      if (view.getUint32(4) !== 2 && view.getUint32(4) !== 3) throw new PackError('pack version');
      this.count = view.getUint32(8);
      this.headerRead = true;
      this.at += 12;
      this.packAt += 12;
    }
    while (this.stats.objects < this.count) {
      const start = this.at;
      const got = this.readObject(this.cur, start, this.fill, complete);
      if (!got) {
        // Wait for more: half again what is here, so a big object is not inflated over and
        // over, one chunk at a time.
        const have = this.fill - start;
        this.retryAt = this.fill + Math.max(16 * 1024, Math.min(have >> 1, 1 << 20));
        return;
      }
      const index = this.offsets.length;
      this.offsets.push(this.packAt);
      this.segOf.push(this.segs.length - 1);
      this.posOf.push(start);
      this.byOffset.set(this.packAt, index);
      this.typeOf.push(0);
      this.packAt += got.end - start;
      this.at = got.end;
      this.stats.objects++;
      if (got.type === OFS_DELTA || got.type === REF_DELTA) {
        this.stats.deltas++;
        let base: number | undefined;
        if (got.type === OFS_DELTA) {
          base = this.byOffset.get(this.offsets[index]! - got.baseOffset);
          if (base === undefined) throw new PackError('ofs delta base missing');
        } else {
          base = this.byOid.get(got.baseOid);
          if (base === undefined) {
            this.pending.push({ index, base: got.baseOid, delta: got.data });
            continue;
          }
        }
        this.resolveDelta(index, base, got.data);
      } else this.emit(index, got.type, got.data);
    }
    this.retryAt = Infinity;
  }

  private resolveDelta(index: number, base: number, delta: Uint8Array): void {
    const b = this.load(base);
    this.emit(index, this.typeOf[base]!, applyDelta(b, delta));
  }

  private emit(index: number, type: number, data: Uint8Array): void {
    if (type < COMMIT || type > TAG) throw new PackError('bad object type');
    this.typeOf[index] = type;
    const name = TYPE_NAME[type]!;
    const oid = gitOid(name, data);
    this.byOid.set(oid, index);
    this.keep(index, data);
    this.opts.onObject({ oid, type: name as PackObject['type'], data });
  }

  private keep(index: number, data: Uint8Array): void {
    if (data.length > this.opts.cacheBytes / 4) return;
    const entry = this.cache.get(index);
    if (entry) entry.stamp = ++this.stamp;
    else {
      this.cache.set(index, { data, stamp: ++this.stamp });
      this.cached += data.length;
    }
    this.queue.push(index, this.stamp);
    while (this.cached > this.opts.cacheBytes) {
      const oldest = this.queue[this.queueHead]!;
      const stamp = this.queue[this.queueHead + 1]!;
      this.queueHead += 2;
      const e = this.cache.get(oldest);
      if (e && e.stamp === stamp) {
        this.cache.delete(oldest);
        this.cached -= e.data.length;
      }
    }
    if (this.queueHead > 1 << 16 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
  }

  /** Object `index`'s inflated, resolved bytes: from the cache, or inflated again. */
  private load(index: number): Uint8Array {
    const hit = this.cache.get(index);
    if (hit) {
      this.keep(index, hit.data);
      return hit.data;
    }
    this.stats.reinflated++;
    const seg =
      this.segOf[index]! < this.segs.length - 1 ? this.segs[this.segOf[index]!]! : this.cur;
    const got = this.readObject(
      seg,
      this.posOf[index]!,
      seg === this.cur ? this.fill : seg.length,
      true,
    );
    if (!got) throw new PackError('truncated');
    let data = got.data;
    if (got.type === OFS_DELTA || got.type === REF_DELTA) {
      const base =
        got.type === OFS_DELTA
          ? this.byOffset.get(this.offsets[index]! - got.baseOffset)
          : this.byOid.get(got.baseOid);
      if (base === undefined) throw new PackError('delta base missing');
      data = applyDelta(this.load(base), data);
    }
    this.keep(index, data);
    return data;
  }

  /** One object at `b[start..]`: its header and inflated data, or null when more must come. */
  private readObject(
    b: Uint8Array,
    start: number,
    limit: number,
    complete: boolean,
  ): { type: number; data: Uint8Array; end: number; baseOffset: number; baseOid: string } | null {
    let p = start;
    const more = (): null => {
      if (complete) throw new PackError('truncated');
      return null;
    };
    if (p >= limit) return more();
    let c = b[p++]!;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      if (p >= limit) return more();
      c = b[p++]!;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    if (type === OFS_DELTA) {
      if (p >= limit) return more();
      c = b[p++]!;
      baseOffset = c & 0x7f;
      while (c & 0x80) {
        if (p >= limit) return more();
        c = b[p++]!;
        baseOffset = (baseOffset + 1) * 128 + (c & 0x7f);
      }
    } else if (type === REF_DELTA) {
      if (p + 20 > limit) return more();
      baseOid = hex(b, p, 20);
      p += 20;
    } else if (type === BLOB) {
      // blob:none was asked for; a blob means the filter was not applied.
      throw new PackError('blob in pack');
    } else if (type !== COMMIT && type !== TREE && type !== TAG) {
      throw new PackError('bad object type');
    }
    if (size > 1 << 28) throw new PackError('object too large');
    let got;
    try {
      got = inflateAt(b, p, limit, size, complete);
    } catch (error) {
      if (error instanceof InflateError) throw new PackError(`inflate: ${error.message}`);
      throw error;
    }
    if (!got) return null;
    return { type, data: got.out, end: got.end, baseOffset, baseOid };
  }
}

/** Applies a git delta to `base`. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  const varint = () => {
    let v = 0;
    let shift = 0;
    let c: number;
    do {
      if (p >= delta.length) throw new PackError('bad delta');
      c = delta[p++]!;
      v += (c & 0x7f) * 2 ** shift;
      shift += 7;
    } while (c & 0x80);
    return v;
  };
  if (varint() !== base.length) throw new PackError('delta base size');
  const size = varint();
  const out = new Uint8Array(size);
  let at = 0;
  while (p < delta.length) {
    const op = delta[p++]!;
    if (op & 0x80) {
      let off = 0;
      let n = 0;
      if (op & 1) off |= delta[p++]!;
      if (op & 2) off |= delta[p++]! << 8;
      if (op & 4) off |= delta[p++]! << 16;
      if (op & 8) off += delta[p++]! * 2 ** 24;
      if (op & 16) n |= delta[p++]!;
      if (op & 32) n |= delta[p++]! << 8;
      if (op & 64) n |= delta[p++]! << 16;
      if (n === 0) n = 0x10000;
      if (off + n > base.length || at + n > size) throw new PackError('bad delta copy');
      out.set(base.subarray(off, off + n), at);
      at += n;
    } else if (op) {
      if (p + op > delta.length || at + op > size) throw new PackError('bad delta insert');
      out.set(delta.subarray(p, p + op), at);
      p += op;
      at += op;
    } else throw new PackError('bad delta op');
  }
  if (at !== size) throw new PackError('delta result size');
  return out;
}

/** A binary tree object's entries: `<mode> <name>\0<20-byte oid>` each. */
export const parseTree = rawEntries;

/** A commit object's tree and parents. */
export function parseCommit(data: Uint8Array): { tree: string; parents: string[] } {
  // The header ends at the first blank line; only its first lines are needed.
  let end = 0;
  while (end < data.length && !(data[end] === 0x0a && data[end + 1] === 0x0a)) end++;
  const head = new TextDecoder().decode(data.subarray(0, end));
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (tree) break;
  }
  if (!SHA.test(tree)) throw new PackError('bad commit');
  return { tree, parents };
}

export type PackFetch = {
  /** The upload-pack endpoint: the Worker's /v1/git/{owner}/{repo}/git-upload-pack. */
  url: string;
  token: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
};

export type PackResult = PackStats & {
  /** Commits read, by sha. */
  commits: Map<string, { tree: string; parents: string[] }>;
  trees: number;
  /** From the request to the first byte of the answer, and to its end. */
  firstByteMs: number;
  ms: number;
};

/**
 * Fetches `wants` (commit shas) at depth 1 without blobs and reads every tree into `store`.
 * `onBytes` follows the download: bytes so far, objects read and announced.
 */
export async function fetchPack(
  wants: readonly string[],
  store: TreeStore,
  how: PackFetch,
  onBytes?: (bytes: number, objects: number, count: number) => void,
): Promise<PackResult> {
  const t0 = performance.now();
  const res = await how.fetch(how.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${how.token}`,
      'Content-Type': UPLOAD_PACK_REQUEST,
      Accept: UPLOAD_PACK_RESULT,
    },
    body: fetchRequestText(wants),
    ...(how.signal ? { signal: how.signal } : {}),
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new PackError(`upload-pack ${res.status}`);
  }
  const firstByteMs = performance.now() - t0;
  const commits = new Map<string, { tree: string; parents: string[] }>();
  let trees = 0;
  const reader = new PackReader({
    onObject: (o) => {
      if (o.type === 'tree') {
        trees++;
        store.addRaw(store.id(o.oid), o.data);
      } else if (o.type === 'commit') commits.set(o.oid, parseCommit(o.data));
    },
  });
  const body = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await body.read();
      if (done) break;
      reader.push(value);
      onBytes?.(reader.stats.bytes, reader.stats.objects, reader.count);
    }
  } catch (error) {
    await body.cancel().catch(() => undefined);
    throw error;
  }
  const stats = reader.end();
  return { ...stats, commits, trees, firstByteMs, ms: performance.now() - t0 };
}
