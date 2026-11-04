/**
 * Inflating one zlib stream out of a packfile, which holds thousands back to back with nothing
 * saying where each ends: DecompressionStream cannot tell how much input it used, so this small
 * inflater (RFC 1950/1951, table-driven like fflate's) reports it. The pack's object header gives
 * the inflated size, so the output is one exact allocation.
 */

// Length and distance codes: extra bits and base values (RFC 1951 3.2.5).
const LEN_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0,
]);
const LEN_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258, 0, 0,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
  0, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0,
]);
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** 15-bit bit reversals, for building tables indexed by bits as deflate packs them. */
const REV = new Uint16Array(32768);
for (let i = 0; i < 32768; i++) {
  let x = ((i & 0xaaaa) >> 1) | ((i & 0x5555) << 1);
  x = ((x & 0xcccc) >> 2) | ((x & 0x3333) << 2);
  x = ((x & 0xf0f0) >> 4) | ((x & 0x0f0f) << 4);
  REV[i] = (((x & 0xff00) >> 8) | ((x & 0x00ff) << 8)) >> 1;
}

/**
 * A decoding table for code lengths `lengths`: indexed by the next `bits` input bits, each entry
 * is (symbol << 4) | code length.
 */
function table(lengths: Uint8Array, bits: number): Uint16Array {
  const count = new Uint16Array(bits + 1);
  for (const l of lengths) if (l) count[l]!++;
  const next = new Uint16Array(bits + 1);
  for (let l = 1; l <= bits; l++) next[l] = (next[l - 1]! + count[l - 1]!) << 1;
  const out = new Uint16Array(1 << bits);
  const shift = 15 - bits;
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym]!;
    if (!l) continue;
    const entry = (sym << 4) | l;
    const free = bits - l;
    let v = next[l]!++ << free;
    for (const end = v | ((1 << free) - 1); v <= end; v++) out[REV[v]! >> shift] = entry;
  }
  return out;
}

const maxOf = (a: Uint8Array) => {
  let m = 0;
  for (const x of a) if (x > m) m = x;
  return m;
};

const FIXED_LEN = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  return { table: table(l, 9), bits: 9 };
})();
const FIXED_DIST = (() => {
  const l = new Uint8Array(32).fill(5);
  return { table: table(l, 5), bits: 5 };
})();

export class InflateError extends Error {}

const truncated = (): never => {
  throw new InflateError('truncated');
};

/**
 * Inflates the zlib stream at `src[start..]` (only the first `limit` bytes of `src` hold data)
 * into exactly `size` bytes. Returns the bytes and the offset just past the stream's checksum, or
 * null when the input may end first (wait for more of the pack, then call again). `complete`
 * says no more input will come: then running out is an error.
 */
export function inflateAt(
  src: Uint8Array,
  start: number,
  limit: number,
  size: number,
  complete = false,
): { out: Uint8Array; end: number } | null {
  if (start + 2 > limit) {
    if (complete) throw new InflateError('truncated');
    return null;
  }
  if ((src[start]! & 0x0f) !== 8 || ((src[start]! << 8) | src[start + 1]!) % 31 !== 0) {
    throw new InflateError('not a zlib stream');
  }
  const out = new Uint8Array(size);
  const total = limit * 8;
  let pos = (start + 2) * 8;
  let at = 0;
  /** Whether the next `n` bits may lie past the input so far (nothing is read past it then). */
  const short = (n: number) => !complete && pos + n > total;
  const bits = (n: number) => {
    const o = pos >> 3;
    const v = ((src[o]! | (src[o + 1]! << 8) | (src[o + 2]! << 16)) >> (pos & 7)) & ((1 << n) - 1);
    pos += n;
    return v;
  };
  const peek = (mask: number) => {
    const o = pos >> 3;
    return ((src[o]! | (src[o + 1]! << 8) | (src[o + 2]! << 16)) >> (pos & 7)) & mask;
  };
  for (let last = 0; !last;) {
    if (short(3)) return null;
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      const o = (pos + 7) >> 3;
      if (o + 4 > limit) return short(Infinity) ? null : truncated();
      const len = src[o]! | (src[o + 1]! << 8);
      if (o + 4 + len > limit) return short(Infinity) ? null : truncated();
      if (at + len > size) throw new InflateError('longer than its header says');
      out.set(src.subarray(o + 4, o + 4 + len), at);
      at += len;
      pos = (o + 4 + len) * 8;
      continue;
    }
    let lt: Uint16Array;
    let lb: number;
    let dt: Uint16Array;
    let db: number;
    if (type === 1) {
      lt = FIXED_LEN.table;
      lb = FIXED_LEN.bits;
      dt = FIXED_DIST.table;
      db = FIXED_DIST.bits;
    } else if (type === 2) {
      if (short(14)) return null;
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      if (short(hclen * 3)) return null;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3);
      const cb = maxOf(cl);
      const ct = table(cl, cb);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        if (short(cb + 7)) return null;
        const e = ct[peek((1 << cb) - 1)]!;
        pos += e & 15;
        const sym = e >> 4;
        if (sym < 16) lengths[i++] = sym;
        else {
          let fill = 0;
          let n: number;
          if (sym === 16) {
            if (i === 0) throw new InflateError('bad code lengths');
            fill = lengths[i - 1]!;
            n = 3 + bits(2);
          } else if (sym === 17) n = 3 + bits(3);
          else n = 11 + bits(7);
          if (i + n > lengths.length) throw new InflateError('bad code lengths');
          lengths.fill(fill, i, i + n);
          i += n;
        }
      }
      const ll = lengths.subarray(0, hlit);
      const dl = lengths.subarray(hlit);
      lb = maxOf(ll);
      db = Math.max(1, maxOf(dl));
      lt = table(ll, lb);
      dt = table(dl, db);
    } else throw new InflateError('bad block type');
    const lm = (1 << lb) - 1;
    const dm = (1 << db) - 1;
    for (;;) {
      // A symbol, its extra bits, a distance and its extra bits: at most 48 bits.
      if (short(48)) return null;
      const e = lt[peek(lm)]!;
      const l = e & 15;
      if (!l) throw new InflateError('bad literal code');
      pos += l;
      const sym = e >> 4;
      if (sym < 256) {
        if (at >= size) throw new InflateError('longer than its header says');
        out[at++] = sym;
        continue;
      }
      if (sym === 256) break;
      const li = sym - 257;
      if (li > 28) throw new InflateError('bad length code');
      const len = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
      const d = dt[peek(dm)]!;
      if (!(d & 15)) throw new InflateError('bad distance code');
      pos += d & 15;
      const di = d >> 4;
      const dist = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
      if (dist > at) throw new InflateError('distance too far back');
      if (at + len > size) throw new InflateError('longer than its header says');
      for (let k = 0; k < len; k++, at++) out[at] = out[at - dist]!;
    }
  }
  const end = ((pos + 7) >> 3) + 4;
  if (end > limit) return complete ? truncated() : null;
  if (at !== size) throw new InflateError('shorter than its header says');
  return { out, end };
}
