import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PRICE_SCALE, REGIME_COUNT, TABLE_SIZE, TWO_32, regimeParams } from "../src/config.ts";
import { createEngine, loadTables } from "../src/engine.ts";
import { TABLES_SHA256 } from "../src/tables.checksum.ts";
import { TABLE_LINES } from "../src/tables.generated.ts";
import { buildTable, inverseNormalCdf, tableLine } from "../tools/table-builder.ts";

const K = BigInt(TABLE_SIZE);
// Drift bound of math spec 10.3: -1e-9 <= d <= 0, as exact integers.
// d = (2^32 - H) * sum / (2^32 * K * SCALE) - 1
function assertIdentity(H: bigint, g: readonly bigint[]): void {
  const sum = g.reduce((s, x) => s + x, 0n);
  const lhs = (TWO_32 - H) * sum;
  const rhs = TWO_32 * K * PRICE_SCALE;
  expect(lhs <= rhs).toBe(true);
  // d >= -1e-9  <=>  lhs * 1e9 >= rhs * (1e9 - 1)
  expect(lhs * 1_000_000_000n >= rhs * 999_999_999n).toBe(true);
  // "left side as large as possible": one more unit in the sum would break it.
  expect((TWO_32 - H) * (sum + 1n) > rhs).toBe(true);
}

describe("committed growth tables", () => {
  const tables = loadTables();
  const params = regimeParams(DEFAULT_CONFIG);

  it("has one table per regime, matching the config", () => {
    expect(tables.length).toBe(REGIME_COUNT);
    tables.forEach((t, i) => {
      expect(t.H).toBe(params[i]!.H);
      expect(t.sigmaPpb).toBe(params[i]!.sigmaPpb);
    });
  });

  it("satisfies the fairness identity exactly (10.5 #1)", () => {
    for (const t of tables) assertIdentity(t.H, t.g);
  });

  it("is sorted, positive and lognormal-shaped (10.5 #2)", () => {
    for (const t of tables) {
      for (let i = 0; i < t.g.length; i++) {
        expect(t.g[i]! > 0n).toBe(true);
        if (i > 0) expect(t.g[i]! >= t.g[i - 1]!).toBe(true);
      }
      const h = Number(t.H) / 2 ** 32;
      const s = Number(t.sigmaPpb) / 1e9;
      const g = t.g.map((x) => Number(x) / 1e9);
      const mean = g.reduce((a, x) => a + x, 0) / g.length;
      const variance = g.reduce((a, x) => a + (x - mean) ** 2, 0) / g.length;
      const wantMean = 1 / (1 - h);
      const wantVar = (Math.exp(s * s) - 1) * wantMean * wantMean;
      expect(Math.abs(mean / wantMean - 1)).toBeLessThan(1e-3);
      expect(Math.abs(variance / wantVar - 1)).toBeLessThan(1e-3);
    }
  });

  it("is reproduced by the generator", () => {
    const lines = params.map((p, i) => tableLine(i, p.H, p.sigmaPpb, buildTable(p.H, Number(p.sigmaPpb) / 1e9)));
    expect(lines).toEqual([...TABLE_LINES]);
  });

  it("refuses to load when one digit is edited", () => {
    const lines = [...TABLE_LINES];
    const line = lines[5]!;
    const last = line[line.length - 1]!;
    lines[5] = line.slice(0, -1) + (last === "7" ? "8" : "7");
    expect(() => loadTables(lines, TABLES_SHA256)).toThrow(/checksum mismatch/);
    expect(() => loadTables(TABLE_LINES, TABLES_SHA256.replace(/^./, "0") === TABLES_SHA256 ? "1" + TABLES_SHA256.slice(1) : "0" + TABLES_SHA256.slice(1))).toThrow(/checksum mismatch/);
  });

  it("refuses a config the tables were not built for", () => {
    const changed = {
      ...DEFAULT_CONFIG,
      profiles: [{ hazard: { num: 1n, den: 150n }, sigmaPpm: 60_000n }, DEFAULT_CONFIG.profiles[1], DEFAULT_CONFIG.profiles[2]] as const,
    };
    expect(() => createEngine(changed)).toThrow(/does not match growth table/);
    expect(() => createEngine()).not.toThrow();
  });
});

describe("table generator", () => {
  it("has a sane inverse normal CDF", () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 9);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.001)).toBeCloseTo(-3.090232, 5);
    expect(inverseNormalCdf(0.3)).toBeCloseTo(-inverseNormalCdf(0.7), 9);
  });

  it("keeps the one-step identity for random hazard and volatility (math spec 3)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 20_000 }), fc.integer({ min: 2_000, max: 300_000 }), (hazardDen, sigmaPpm) => {
        const H = TWO_32 / BigInt(hazardDen);
        const g = buildTable(H, sigmaPpm / 1e6);
        assertIdentity(H, g);
        for (let i = 1; i < g.length; i++) if (g[i]! < g[i - 1]! || g[0]! <= 0n) return false;
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
