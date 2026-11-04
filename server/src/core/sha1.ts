/**
 * Git object ids: SHA-1 of `<type> <size>\0<content>`, synchronous so a pack's objects can be
 * named as they are read (crypto.subtle is async and costs a round trip per call).
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Lowercase hex of `bytes[from..from + n]`. */
export function hex(bytes: Uint8Array, from = 0, n = bytes.length - from): string {
  let s = '';
  for (let i = from; i < from + n; i++) s += HEX[bytes[i]!];
  return s;
}

const W = new Int32Array(80);
/** The padded message, reused between calls (grown when an object needs more). */
let scratch = new Uint8Array(1 << 16);

/** The git object id of an object of `type` ('commit', 'tree', ...) holding `data`. */
export function gitOid(type: string, data: Uint8Array): string {
  const head = `${type} ${data.length}\0`;
  const n = head.length + data.length;
  const size = Math.ceil((n + 9) / 64) * 64;
  if (scratch.length < size) scratch = new Uint8Array(Math.max(size, scratch.length * 2));
  const buf = scratch;
  for (let i = 0; i < head.length; i++) buf[i] = head.charCodeAt(i);
  buf.set(data, head.length);
  buf[n] = 0x80;
  buf.fill(0, n + 1, size - 8);
  const bits = n * 8;
  const hi = Math.floor(bits / 2 ** 32);
  buf[size - 8] = hi >>> 24;
  buf[size - 7] = hi >>> 16;
  buf[size - 6] = hi >>> 8;
  buf[size - 5] = hi;
  buf[size - 4] = bits >>> 24;
  buf[size - 3] = bits >>> 16;
  buf[size - 2] = bits >>> 8;
  buf[size - 1] = bits;
  let h0 = 0x67452301;
  let h1 = 0xefcdab89 | 0;
  let h2 = 0x98badcfe | 0;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0 | 0;
  for (let b = 0; b < size; b += 64) {
    for (let i = 0, o = b; i < 16; i++, o += 4) {
      W[i] = (buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!;
    }
    for (let i = 16; i < 80; i++) {
      const x = W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!;
      W[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let bb = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let t: number;
    for (let i = 0; i < 20; i++) {
      t = (((a << 5) | (a >>> 27)) + ((bb & c) | (~bb & d)) + e + 0x5a827999 + W[i]!) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = t;
    }
    for (let i = 20; i < 40; i++) {
      t = (((a << 5) | (a >>> 27)) + (bb ^ c ^ d) + e + 0x6ed9eba1 + W[i]!) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = t;
    }
    for (let i = 40; i < 60; i++) {
      t = (((a << 5) | (a >>> 27)) + ((bb & c) | (bb & d) | (c & d)) + e + 0x8f1bbcdc + W[i]!) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = t;
    }
    for (let i = 60; i < 80; i++) {
      t = (((a << 5) | (a >>> 27)) + (bb ^ c ^ d) + e + 0xca62c1d6 + W[i]!) | 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + bb) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return word(h0) + word(h1) + word(h2) + word(h3) + word(h4);
}

const word = (h: number) =>
  HEX[h >>> 24]! + HEX[(h >>> 16) & 255]! + HEX[(h >>> 8) & 255]! + HEX[h & 255]!;
