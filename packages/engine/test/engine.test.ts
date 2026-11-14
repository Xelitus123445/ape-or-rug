import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  EVENT_NONE,
  PRICE_SCALE,
  STATUS_ALIVE,
  STATUS_RUGGED,
  STATUS_SETTLED,
} from "../src/config.ts";
import { CoinStream, RoundKey, commitOf, createEngine, generateRound, launchCoin, roundHash, stepCoin, verifyCommit } from "../src/engine.ts";
import { fromHex, sha256, toHex } from "../src/sha256.ts";
import { GOLDEN_ROUNDS } from "./golden.ts";

const engine = createEngine();

export function seedOf(i: number): Uint8Array {
  return sha256(new Uint8Array([i & 255, (i >>> 8) & 255, (i >>> 16) & 255, 77]));
}

describe("round generation", () => {
  it("is deterministic: same seed and config, same round", () => {
    const a = generateRound(engine, seedOf(1), "r1");
    const b = generateRound(createEngine({ ...DEFAULT_CONFIG }), seedOf(1), "r1");
    expect(roundHash(a)).toBe(roundHash(b));
    expect(roundHash(generateRound(engine, seedOf(2), "r1"))).not.toBe(roundHash(a));
    expect(roundHash(generateRound(engine, seedOf(1), "r2"))).not.toBe(roundHash(a));
  });

  it("reproduces the golden hashes (10.5 #4)", () => {
    for (const g of GOLDEN_ROUNDS) {
      expect(roundHash(generateRound(engine, fromHex(g.seed), g.roundId))).toBe(g.hash);
    }
  });

  it("produces well-formed coin lives", () => {
    const profiles = [0, 0, 0];
    const orders = new Set<string>();
    let events = 0;
    let graduated = 0;
    for (let i = 0; i < 400; i++) {
      const round = generateRound(engine, seedOf(1000 + i), `r${i}`);
      expect(round.coins.length).toBe(3);
      // Every round has exactly one degen, one mid and one runner.
      expect(round.coins.map((c) => c.profile).sort()).toEqual([0, 1, 2]);
      orders.add(round.coins.map((c) => c.profile).join(""));
      for (const coin of round.coins) {
        profiles[coin.profile]!++;
        const ticks = coin.ticks;
        expect(ticks[0]!.price).toBe(PRICE_SCALE);
        expect(ticks[0]!.status).toBe(STATUS_ALIVE);
        const last = ticks[ticks.length - 1]!;
        expect(last.status === STATUS_RUGGED || last.status === STATUS_SETTLED).toBe(true);
        if (last.status === STATUS_RUGGED) expect(last.price).toBe(0n);
        if (last.status === STATUS_SETTLED) expect(last.tick).toBe(DEFAULT_CONFIG.maxTicks);
        let run = 0;
        let runType = EVENT_NONE;
        let wasGraduated = false;
        for (let t = 1; t < ticks.length; t++) {
          const rec = ticks[t]!;
          expect(rec.tick).toBe(t);
          if (t < ticks.length - 1) expect(rec.status).toBe(STATUS_ALIVE);
          // An event is announced exactly when a run of event ticks begins.
          if (rec.eventStarted) {
            expect(run).toBe(0);
            expect(rec.tickEvent).not.toBe(EVENT_NONE);
            runType = rec.tickEvent;
            events++;
          }
          if (rec.tickEvent !== EVENT_NONE) {
            expect(rec.tickEvent).toBe(runType);
            run++;
          }
          if (rec.event === EVENT_NONE && run > 0 && rec.status === STATUS_ALIVE) {
            expect(run).toBeGreaterThanOrEqual(DEFAULT_CONFIG.eventMinTicks);
            expect(run).toBeLessThanOrEqual(DEFAULT_CONFIG.eventMaxTicks);
            run = 0;
          }
          // Graduation is permanent and happens the first time price >= 10x.
          if (wasGraduated) expect(rec.graduated).toBe(true);
          if (rec.justGraduated) {
            expect(wasGraduated).toBe(false);
            expect(rec.price >= DEFAULT_CONFIG.graduation.price).toBe(true);
          }
          if (!wasGraduated && rec.status === STATUS_ALIVE) expect(rec.graduated).toBe(rec.price >= DEFAULT_CONFIG.graduation.price);
          wasGraduated = rec.graduated;
        }
        if (wasGraduated) graduated++;
      }
    }
    for (const n of profiles) expect(n).toBe(400);
    // All six orders turn up, so no screen position is tied to a profile.
    expect(orders.size).toBe(6);
    expect(events).toBeGreaterThan(500);
    expect(graduated).toBeGreaterThan(10);
  });

  it("steps one tick at a time to the same result as the batch generator", () => {
    const seed = seedOf(5);
    const round = generateRound(engine, seed, "live");
    const key = new RoundKey(seed, "live");
    for (const coin of round.coins) {
      const stream = new CoinStream(key, coin.coinIndex);
      const c = launchCoin(coin.profile);
      for (let t = 1; t < coin.ticks.length; t++) {
        stepCoin(engine, stream, c);
        expect(c.price).toBe(coin.ticks[t]!.price);
        expect(c.status).toBe(coin.ticks[t]!.status);
      }
      const frozen = { ...c };
      stepCoin(engine, stream, c);
      expect(c).toEqual(frozen);
    }
  });

  it("commit-reveal: the seed hashes to the commit", () => {
    const seed = seedOf(9);
    const commit = commitOf(seed, "round-9");
    // SHA-256 over the 32 seed bytes followed by ":round-9"
    const data = new Uint8Array(40);
    data.set(seed);
    data.set(new TextEncoder().encode(":round-9"), 32);
    expect(commit).toBe(toHex(sha256(data)));
    expect(verifyCommit(seed, "round-9", commit)).toBe(true);
    expect(verifyCommit(seed, "round-9", commit.toUpperCase())).toBe(true);
    expect(verifyCommit(seedOf(10), "round-9", commit)).toBe(false);
    // The round id is part of the commitment.
    expect(verifyCommit(seed, "round-8", commit)).toBe(false);
  });
});
