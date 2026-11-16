// Bug-hunter reproductions, round 2. Every test here is EXPECTED TO FAIL until
// the finding it documents is fixed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PRICE_SCALE } from "../src/config.ts";
import type { EngineConfig } from "../src/config.ts";
import { createEngine, generateCoinRound } from "../src/engine.ts";
import { sha256 } from "../src/sha256.ts";

describe("bughunt2 E1 (fairness, hardening): validateConfig can be bypassed after createEngine", () => {
  it("the engine does not keep a live reference to a mutable config", () => {
    const cfg = { ...DEFAULT_CONFIG } as { -readonly [K in keyof EngineConfig]: EngineConfig[K] };
    const engine = createEngine(cfg);
    cfg.maxTicks = 2400.5; // rejected by validateConfig, but read by stepCoin on every tick
    cfg.eventMinTicks = 0;
    let longest = 0;
    for (let i = 0; i < 10; i++) {
      const ticks = generateCoinRound(engine, sha256(new Uint8Array([i, 0xe1])), `runner-${i + 1}`).coins[0]!.ticks;
      if (ticks.length - 1 > longest) longest = ticks.length - 1;
    }
    expect(longest).toBeLessThanOrEqual(2400);
  });

  it("DEFAULT_CONFIG, which every default engine and Ledger share, is frozen", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.graduation)).toBe(true);
  });

  it("rejects a non-integer graduation price (integer-only rule, CLAUDE.md #5)", () => {
    const cfg = { ...DEFAULT_CONFIG, graduation: { ...DEFAULT_CONFIG.graduation, price: 10_000_000_000.5 as unknown as bigint } };
    expect(() => createEngine(cfg)).toThrow();
  });
});

// Loads the checker from purity.test.ts as it stands, so this test follows any fix.
function loadChecker(): (code: string) => string[] {
  const src = readFileSync(fileURLToPath(new URL("./purity.test.ts", import.meta.url)), "utf8");
  const head = src.slice(0, src.indexOf('describe("engine purity')).replace(/^import .*$/gm, "");
  const js = ts.transpileModule(head, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const make = new Function("ts", "readdirSync", "join", "fileURLToPath", `${js}\nreturn checkSnippet;`);
  return make(ts, readdirSync, join, fileURLToPath) as (code: string) => string[];
}

describe("bughunt2 E2 (fairness, test gap): impure code the AST purity check does not flag", () => {
  const checkSnippet = loadChecker();
  it("control: the loaded checker still flags Math.random", () => {
    expect(checkSnippet("export const a = Math.random();")).not.toEqual([]);
  });
  const impure: [string, string][] = [
    ["Function constructor reached via .constructor", 'export const a = ([].constructor.constructor as (s: string) => () => number)("return Ma" + "th.random()")();'],
    ["float from unary plus", 'export const a = +"1.5";'],
    ["float from JSON.parse", 'export const a: number = JSON.parse("0.5");'],
    ["float division disguised by a type assertion", "export const half = (p: number) => (p as unknown as bigint) / (2 as unknown as bigint);"],
    ["Number() of a number disguised by a type assertion", "export const a = (x: number) => Number(x as unknown as bigint);"],
    ["forbidden member through a computed name", 'const k = "toFixed"; export const a = (x: number) => (x as unknown as Record<string, (d: number) => string>)[k]!(2);'],
    ["locale-dependent localeCompare", "export const a = (s: string, t: string) => s.localeCompare(t);"],
    ["locale-dependent toLocaleUpperCase", "export const a = (s: string) => s.toLocaleUpperCase();"],
    ["import that leaves src through ./..", 'import { simulateChunk } from "./../../sim/src/core.ts"; export const a = simulateChunk;'],
    ["GC-dependent WeakRef", "export const a = (o: object) => new WeakRef(o).deref() === undefined;"],
  ];
  for (const [name, code] of impure) {
    it(`flags: ${name}`, () => {
      expect(checkSnippet(code)).not.toEqual([]);
    });
  }

  it("scans every source file under src, not only .ts (a .js/.mts helper would be skipped)", () => {
    const test = readFileSync(fileURLToPath(new URL("./purity.test.ts", import.meta.url)), "utf8");
    expect(test.includes('.filter((f) => f.endsWith(".ts"))')).toBe(false);
  });
});

describe("bughunt2 E3 (control): profile always comes from the round id", () => {
  it("replay profile equals the profile named in the id", () => {
    const engine = createEngine();
    for (const [id, p] of [["degen-7", 0], ["mid-7", 1], ["runner-7", 2]] as const) {
      expect(generateCoinRound(engine, sha256(new Uint8Array([7])), id).coins[0]!.profile).toBe(p);
    }
    expect(PRICE_SCALE).toBe(1_000_000_000n);
  });
});
