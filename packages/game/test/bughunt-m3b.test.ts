// Bug-hunter round 2 for M3 (after d216f0a). Expected to fail until fixed.
import { describe, expect, it } from "vitest";
import type { RoomMirror } from "../src/index.ts";
import { harness, playCoins, skipAll } from "./harness.ts";

function seat(h: ReturnType<typeof harness>, nick: string): { pid: string; mirror: RoomMirror } {
  const r = h.join(nick);
  if ("error" in r) throw new Error(r.error);
  return r;
}

/** Moves an existing client mirror onto a room, as Connection does on a reconnect. */
function attach(h: ReturnType<typeof harness>, mirror: RoomMirror, nick: string, token: string | null): string {
  const r = h.room.join(nick, token);
  if (!r.ok) throw new Error(r.error);
  h.mirrors.set(r.pid, mirror);
  mirror.setSender((text) => h.room.handle(r.pid, text));
  h.room.flush();
  return r.pid;
}

describe("bughunt M3 V1: after a server restart the fairness check never mixes two coins with the same round id", () => {
  it("every ended coin in the client's list still verifies after restart + reconnect", () => {
    // Before the restart: the client sees a few coins in room abc234.
    const before = harness(51);
    const { mirror } = seat(before, "Ana");
    skipAll(mirror);
    playCoins(before.room, 9);
    // The server restarts. The tab keeps its mirror and reconnects; the link
    // reopens a fresh room under the same code, whose round ids start again at 1.
    const after = harness(52);
    const pid = attach(after, mirror, "Ana", null);
    skipAll(mirror);
    playCoins(after.room, 9);
    // A short network blip: same seat, fresh welcome.
    const token = after.room.players.get(pid)!.token;
    after.room.leave(pid);
    attach(after, mirror, "Ana", token);

    const bad = mirror.history.filter((f) => !mirror.verify(f).roundOk).map((f) => `${f.roundId} (id ${f.id}, ${f.records.length} records)`);
    expect(bad).toEqual([]);
  });
});

describe("bughunt M3 N2: all-Greek capitals pose as a Latin name", () => {
  it("'ΑΝΑ' (Greek Alpha, Nu, Alpha) next to 'ANA' is told apart", () => {
    const h = harness(53);
    seat(h, "ANA");
    const spoof = h.join("ΑΝΑ");
    if (!("error" in spoof)) expect(spoof.mirror.you!.nick).not.toBe("ΑΝΑ");
  });

  it("'ΗΕΡΟ' (Greek Eta, Epsilon, Rho, Omicron) next to 'HEPO' is told apart", () => {
    const h = harness(54);
    seat(h, "HEPO");
    const spoof = h.join("ΗΕΡΟ");
    if (!("error" in spoof)) expect(spoof.mirror.you!.nick).not.toBe("ΗΕΡΟ");
  });
});
