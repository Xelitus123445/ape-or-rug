// Bug-hunter reproductions for the single-player session. Each test failed
// when it was written; they pass now that the findings are fixed and stay as
// regression tests. Adapted to lane mode (one seed per coin instead of one
// per round) without changing what each one checks.
import { describe, expect, it } from "vitest";
import { sha256, toHex } from "@ape/engine";
import { GameSession } from "../src/game/session.ts";

function seeds(tag: number): { next: () => Uint8Array; all: Uint8Array[] } {
  const all: Uint8Array[] = [];
  let i = 0;
  return {
    all,
    next: () => {
      const s = sha256(new Uint8Array([tag & 255, (tag >>> 8) & 255, i++ & 255, 0xb6]));
      all.push(s);
      return s;
    },
  };
}

describe("bughunt S1 (fairness, latent): the seed is readable while the coin is live", () => {
  it("no property reachable from the session exposes a live coin's seed", () => {
    const src = seeds(1);
    const s = new GameSession(src.next);
    s.skipWait();
    s.clock();
    expect(s.lanes.every((l) => l.phase === "live")).toBe(true);
    const live = new Set(src.all.map((x) => toHex(x)));
    const leaks: string[] = [];
    // Walk everything enumerable from the session, as a state dump would.
    const seen = new Set<unknown>();
    const walk = (value: unknown, path: string, depth: number): void => {
      if (value === null || typeof value !== "object" || seen.has(value) || depth > 6) return;
      seen.add(value);
      if (value instanceof Uint8Array) {
        if (live.has(toHex(value))) leaks.push(path);
        return;
      }
      if (ArrayBuffer.isView(value)) return;
      for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    };
    walk(s, "session", 0);
    expect(leaks).toEqual([]);
    // Nothing as text either: no live seed in any string field.
    const text = JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const hex of live) expect(text.includes(hex)).toBe(false);
  });
});

describe("bughunt S2 (cosmetic, honesty): 'You lost' feed line with a negative amount", () => {
  it("never reports a negative loss for a position that already paid more than its stake", () => {
    let negative: bigint | null = null;
    let losses = 0;
    for (let i = 0; i < 300 && negative === null; i++) {
      const s = new GameSession(seeds(1000 + i).next);
      s.buy(0, 100_000n);
      s.skipWait();
      let sold = false;
      while (s.lanes[0]!.phase === "live") {
        s.clock();
        const c = s.coins[0]!.state;
        if (!sold && c.status === 0 && c.price >= 3_000_000_000n) {
          s.sell(0, 5_000n);
          sold = true;
        }
        const lost = s.feed.find((f) => f.kind === "lost" && f.lane === 0);
        if (lost !== undefined) {
          losses++;
          if (lost.amount! < 0n) negative = lost.amount!;
          break;
        }
      }
    }
    expect(losses).toBeGreaterThan(100);
    expect(negative, `feed said "You lost ${negative}" (minor units) after a profitable partial sell`).toBeNull();
  });
});

describe("bughunt S3 (cosmetic): the countdown can be stalled by switching pace", () => {
  it("switching pace never adds waiting time", () => {
    const s = new GameSession(seeds(2).next);
    while (s.lanes[0]!.wait > 1) s.clock();
    const before = s.lanes[0]!.wait; // 1 tick left
    s.setPace("chill");
    s.setPace("turbo");
    // Expected: still about one tick. Originally: rounded up to a whole second (8 ticks).
    expect(s.lanes[0]!.wait).toBeLessThanOrEqual(before * 2);
    for (let i = 0; i < 50; i++) {
      s.setPace(i % 2 === 0 ? "chill" : "turbo");
    }
    expect(s.lanes[0]!.wait).toBeLessThanOrEqual(4);
  });
});
