// Bug-hunter reproductions for M3 (shared rooms). Each test here failed when
// it was written; they are expected to fail until the bug is fixed.
import { describe, expect, it } from "vitest";
import { SEAT_HOLD_MS, STAKES, WAIT_UNITS, encode } from "../src/index.ts";
import type { RoomMirror } from "../src/index.ts";
import { harness, playCoins, skipAll } from "./harness.ts";

function seat(h: ReturnType<typeof harness>, nick: string): { pid: string; mirror: RoomMirror } {
  const r = h.join(nick);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("bughunt M3 C1: a seat freed in the same clock as its ledger changed kills the room", () => {
  it("room keeps running when a dropped player's hold expires in the clock that clears their closed bag", () => {
    const h = harness(31);
    const a = seat(h, "Ana");
    const b = seat(h, "Bo");
    // Bo bets on lane 0, then drops out.
    b.mirror.buy(0, STAKES[0]!);
    skipAll(a.mirror);
    h.room.leave(b.pid);
    // Play until lane 0's coin has ended (Bo's bag is closed) and the lane is
    // one clock away from showing its next coin.
    const step = WAIT_UNITS / h.room.ticksPerSecond;
    let guard = 0;
    while (!(h.room.lanes[0]!.phase === "cooldown" && h.room.waitUnits(0) - step <= 0)) {
      h.room.clock();
      if (++guard > 100_000) throw new Error("lane 0 never reached the end of its cooldown");
    }
    // Bo's hold runs out exactly now: the same clock clears Bo's closed bag
    // (marks Bo's "me" view dirty) and prunes Bo's seat, then flush() looks Bo up.
    h.now = SEAT_HOLD_MS + 1;
    expect(() => h.room.clock()).not.toThrow();
    // And the room is still alive for Ana afterwards: clocks and orders work.
    expect(() => h.room.clock()).not.toThrow();
    expect(() => h.room.handle(a.pid, encode({ t: "refill", seq: 1000 }))).not.toThrow();
  });
});

describe("bughunt M3 R1: the welcome a late joiner gets fits the server's own send buffer limit", () => {
  it("a welcome after a dozen coins stays under 1 MiB (server.ts drops a socket with more than 1 MiB buffered)", () => {
    const h = harness(32);
    const a = seat(h, "Ana");
    // Calm runner coins run long; that is where the size comes from.
    skipAll(a.mirror);
    playCoins(h.room, 14);
    // Keep playing until a long runner coin has ended, so history holds at least one long coin.
    let guard = 0;
    while (!h.room.history.some((s) => s.coin.ticks > 1200) && ++guard < 400) playCoins(h.room, 1);
    const late = seat(h, "Cy");
    const frame = h.frames.filter((f) => f.pid === late.pid).find((f) => f.msgs.some((m) => m.t === "welcome"))!;
    const longest = Math.max(...h.room.history.map((s) => s.coin.ticks));
    // eslint-disable-next-line no-console
    console.log(`welcome ${frame.text.length} bytes, history ${h.room.history.length} coins, longest ${longest} ticks`);
    expect(frame.text.length).toBeLessThan(1 << 20);
  });
});

describe("bughunt M3 N1: one player cannot pose as another in the feed or on the board", () => {
  it("a nickname that only differs by look-alike letters is de-duplicated", () => {
    const h = harness(33);
    seat(h, "Ana");
    // Cyrillic "А" (U+0410) instead of Latin "A": renders identically.
    // Fixed either way: the name is refused (mixed scripts) or told apart.
    const spoof = h.join("Аna");
    if (!("error" in spoof)) expect(spoof.mirror.you!.nick).not.toBe("Аna");
    // An all-Cyrillic look-alike ("Аео" vs "Aeo") is told apart by a number.
    seat(h, "Aeo");
    expect(seat(h, "Аео").mirror.you!.nick).toBe("Аео 2");
  });

  it("full-width letters are folded too", () => {
    const h = harness(34);
    seat(h, "Ana");
    const spoof = seat(h, "Ａna"); // "Ａna"
    expect(spoof.mirror.you!.nick.normalize("NFKC")).not.toBe("Ana");
  });
});
