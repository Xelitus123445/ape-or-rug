// Bug-hunt M4: room telemetry. A failing test is a finding.
import { describe, expect, it } from "vitest";
import { STAKES } from "../src/index.ts";
import type { RoomEvent } from "../src/index.ts";
import { harness, playCoins, skipAll } from "./harness.ts";

describe("bug-hunt M4: room telemetry", () => {
  it("a refill during a live coin the player already traded does not lose that coin's round_end or add a second round_join", () => {
    const events: { pid: string; ev: RoomEvent }[] = [];
    const h = harness(91, undefined, (pid, ev) => events.push({ pid, ev }));
    const a = h.join("Ana");
    if ("error" in a) throw new Error("no seat");
    skipAll(a.mirror);
    h.room.clock();
    const lane = h.room.lanes[0]!;
    const commit = lane.commit;

    a.mirror.buy(0, STAKES[0]!);
    a.mirror.sell(0, 10_000n);
    expect(h.acks(a.pid).every((x) => x.ok)).toBe(true);
    // Shortcut for "lost the rest of the wallet on other coins": the state is reachable by play
    // (no open bag, balance below the smallest stake); only the way there is shortened.
    h.room.players.get(a.pid)!.ledger.balance = 0n;
    a.mirror.refill();
    expect(h.acks(a.pid).at(-1)?.ok).toBe(true);
    // Back in on the same coin.
    a.mirror.buy(0, STAKES[0]!);

    while (!h.room.history.some((s) => s.coin.commit === commit)) playCoins(h.room, 1);
    const onCoin = events.filter((e) => "commit" in e.ev && e.ev.commit === commit).map((e) => e.ev);
    // One round on this coin: one join, and a round_end that counts both stakes.
    expect(onCoin.filter((e) => e.name === "round_join").length).toBe(1);
    const end = onCoin.find((e) => e.name === "round_end");
    expect(end).toMatchObject({ staked: 2n * STAKES[0]! });
  });

  it("a refill after selling out of a live coin still gets that coin's round_end", () => {
    const events: { pid: string; ev: RoomEvent }[] = [];
    const h = harness(92, undefined, (pid, ev) => events.push({ pid, ev }));
    const a = h.join("Ana");
    if ("error" in a) throw new Error("no seat");
    skipAll(a.mirror);
    h.room.clock();
    const commit = h.room.lanes[0]!.commit;
    a.mirror.buy(0, STAKES[0]!);
    a.mirror.sell(0, 10_000n);
    h.room.players.get(a.pid)!.ledger.balance = 0n;
    a.mirror.refill();
    while (!h.room.history.some((s) => s.coin.commit === commit)) playCoins(h.room, 1);
    // Expected a round_end (the report otherwise files this round as "still open").
    expect(events.some((e) => e.ev.name === "round_end" && "commit" in e.ev && e.ev.commit === commit)).toBe(true);
  });
});
