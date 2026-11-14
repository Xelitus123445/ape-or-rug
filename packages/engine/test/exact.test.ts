import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PRICE_SCALE, STATUS_ALIVE, TABLE_SIZE, TWO_32, regimeIndex } from "../src/config.ts";
import type { EngineConfig } from "../src/config.ts";
import { CoinStream, RoundKey, createEngine, launchCoin, loadTables, stepCoin } from "../src/engine.ts";
import { entryFee, unitsFor, valueOf } from "../src/ledger.ts";
import { sha256 } from "../src/sha256.ts";

const tables = loadTables();
const K = BigInt(TABLE_SIZE);

describe("cumulative drift (10.5 #6)", () => {
  it("is not positive and stays below 1e-5 over a maximum-length round", () => {
    // Per tick, E[M'] = M * (1 + d) minus at most one price unit of rounding,
    // with d in [-dMax, 0]. Over T ticks starting from 1.00x the expected price
    // therefore drops by at most T * (dMax + 1 unit) and never rises.
    // Work in units of 1 / (2^32 * K * SCALE) so everything is an exact integer.
    const denom = TWO_32 * K * PRICE_SCALE;
    let worst = 0n;
    for (const t of tables) {
      const sum = t.g.reduce((s, x) => s + x, 0n);
      const deficit = denom - (TWO_32 - t.H) * sum; // -d * denom
      expect(deficit >= 0n).toBe(true);
      if (deficit > worst) worst = deficit;
    }
    const ticks = BigInt(DEFAULT_CONFIG.maxTicks);
    const roundingPerTick = denom / PRICE_SCALE; // one price unit, relative to 1.00x
    const total = ticks * (worst + roundingPerTick);
    // total / denom < 1e-5
    expect(total * 100_000n < denom).toBe(true);
  });
});

describe("hold exactly n ticks (10.5 #7)", () => {
  it("matches the exact expectation from the tables for n = 1..50", () => {
    // Fixed regime: mid profile, events off, graduation out of reach.
    const config: EngineConfig = {
      ...DEFAULT_CONFIG,
      eventStart: { num: 0n, den: 1n },
      graduation: { ...DEFAULT_CONFIG.graduation, price: PRICE_SCALE * 1_000_000_000_000n },
    };
    const engine = createEngine(config);
    const PROFILE = 1;
    const table = tables[regimeIndex(PROFILE, 0, false)]!;
    const sum = table.g.reduce((s, x) => s + x, 0n);
    // Survive-and-grow factor per tick as an exact fraction num / den (<= 1).
    const num = (TWO_32 - table.H) * sum;
    const den = TWO_32 * K * PRICE_SCALE;

    const stake = 100_000n;
    const net = stake - entryFee(config, stake);
    const units = unitsFor(net, PRICE_SCALE);
    const N = 50;
    const PATHS = 150_000;
    const sums = new Float64Array(N + 1);
    const squares = new Float64Array(N + 1);
    for (let p = 0; p < PATHS; p++) {
      const seed = sha256(new Uint8Array([p & 255, (p >>> 8) & 255, (p >>> 16) & 255, 201]));
      const stream = new CoinStream(new RoundKey(seed, "exact"), 0);
      const c = launchCoin(stream);
      c.profile = PROFILE;
      for (let n = 1; n <= N; n++) {
        stepCoin(engine, stream, c);
        if (c.status !== STATUS_ALIVE) break;
        const x = Number(valueOf(units, c.price)) / Number(stake);
        sums[n]! += x;
        squares[n]! += x * x;
      }
    }

    let numN = 1n;
    let denN = 1n;
    for (let n = 1; n <= N; n++) {
      numN *= num;
      denN *= den;
      // Exact expected payout per unit stake, ignoring sub-unit rounding: net/stake * (num/den)^n
      const exactScaled = (net * numN * 1_000_000_000_000n) / (stake * denN);
      const exact = Number(exactScaled) / 1e12;
      expect(exact).toBeLessThanOrEqual(0.97);
      expect(exact).toBeGreaterThan(0.97 - 1e-7);
      const mean = sums[n]! / PATHS;
      const se = Math.sqrt((squares[n]! / PATHS - mean * mean) / PATHS);
      expect(Math.abs(mean - exact), `n=${n} mean=${mean} exact=${exact} se=${se}`).toBeLessThanOrEqual(4 * se);
    }
  });
});

describe("random draws (10.5 #3, quick version; full run: pnpm test:stream)", () => {
  it("growth index and rug integer look uniform", () => {
    const N = 400_000;
    const stream = new CoinStream(new RoundKey(sha256(new Uint8Array([1, 2, 3])), "uniform"), 0);
    const w = new Int32Array(8);
    const index = new Int32Array(1024);
    const rugTop = new Int32Array(1024);
    for (let t = 1; t <= N; t++) {
      stream.digest(t, 0, w);
      index[w[2]! >>> 22]!++;
      rugTop[w[1]! >>> 22]!++;
    }
    for (const counts of [index, rugTop]) {
      const expected = N / 1024;
      let chi = 0;
      for (const c of counts) chi += ((c - expected) * (c - expected)) / expected;
      // chi-square with 1023 degrees of freedom: mean 1023, sd about 45.2
      expect(Math.abs(chi - 1023)).toBeLessThan(4.5 * 45.2);
    }
  });
});
