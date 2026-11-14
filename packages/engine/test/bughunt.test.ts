// Bug-hunter reproductions (M1 review). Each test failed when it was written
// and documents one finding; they pass now that the findings are fixed and
// stay as regression tests. Do not weaken; fix the code.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PRICE_SCALE, STATUS_ALIVE, STATUS_RUGGED } from "../src/config.ts";
import type { EngineConfig } from "../src/config.ts";
import { CoinStream, RoundKey, commitOf, createEngine, generateRound, launchCoin, roundHash, roundProfiles, stepCoin, verifyCommit } from "../src/engine.ts";
import { Ledger } from "../src/ledger.ts";
import { sha256 } from "../src/sha256.ts";

const seed = sha256(new Uint8Array([0xb0, 0x06]));

describe("bughunt F1 (fairness): the commitment does not fix the round", () => {
  it("one published commit must not be compatible with many different rounds", () => {
    // Original finding: commit = SHA-256(serverSeed) only, while roundId feeds
    // every HMAC message, so whoever picked roundId after the commit could
    // still choose the outcome (a roundId rugging all three coins within 25
    // ticks turned up after a few thousand tries).
    // Fix: the commit is SHA-256(serverSeed || ":" || roundId). The search for
    // a convenient roundId still works, but the round it finds no longer
    // matches the published commit. (Test rewritten by the author of the fix
    // because commitOf changed signature; the property checked is the same.)
    const engine = createEngine();
    const commit = commitOf(seed, "g0");
    let chosen = "";
    for (let i = 1; i < 20_000 && chosen === ""; i++) {
      const key = new RoundKey(seed, `g${i}`);
      const profiles = roundProfiles(key, 3);
      let allRug = true;
      for (let k = 0; k < 3 && allRug; k++) {
        const stream = new CoinStream(key, k);
        const c = launchCoin(profiles[k]!);
        for (let t = 0; t < 25 && c.status === STATUS_ALIVE; t++) stepCoin(engine, stream, c);
        if (c.status !== STATUS_RUGGED) allRug = false;
      }
      if (allRug) chosen = `g${i}`;
    }
    expect(chosen).not.toBe("");
    expect(verifyCommit(seed, "g0", commit)).toBe(true);
    // The convenient round cannot be passed off under the published commit.
    expect(verifyCommit(seed, chosen, commit)).toBe(false);
    for (let i = 1; i < 2_000; i++) expect(commitOf(seed, `g${i}`)).not.toBe(commit);
  });
});

describe("bughunt F2 (fairness, hardening): checksummed tables can be changed after the check", () => {
  it("a table edited in memory must not reach a newly created engine", () => {
    const first = createEngine();
    const original = first.tables[0]![0]!;
    // Fix: tables are frozen after the checksum, so the write itself throws
    // (strict mode). Either outcome, throwing or not leaking, is acceptable.
    try {
      (first.tables[0] as bigint[])[0] = 5n * PRICE_SCALE;
    } catch {
      expect(first.tables[0]![0]).toBe(original);
      expect(Object.isFrozen(first.tables[0])).toBe(true);
      return;
    }
    try {
      let leaked = false;
      try {
        leaked = createEngine().tables[0]![0] === 5n * PRICE_SCALE;
      } catch {
        leaked = false; // refusing to start is fine
      }
      expect(leaked).toBe(false);
    } finally {
      (first.tables[0] as bigint[])[0] = original;
    }
  });
});

describe("bughunt C1 (crash / fairness on misconfiguration): createEngine accepts configs it cannot run", () => {
  const bad: [string, Partial<EngineConfig>][] = [
    ["eventMinTicks 0 (an event with duration 0 never ends)", { eventMinTicks: 0, eventMaxTicks: 20 }],
    ["negative eventMinTicks", { eventMinTicks: -5, eventMaxTicks: 15 }],
    ["fractional event ticks", { eventMinTicks: 20.5, eventMaxTicks: 40.5 }],
    ["fractional maxTicks (coin never settles)", { maxTicks: 2400.5 }],
    ["NaN maxTicks", { maxTicks: Number.NaN }],
    ["fractional coinsPerRound", { coinsPerRound: 2.5 }],
    ["NaN coinsPerRound", { coinsPerRound: Number.NaN }],
    ["negative entry fee (pays the player)", { entryFeeBps: -300n }],
    ["entry fee above 100%", { entryFeeBps: 20_000n }],
    ["payout cap 0", { maxPayoutMult: 0n }],
  ];
  for (const [name, patch] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => createEngine({ ...DEFAULT_CONFIG, ...patch })).toThrow();
    });
  }

  it("with eventMinTicks 0 an event outlives its maximum duration", () => {
    let engine;
    try {
      engine = createEngine({ ...DEFAULT_CONFIG, eventMinTicks: 0, eventMaxTicks: 20 });
    } catch {
      return; // rejected: fixed
    }
    let longest = 0;
    for (let i = 0; i < 40; i++) {
      for (const coin of generateRound(engine, sha256(new Uint8Array([i, 7])), "cfg").coins) {
        let run = 0;
        for (const t of coin.ticks) {
          run = t.tickEvent !== 0 && !t.eventStarted ? run + 1 : t.tickEvent !== 0 ? 1 : 0;
          if (run > longest) longest = run;
        }
      }
    }
    expect(longest).toBeLessThanOrEqual(20);
  });

  it("a negative entry fee lets a buy and immediate sell create money", () => {
    const l = new Ledger({ ...DEFAULT_CONFIG, entryFeeBps: -300n }, 1_000_000n);
    const r = l.buy(0, 100_000n, STATUS_ALIVE, PRICE_SCALE, 0);
    if (r.ok) l.sell(r.value.id, 10_000n, STATUS_ALIVE, PRICE_SCALE);
    expect(l.balance <= 1_000_000n).toBe(true);
  });
});

describe("bughunt M1 (money, latent): Ledger.buy does not validate the coin", () => {
  for (const coin of ["0", Number.NaN, -1, 1.5, 99] as unknown[]) {
    it(`rejects coin ${JSON.stringify(coin)} (${typeof coin})`, () => {
      const l = new Ledger(DEFAULT_CONFIG, 1_000_000n);
      const r = l.buy(coin as number, 100_000n, STATUS_ALIVE, PRICE_SCALE, 0);
      expect(r.ok).toBe(false);
      expect(l.balance).toBe(1_000_000n);
    });
  }

  it('a position bought with coin "0" survives the rug of coin 0', () => {
    const l = new Ledger(DEFAULT_CONFIG, 1_000_000n);
    const r = l.buy("0" as unknown as number, 100_000n, STATUS_ALIVE, PRICE_SCALE, 0);
    if (!r.ok) return; // rejected: fixed
    l.onTick(0, STATUS_RUGGED, 0n);
    expect(r.value.open).toBe(false);
  });
});

describe("bughunt H1 (fairness, latent): RoundKey accepts things that are not a 32-byte seed or a string id", () => {
  it("rejects a 32-character string as serverSeed", () => {
    expect(() => new RoundKey("0123456789abcdef0123456789abcdef" as unknown as Uint8Array, "r")).toThrow();
  });

  it("two different 32-character string seeds must not give the same round", () => {
    const engine = createEngine();
    let a = "a";
    let b = "b";
    try {
      a = roundHash(generateRound(engine, "a".repeat(32) as unknown as Uint8Array, "r"));
      b = roundHash(generateRound(engine, "b".repeat(32) as unknown as Uint8Array, "r"));
    } catch {
      return; // rejected: fixed
    }
    expect(a).not.toBe(b);
  });

  it("rejects seeds with out-of-range byte values instead of wrapping them", () => {
    const wide = Array.from({ length: 32 }, (_, i) => i + 256) as unknown as Uint8Array;
    expect(() => new RoundKey(wide, "r")).toThrow();
  });

  for (const id of [123, null, undefined, true, ["ab"]] as unknown[]) {
    it(`rejects non-string roundId ${JSON.stringify(id) ?? "undefined"}`, () => {
      expect(() => new RoundKey(seed, id as string)).toThrow();
    });
  }
});
