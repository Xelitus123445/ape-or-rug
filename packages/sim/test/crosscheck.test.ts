import { describe, expect, it } from "vitest";
import { BPS, DEFAULT_CONFIG, Ledger, createEngine, fromHex, generateRound } from "@ape/engine";
import { STAKE, STRATEGIES, roundIdFor, seedForRound, simulateChunk } from "../src/core.ts";
import type { TraceAction } from "../src/core.ts";

// The simulator keeps its own fast bookkeeping. Replay every strategy's
// actions through the real Ledger and require the same payout to the minor unit.
describe("simulator vs Ledger", () => {
  it("pays exactly what the Ledger pays for the same actions", () => {
    const engine = createEngine();
    const base = fromHex("00".repeat(31) + "07");
    const ROUNDS = 400;
    const traces: { round: number; coin: number; strategy: number; actions: TraceAction[]; paid: bigint }[] = [];
    simulateChunk(engine, base, 0, ROUNDS, (round, coin, strategy, actions, paid) => {
      traces.push({ round, coin, strategy, actions: [...actions], paid });
    });
    expect(traces.length).toBeGreaterThan(ROUNDS * 3 * 16);
    const seen = new Set<number>();
    let caps = 0;
    let settled = 0;

    const rounds = new Map<number, ReturnType<typeof generateRound>>();
    for (const t of traces) {
      let round = rounds.get(t.round);
      if (round === undefined) {
        round = generateRound(engine, seedForRound(base, t.round), roundIdFor(t.round));
        rounds.set(t.round, round);
      }
      const ticks = round.coins[t.coin]!.ticks;
      const ledger = new Ledger(DEFAULT_CONFIG, 10n * STAKE);
      let id = -1;
      let next = 0;
      for (const rec of ticks) {
        if (rec.tick > 0) ledger.onTick(t.coin, rec.status, rec.price);
        while (next < t.actions.length && t.actions[next]!.tick === rec.tick) {
          const a = t.actions[next++]!;
          if (a.kind === "buy") {
            const r = ledger.buy(t.coin, STAKE, rec.status, rec.price, rec.tick);
            expect(r.ok).toBe(true);
            if (r.ok) id = r.value.id;
          } else if (a.kind === "sell") {
            expect(ledger.sell(id, BPS, rec.status, rec.price).ok).toBe(true);
          } else {
            expect(ledger.takeInitials(id, rec.status, rec.price).ok).toBe(true);
          }
        }
      }
      expect(next).toBe(t.actions.length);
      const pos = ledger.get(id)!;
      expect(pos.open).toBe(false);
      expect(pos.paid, `${STRATEGIES[t.strategy]!.name} round ${t.round} coin ${t.coin}`).toBe(t.paid);
      expect(ledger.balance).toBe(10n * STAKE - STAKE + t.paid);
      seen.add(t.strategy);
      if (pos.closedBy === "cap") caps++;
      if (pos.closedBy === "settled") settled++;
    }
    expect(seen.size).toBe(STRATEGIES.length);
    // The sample must actually exercise the cap and settlement paths.
    expect(caps).toBeGreaterThan(0);
    expect(settled).toBeGreaterThan(0);
  });
});
