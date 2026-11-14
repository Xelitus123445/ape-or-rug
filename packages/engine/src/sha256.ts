// Pure SHA-256 and HMAC-SHA256 on 32-bit integers. No I/O, no platform crypto,
// so Node and the browser compute the same bytes.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const W = new Int32Array(64);

/** One SHA-256 compression of the 64-byte block at `off`, updating `state` in place. */
export function compress(state: Int32Array, block: Uint8Array, off: number): void {
  for (let i = 0; i < 16; i++) {
    const j = off + (i << 2);
    W[i] = (block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!;
  }
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15]!;
    const y = W[i - 2]!;
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
  }
  let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
  let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i]! + W[i]!) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e;
    e = (d + t1) | 0;
    d = c; c = b; b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0]! + a) | 0;
  state[1] = (state[1]! + b) | 0;
  state[2] = (state[2]! + c) | 0;
  state[3] = (state[3]! + d) | 0;
  state[4] = (state[4]! + e) | 0;
  state[5] = (state[5]! + f) | 0;
  state[6] = (state[6]! + g) | 0;
  state[7] = (state[7]! + h) | 0;
}

/** Appends SHA-256 padding for a message of `totalLen` bytes whose tail (`tailLen` bytes) sits at buf[0..]. Returns padded length (64 or 128). */
function padTail(buf: Uint8Array, tailLen: number, totalLen: number): number {
  const padded = tailLen < 56 ? 64 : 128;
  buf[tailLen] = 0x80;
  for (let i = tailLen + 1; i < padded - 8; i++) buf[i] = 0;
  // Bit length as 64-bit big-endian. Messages here are far below 2^29 bytes.
  buf[padded - 8] = 0;
  buf[padded - 7] = 0;
  buf[padded - 6] = 0;
  buf[padded - 5] = (totalLen >>> 29) & 0xff;
  buf[padded - 4] = (totalLen >>> 21) & 0xff;
  buf[padded - 3] = (totalLen >>> 13) & 0xff;
  buf[padded - 2] = (totalLen >>> 5) & 0xff;
  buf[padded - 1] = (totalLen << 3) & 0xff;
  return padded;
}

function wordsToBytes(words: Int32Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const w = words[i]!;
    out[i << 2] = w >>> 24;
    out[(i << 2) + 1] = (w >>> 16) & 0xff;
    out[(i << 2) + 2] = (w >>> 8) & 0xff;
    out[(i << 2) + 3] = w & 0xff;
  }
  return out;
}

/** SHA-256 of a byte array (must be shorter than 2^29 bytes). */
export function sha256(data: Uint8Array): Uint8Array {
  if (data.length >= 0x20000000) throw new Error("sha256: input too long");
  const state = new Int32Array(IV);
  const full = data.length & ~63;
  for (let off = 0; off < full; off += 64) compress(state, data, off);
  const tail = new Uint8Array(128);
  const tailLen = data.length - full;
  for (let i = 0; i < tailLen; i++) tail[i] = data[full + i]!;
  const padded = padTail(tail, tailLen, data.length);
  compress(state, tail, 0);
  if (padded === 128) compress(state, tail, 64);
  return wordsToBytes(state);
}

/** Longest message `HmacKey.digestWords` accepts. */
export const HMAC_MAX_MESSAGE = 119;

/**
 * HMAC-SHA256 with a fixed key. The key pads are compressed once, so each
 * short message costs two or three compressions.
 */
export class HmacKey {
  private readonly inner = new Int32Array(8);
  private readonly outer = new Int32Array(8);
  private readonly state = new Int32Array(8);
  private readonly buf = new Uint8Array(128);
  private readonly obuf = new Uint8Array(64);

  constructor(key: Uint8Array) {
    const k = key.length > 64 ? sha256(key) : key;
    const pad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) pad[i] = (i < k.length ? k[i]! : 0) ^ 0x36;
    this.inner.set(IV);
    compress(this.inner, pad, 0);
    for (let i = 0; i < 64; i++) pad[i] = (i < k.length ? k[i]! : 0) ^ 0x5c;
    this.outer.set(IV);
    compress(this.outer, pad, 0);
    // Outer message is always 32 digest bytes: padding is constant.
    const o = this.obuf;
    o[32] = 0x80;
    // (64 + 32) bytes = 768 bits = 0x0300
    o[62] = 0x03;
    o[63] = 0x00;
  }

  /** HMAC of msg[0..len) written to `out` as 8 big-endian 32-bit words. */
  digestWords(msg: Uint8Array, len: number, out: Int32Array): void {
    if (len > HMAC_MAX_MESSAGE) throw new Error("hmac: message too long");
    const buf = this.buf;
    for (let i = 0; i < len; i++) buf[i] = msg[i]!;
    const padded = padTail(buf, len, 64 + len);
    const st = this.state;
    st.set(this.inner);
    compress(st, buf, 0);
    if (padded === 128) compress(st, buf, 64);
    const o = this.obuf;
    for (let i = 0; i < 8; i++) {
      const w = st[i]!;
      o[i << 2] = w >>> 24;
      o[(i << 2) + 1] = (w >>> 16) & 0xff;
      o[(i << 2) + 2] = (w >>> 8) & 0xff;
      o[(i << 2) + 3] = w & 0xff;
    }
    out.set(this.outer);
    compress(out, o, 0);
  }

  digest(msg: Uint8Array): Uint8Array {
    const words = new Int32Array(8);
    this.digestWords(msg, msg.length, words);
    return wordsToBytes(words);
  }
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += HEX[b >>> 4]! + HEX[b & 15]!;
  }
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if ((hex.length & 1) !== 0) throw new Error("fromHex: odd length");
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX.indexOf(hex[i << 1]!.toLowerCase());
    const lo = HEX.indexOf(hex[(i << 1) + 1]!.toLowerCase());
    if (hi < 0 || lo < 0) throw new Error("fromHex: bad digit");
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** ASCII string to bytes. Throws on non-ASCII so hashes never depend on an encoder. */
export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127) throw new Error("asciiBytes: non-ASCII character");
    out[i] = c;
  }
  return out;
}
