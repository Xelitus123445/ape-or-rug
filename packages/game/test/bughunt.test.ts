// Bug-hunter reproductions from the single-player build (rounds 1 and 2),
// carried over to the room. Each failed when it was written and stays as a
// regression test.
import { describe, expect, it } from "vitest";
import { PRICE_SCALE, STATUS_ALIVE } from "@ape/engine";
import { harness } from "./harness.ts";

function seat(tag: number) {
  const h = harness(tag);
  const r = h.join("Ana");
  if ("error" in r) throw new Error(r.error);
  return { h, ...r };
}

describe("bughunt S2: a 'lost' line never shows a negative amount", () => {
  it("after a profitable partial sell, the rug line reports what was still riding", () => {
    let negative: bigint | null = null;
    let losses = 0;
    for (let i = 0; i < 300 && negative === null; i++) {
      const { h, mirror } = seat(1000 + i);
      mirror.buy(0, 100_000n);
      mirror.skipWait(0);
      let sold = false;
      while (h.room.lanes[0]!.phase === "live") {
        h.room.clock();
        const c = h.room.lanes[0]!.state;
        if (!sold && c.status === STATUS_ALIVE && c.price >= 3n * PRICE_SCALE) {
          mirror.sell(0, 5_000n);
          sold = true;
        }
        const lost = mirror.feed.find((f) => f.kind === "lost" && f.lane === 0);
        if (lost !== undefined) {
          losses++;
          if (lost.amount! < 0n) negative = lost.amount!;
          break;
        }
      }
    }
    expect(losses).toBeGreaterThan(100);
    expect(negative).toBeNull();
  });
});

describe("bughunt2 L1: take initials is announced as a win only when it is one", () => {
  it("the feed's `won` flag matches the bag's numbers after take initials", () => {
    let mismatch: string | null = null;
    let checked = 0;
    for (let i = 0; i < 600 && mismatch === null; i++) {
      const { h, mirror } = seat(2000 + i);
      mirror.buy(0, 25_000n);
      mirror.skipWait(0);
      let big = false;
      for (let t = 0; t < 3000 && h.room.lanes[0]!.phase === "live"; t++) {
        h.room.clock();
        if (h.room.lanes[0]!.phase !== "live") break;
        const c = h.room.lanes[0]!.state;
        if (!big && c.price >= 3n * PRICE_SCALE) {
          mirror.buy(0, 1_000_000n);
          big = true;
        } else if (big && c.price < 3n * PRICE_SCALE && mirror.holding(0).canInitials) {
          const before = mirror.feed[0]?.id;
          mirror.takeInitials(0);
          const f = mirror.feed[0]!;
          if (f.id !== before && f.kind === "initials") {
            checked++;
            const hd = mirror.holding(0);
            if (f.won !== hd.paid + hd.value >= hd.stake) mismatch = `won=${f.won} but paid ${hd.paid} + value ${hd.value} vs stake ${hd.stake}`;
          }
          break;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(mismatch).toBeNull();
  });
});
