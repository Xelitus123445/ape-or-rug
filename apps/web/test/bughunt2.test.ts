// Bug-hunter reproductions, round 2 (lane mode). Every test here is EXPECTED
// TO FAIL until the finding it documents is fixed.
import { describe, expect, it } from "vitest";
import { PRICE_SCALE, sha256 } from "@ape/engine";
import { GameSession } from "../src/game/session.ts";
import type { FinishedCoin } from "../src/game/session.ts";

function seeds(tag: number): () => Uint8Array {
  let i = 0;
  return () => sha256(new Uint8Array([tag & 255, (tag >>> 8) & 255, i++ & 255, (i >>> 8) & 255, 0xb2]));
}

describe("bughunt2 L1 (cosmetic, honesty): take initials is always announced as a win", () => {
  it("the feed's `won` flag matches the bag's numbers after take initials", () => {
    let mismatch: string | null = null;
    for (let i = 0; i < 600 && mismatch === null; i++) {
      const s = new GameSession(seeds(100 + i));
      s.buy(0, 25_000n); // prelaunch, 1.00x
      s.skipWait(0);
      const c = s.lanes[0]!.coin.state;
      let big = false;
      for (let t = 0; t < 3000 && s.lanes[0]!.phase === "live"; t++) {
        s.clock();
        if (s.lanes[0]!.phase !== "live") break;
        if (!big && c.price >= 3n * PRICE_SCALE) {
          s.buy(0, 1_000_000n);
          big = true;
        } else if (big && c.price < 3n * PRICE_SCALE && s.holding(0).canInitials) {
          if (s.takeInitials(0).ok) {
            const f = s.feed[0]!;
            const h = s.holding(0);
            if (f.won !== h.paid + h.value >= h.stake) mismatch = `won=${f.won} but paid ${h.paid} + value ${h.value} vs stake ${h.stake}`;
          }
          break;
        }
      }
    }
    // session.ts:472 pushes won: true unconditionally.
    expect(mismatch).toBeNull();
  });
});

describe("bughunt2 L2 (cosmetic): switching pace can still add waiting time", () => {
  it("toggling fast <-> turbo with one tick left never leaves more than one tick", () => {
    const s = new GameSession(seeds(2));
    s.setPace("fast");
    const lane = s.lanes[0]!;
    while (lane.wait > 1) s.clock();
    const waits: number[] = [lane.wait];
    for (let i = 0; i < 6; i++) {
      s.setPace(i % 2 === 0 ? "turbo" : "fast");
      waits.push(lane.wait);
    }
    // Back at "fast" the wait should still be 1 tick (the comment at
    // session.ts:241 promises switching back and forth never adds time).
    expect(waits[waits.length - 1], `waits ${waits.join(" -> ")}`).toBe(1);
  });
});

describe("bughunt2 L3 (cosmetic, honesty): verify() does not cover what the verify view shows next to the tick", () => {
  it("a FinishedCoin with a false end price, status and result does not verify", () => {
    const s = new GameSession(seeds(3));
    s.skipWait();
    while (s.history.length === 0) s.clock();
    const f = s.history[0]!;
    const forged: FinishedCoin = { ...f, status: f.status === 1 ? 2 : 1, endPrice: 999n * PRICE_SCALE, peak: 5_000n * PRICE_SCALE, staked: 100_000n, paid: 20_000_000n };
    const v = s.verify(forged);
    // VerifyView (App.tsx:176) prints endLine(coin) from status/endPrice right
    // above "Replaying the seed gives exactly the round you saw".
    expect(v.commitOk && v.roundOk).toBe(false);
  });

  it("verify() reports a malformed coin as failed instead of throwing (VerifyView has no error boundary)", () => {
    const s = new GameSession(seeds(4));
    s.skipWait();
    while (s.history.length === 0) s.clock();
    const f = s.history[0]!;
    for (const bad of [{ ...f, seed: f.seed.slice(0, 63) }, { ...f, seed: f.seed.slice(0, 62) }, { ...f, roundId: "degen 1" }]) {
      expect(() => s.verify(bad)).not.toThrow();
    }
  });
});

describe("bughunt2 L4 (fairness, latent for M3): round ids repeat within one session", () => {
  it("after reset, no round id is reused with a different commit", () => {
    const s = new GameSession(seeds(5));
    const before = new Map(s.lanes.map((l) => [l.roundId, l.commit]));
    s.reset();
    const reused = s.lanes.filter((l) => before.has(l.roundId) && before.get(l.roundId) !== l.commit).map((l) => l.roundId);
    expect(reused).toEqual([]);
  });
});

describe("bughunt2 L5 (crash, robustness): a failed seed draw leaves the lane half-updated", () => {
  it("lane.roundId and lane.commit stay consistent when newSeed returns a bad seed once", () => {
    let n = 0;
    const s = new GameSession(() => {
      n++;
      const x = sha256(new Uint8Array([n & 255, 0x55]));
      return n === 4 ? x.slice(0, 31) : x;
    });
    s.skipWait();
    let threw = false;
    for (let t = 0; t < 20_000 && !threw; t++) {
      try {
        s.clock();
      } catch {
        threw = true;
      }
    }
    expect(threw).toBe(true);
    // prepareCoin (session.ts:264-271) advanced coinNo/roundId before commitOf threw.
    for (const l of s.lanes) {
      const shownWithCommit = l.ended === null || l.ended.roundId === l.roundId;
      expect(shownWithCommit, `lane ${l.index} shows round ${l.roundId} with the commit of ${l.ended?.roundId}`).toBe(true);
    }
  });
});
