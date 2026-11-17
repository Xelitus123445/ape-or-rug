// The room's playtest events: one per real thing a player did or had happen,
// tagged with the coin's commit, and never able to disturb the game.
import { describe, expect, it } from "vitest";
import { STATUS_RUGGED } from "@ape/engine";
import { STAKES, parseClient } from "../src/index.ts";
import type { RoomEvent } from "../src/index.ts";
import { harness, playCoins, skipAll } from "./harness.ts";

describe("room telemetry", () => {
  it("reports round joins, buys, sells, rugs and round ends for the right player and coin", () => {
    const events: { pid: string; ev: RoomEvent }[] = [];
    const h = harness(71, undefined, (pid, ev) => events.push({ pid, ev }));
    const a = h.join("Ana");
    const b = h.join("Bo");
    if ("error" in a || "error" in b) throw new Error("no seat");
    skipAll(a.mirror);
    h.room.clock();
    const lane = h.room.lanes[0]!;
    const commit = lane.commit;

    a.mirror.buy(0, STAKES[1]!);
    a.mirror.buy(0, STAKES[0]!);
    const mine = events.filter((e) => e.pid === a.pid).map((e) => e.ev.name);
    // Two buys on one coin: one round joined.
    expect(mine).toEqual(["round_join", "buy", "buy"]);
    expect(events.every((e) => e.pid === a.pid)).toBe(true);
    const join = events[0]!.ev;
    expect(join).toMatchObject({ name: "round_join", lane: 0, profile: 0, roundId: lane.roundId, commit });

    a.mirror.sell(0, 5000n);
    const sell = events.find((e) => e.ev.name === "sell")!.ev;
    expect(sell).toMatchObject({ name: "sell", kind: "sell", bps: 5000n, commit });

    // Play the coin out: Ana still holds half, so she either gets rugged or settled, then a round end.
    while (!h.room.history.some((s) => s.coin.commit === commit)) playCoins(h.room, 1);
    const ended = h.room.history.find((s) => s.coin.commit === commit)!.coin;
    const end = events.find((e) => e.ev.name === "round_end" && "commit" in e.ev && e.ev.commit === commit);
    expect(end?.pid).toBe(a.pid);
    expect(end?.ev).toMatchObject({ outcome: ended.status === STATUS_RUGGED ? "rugged" : "settled", staked: STAKES[1]! + STAKES[0]! });
    const rugged = events.filter((e) => e.ev.name === "rugged" && "commit" in e.ev && e.ev.commit === commit);
    expect(rugged.length).toBe(ended.status === STATUS_RUGGED ? 1 : 0);
    // Bo never bought: nothing about him.
    expect(events.some((e) => e.pid === b.pid)).toBe(false);
  });

  it("logs tutorial steps without an answer and without using up an action number", () => {
    const events: { pid: string; ev: RoomEvent }[] = [];
    const h = harness(72, undefined, (pid, ev) => events.push({ pid, ev }));
    const a = h.join("Ana");
    if ("error" in a) throw new Error("no seat");
    const before = h.frames.length;
    a.mirror.trackTutorial(0, "shown");
    a.mirror.trackTutorial(1, "skipped");
    expect(h.frames.length).toBe(before);
    expect(events.map((e) => e.ev)).toEqual([
      { name: "tutorial_step", step: 0, outcome: "shown" },
      { name: "tutorial_step", step: 1, outcome: "skipped" },
    ]);
    // A normal action after it is still accepted.
    a.mirror.refill();
    expect(h.acks(a.pid).at(-1)?.error).toBe("not_broke");
  });

  it("refuses malformed tracking messages and hello tags", () => {
    expect(parseClient(JSON.stringify({ t: "track", e: "tutorial", step: 0, outcome: "shown" }))).not.toBeNull();
    expect(parseClient(JSON.stringify({ t: "track", e: "tutorial", step: 0, outcome: "won" }))).toBeNull();
    expect(parseClient(JSON.stringify({ t: "track", e: "buy", step: 0, outcome: "shown" }))).toBeNull();
    expect(parseClient(JSON.stringify({ t: "track", e: "tutorial", step: 99, outcome: "shown" }))).toBeNull();
    expect(parseClient(JSON.stringify({ t: "track", e: "tutorial", step: 0, outcome: "shown", x: 1 }))).toBeNull();
    const hex = "0123456789abcdef0123456789abcdef";
    const hello = { t: "hello", room: null, nick: "Ana", token: null, anon: hex, session: hex, source: "crypto" };
    expect(parseClient(JSON.stringify(hello))).toMatchObject({ anon: hex, session: hex, source: "crypto" });
    expect(parseClient(JSON.stringify({ t: "hello", room: null, nick: "Ana", token: null }))).toMatchObject({ anon: null, session: null, source: null });
    expect(parseClient(JSON.stringify({ ...hello, source: "Crypto Fans!" }))).toBeNull();
    expect(parseClient(JSON.stringify({ ...hello, anon: "ana@example.com" }))).toBeNull();
    const { source: _s, ...partial } = hello;
    expect(parseClient(JSON.stringify(partial))).toBeNull();
  });

  it("keeps playing when the tracker throws", () => {
    const h = harness(73, undefined, () => {
      throw new Error("tracker down");
    });
    const a = h.join("Ana");
    if ("error" in a) throw new Error("no seat");
    skipAll(a.mirror);
    h.room.clock();
    a.mirror.buy(1, STAKES[0]!);
    expect(h.acks(a.pid).at(-1)?.ok).toBe(true);
    expect(() => playCoins(h.room, 3)).not.toThrow();
  });
});
