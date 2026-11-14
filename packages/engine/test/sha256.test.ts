import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CoinStream, RoundKey, roundProfiles } from "../src/engine.ts";
import { HmacKey, asciiBytes, fromHex, sha256, toHex } from "../src/sha256.ts";

function bytes(n: number, salt: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = (salt * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe("sha256", () => {
  it("matches the standard vectors", () => {
    expect(toHex(sha256(new Uint8Array(0)))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(toHex(sha256(asciiBytes("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches node:crypto for every length 0..300", () => {
    for (let n = 0; n <= 300; n++) {
      const data = bytes(n, n + 1);
      expect(toHex(sha256(data))).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });

  it("matches node:crypto on a large input", () => {
    const data = bytes(300_000, 7);
    expect(toHex(sha256(data))).toBe(createHash("sha256").update(data).digest("hex"));
  });
});

describe("hmac", () => {
  it("matches node:crypto for key lengths 0..100 and message lengths 0..119", () => {
    for (let k = 0; k <= 100; k += 7) {
      const key = bytes(k, 1000 + k);
      const hmac = new HmacKey(key);
      for (let n = 0; n <= 119; n++) {
        const msg = bytes(n, 5000 + n);
        expect(toHex(hmac.digest(msg))).toBe(createHmac("sha256", key).update(msg).digest("hex"));
      }
    }
  });

  it("rejects messages that do not fit", () => {
    expect(() => new HmacKey(bytes(32, 1)).digest(bytes(120, 2))).toThrow();
  });
});

describe("coin stream", () => {
  it("is HMAC-SHA256(serverSeed, roundId:coinIndex:tick:n)", () => {
    const seed = bytes(32, 42);
    const key = new RoundKey(seed, "round-17");
    const words = new Int32Array(8);
    for (const coin of [0, 1, 2]) {
      const stream = new CoinStream(key, coin);
      for (const tick of [0, 1, 9, 10, 99, 2400]) {
        for (const n of [0, 1, 2, 13]) {
          stream.digest(tick, n, words);
          const expected = createHmac("sha256", seed).update(`round-17:${coin}:${tick}:${n}`).digest();
          for (let i = 0; i < 8; i++) expect(words[i]! >>> 0).toBe(expected.readUInt32BE(i * 4));
        }
      }
    }
  });

  it("draws profiles from HMAC-SHA256(serverSeed, roundId:p:0:0)", () => {
    const orders = ["012", "021", "102", "120", "201", "210"];
    for (let i = 0; i < 200; i++) {
      const seed = bytes(32, 900 + i);
      const digest = createHmac("sha256", seed).update(`r${i}:p:0:0`).digest();
      // First 3-bit chunk below 6, reading each 32-bit word from the top, ten chunks per word.
      let pick = -1;
      for (let w = 0; w < 8 && pick < 0; w++) {
        const word = digest.readUInt32BE(w * 4);
        for (let shift = 29; shift >= 0 && pick < 0; shift -= 3) {
          const v = (word >>> shift) & 7;
          if (v < 6) pick = v;
        }
      }
      expect(roundProfiles(new RoundKey(seed, `r${i}`), 3).join("")).toBe(orders[pick]);
    }
  });

  it("rejects bad seeds and round ids", () => {
    expect(() => new RoundKey(bytes(31, 1), "r")).toThrow();
    expect(() => new RoundKey(bytes(32, 1), "")).toThrow();
    expect(() => new RoundKey(bytes(32, 1), "a:b")).toThrow();
    expect(() => new RoundKey(bytes(32, 1), "x".repeat(49))).toThrow();
  });
});

describe("hex", () => {
  it("round-trips", () => {
    const data = bytes(64, 3);
    expect(fromHex(toHex(data))).toEqual(data);
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
  });
});
