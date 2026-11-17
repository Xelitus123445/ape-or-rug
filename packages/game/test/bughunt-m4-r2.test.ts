// Bug-hunt M4 round 2: refill as a top-up. A failing test is a finding.
import { describe, expect, it } from "vitest";
import { START_BALANCE } from "../src/index.ts";
import { harness, skipAll } from "./harness.ts";

describe("bug-hunt M4 r2: refill", () => {
  it("keeps the ledger's own invariant: balance + house is constant for the life of the ledger (ledger.ts:78)", () => {
    const h = harness(93);
    const a = h.join("Ana");
    if ("error" in a) throw new Error("no seat");
    skipAll(a.mirror);
    h.room.clock();
    const ledger = h.room.players.get(a.pid)!.ledger;
    expect(ledger.balance + ledger.house).toBe(START_BALANCE);
    // Broke with nothing riding (shortcut for losing it all on rugs).
    ledger.balance = 0n;
    ledger.house = START_BALANCE;
    a.mirror.refill();
    expect(h.acks(a.pid).at(-1)?.ok).toBe(true);
    const after = h.room.players.get(a.pid)!.ledger;
    // Expected START_BALANCE (or the top-up recorded somewhere the ledger can audit). Actual 2 x START_BALANCE.
    expect(after.balance + after.house).toBe(START_BALANCE);
  });
});
