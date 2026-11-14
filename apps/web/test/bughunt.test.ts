// Bug-hunter reproductions for the single-player session. Each test failed
// when it was written; they pass now that the findings are fixed and stay as
// regression tests.
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

describe("bughunt S1 (fairness, latent): the seed is readable while the round is live", () => {
  it("no property reachable from the session exposes the seed before the round ends", () => {
    const src = seeds(1);
    const s = new GameSession(src.next);
    s.skipWait();
    s.clock();
    expect(s.phase).toBe("live");
    expect(s.revealedSeed).toBeNull();
    const want = toHex(src.all[src.all.length - 1]!);
    const leaks: string[] = [];
    for (const key of Object.keys(s)) {
      const v = (s as unknown as Record<string, unknown>)[key];
      if (v instanceof Uint8Array && toHex(v) === want) leaks.push(key);
    }
    // `private seed` is a TypeScript-only modifier: at run time it is an
    // ordinary enumerable property (and `streams[i].hmac` holds the key state).
    expect(leaks).toEqual([]);
  });
});

describe("bughunt S2 (cosmetic, honesty): 'You lost' feed line with a negative amount", () => {
  it("never reports a negative loss for a position that already paid more than its stake", () => {
    let negative: bigint | null = null;
    for (let i = 0; i < 300 && negative === null; i++) {
      const s = new GameSession(seeds(1000 + i).next);
      s.buy(0, 100_000n);
      s.skipWait();
      let sold = false;
      while (s.phase === "live") {
        s.clock();
        const c = s.coins[0]!.state;
        if (!sold && c.status === 0 && c.price >= 3_000_000_000n) {
          s.sell(0, 5_000n);
          sold = true;
        }
        const lost = s.feed.find((f) => f.kind === "lost" && f.coin === 0);
        if (lost !== undefined) {
          if (lost.amount! < 0n) negative = lost.amount!;
          break;
        }
      }
    }
    expect(negative, `feed said "You lost ${negative}" (minor units) after a profitable partial sell`).toBeNull();
  });
});

describe("bughunt S3 (cosmetic): the countdown can be stalled by switching pace", () => {
  it("switching pace never adds waiting time", () => {
    const s = new GameSession(seeds(2).next);
    while (s.wait > 1) s.clock();
    const before = s.wait; // 1 tick left
    s.setPace("chill");
    s.setPace("turbo");
    // Expected: still about one tick. Actual: rounded up to a whole second (8 ticks).
    expect(s.wait).toBeLessThanOrEqual(before * 2);
  });
});
