import { describe, expect, it } from "vitest";
import { BPS, DEFAULT_CONFIG, PRICE_SCALE, STATUS_ALIVE, UNIT_SCALE, commitOf, entryFee, fromHex, toHex, valueOf } from "@ape/engine";
import { COIN_BANK, MAX_PLAYERS, SEAT_HOLD_MS, STAKES, START_BALANCE, WAIT_UNITS, encode } from "../src/index.ts";
import type { RoomMirror } from "../src/index.ts";
import { harness, playCoins, skipAll } from "./harness.ts";

function seat(h: ReturnType<typeof harness>, nick: string): { pid: string; mirror: RoomMirror } {
  const r = h.join(nick);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("coin bank", () => {
  it("has unique, displayable tickers", () => {
    const tickers = new Set(COIN_BANK.map((c) => c.ticker));
    expect(tickers.size).toBe(COIN_BANK.length);
    for (const c of COIN_BANK) {
      expect(c.ticker).toMatch(/^[A-Z0-9]{3,8}$/);
      expect(c.name.length).toBeGreaterThan(2);
      expect(c.lore.length).toBeLessThan(60);
    }
  });
});

describe("room: lanes", () => {
  it("starts three lanes, one per profile, each committed before launch, and welcomes a player with them", () => {
    const h = harness(1);
    const { mirror } = seat(h, "Ana");
    expect(h.room.lanes.map((l) => l.profile)).toEqual([0, 1, 2]);
    expect(mirror.lanes.map((l) => l.roundId)).toEqual(["degen-1", "mid-1", "runner-1"]);
    expect(new Set(mirror.coins.map((c) => c.meta.ticker)).size).toBe(3);
    for (const l of mirror.lanes) {
      expect(l.phase).toBe("prelaunch");
      expect(l.commit).toMatch(/^[0-9a-f]{64}$/);
      expect(l.coin.state.price).toBe(PRICE_SCALE);
    }
    expect(mirror.balance).toBe(START_BALANCE);
    expect(mirror.isHost).toBe(true);
    expect(mirror.waitSeconds(0)).toBe(5);
  });

  it("runs lanes independently and never shows two coins under one name", () => {
    const h = harness(7);
    const { mirror } = seat(h, "Ana");
    skipAll(mirror);
    const together = new Set<string>();
    playCoins(h.room, 12, () => together.add(h.room.lanes.map((l) => l.phase).join(",")));
    expect([...together].some((p) => p.includes("live") && (p.includes("cooldown") || p.includes("prelaunch")))).toBe(true);
    expect(h.room.lanes[0]!.coinNo).toBeGreaterThan(h.room.lanes[2]!.coinNo);
    for (const l of h.room.lanes) expect(l.state.profile).toBe(l.index);
    const names = [...h.room.history.map((s) => s.coin.meta.ticker), ...h.room.lanes.filter((l) => l.phase !== "cooldown").map((l) => l.meta.ticker)];
    expect(new Set(names).size).toBe(names.length);
  });

  it("reveals for every ended coin a seed that matches the commit shown before launch, and the client's replay agrees", () => {
    const h = harness(2);
    const { mirror } = seat(h, "Ana");
    const commits = new Map<string, string>();
    const note = (): void => {
      for (const l of mirror.lanes) if (!commits.has(l.roundId)) commits.set(l.roundId, l.commit);
    };
    note();
    skipAll(mirror);
    playCoins(h.room, 12, note);
    expect(mirror.history.length).toBe(12);
    for (const f of mirror.history) {
      expect(commits.get(f.roundId)).toBe(f.commit);
      expect(commitOf(fromHex(f.seed), f.roundId)).toBe(f.commit);
      const v = mirror.verify(f);
      expect(v.commitOk && v.roundOk).toBe(true);
    }
    const [a, b] = mirror.history;
    expect(mirror.verify({ ...a!, commit: b!.commit }).commitOk).toBe(false);
    expect(mirror.verify({ ...a!, profile: (a!.profile + 1) % 3 }).roundOk).toBe(false);
    // Forged facts next to a real seed do not verify, and malformed input never throws.
    expect(mirror.verify({ ...a!, endPrice: 999n * PRICE_SCALE }).roundOk).toBe(false);
    expect(mirror.verify({ ...a!, status: a!.status === 1 ? 2 : 1 }).roundOk).toBe(false);
    for (const bad of [{ ...a!, seed: a!.seed.slice(0, 63) }, { ...a!, roundId: "degen 1" }]) expect(() => mirror.verify(bad)).not.toThrow();
  });

  it("only reports events the engine produced", () => {
    const h = harness(5);
    const { mirror } = seat(h, "Ana");
    skipAll(mirror);
    const produced = new Set<string>();
    playCoins(h.room, 15, () => {
      for (const l of h.room.lanes) if (l.phase !== "prelaunch" && l.state.tick > 0 && l.state.eventStarted) produced.add(`${l.roundId}:${l.state.tick}:${l.state.tickEvent}`);
    });
    const shown = new Set<string>();
    for (const f of h.frames) for (const m of f.msgs) if (m.t === "feed" && m.item.kind === "event") shown.add(`${m.item.roundId}:${m.item.tick}:${m.item.event}`);
    expect(produced.size).toBeGreaterThan(5);
    expect([...shown].sort()).toEqual([...produced].sort());
  });

  it("a seed draw that fails leaves the lane exactly as it was", () => {
    let n = 0;
    const h = harness(9, () => {
      n++;
      const s = new Uint8Array(32).fill(n & 255);
      return n === 5 ? s.slice(0, 31) : s;
    });
    const { mirror } = seat(h, "Ana");
    skipAll(mirror);
    let threw = false;
    for (let t = 0; t < 20_000 && !threw; t++) {
      try {
        h.room.clock();
      } catch {
        threw = true;
      }
    }
    expect(threw).toBe(true);
    // Every lane still shows a coin together with that coin's own commit.
    for (const l of h.room.lanes) {
      expect(l.ended === null || l.ended.coin.roundId === l.roundId).toBe(true);
      expect(mirror.lanes[l.index]!.roundId).toBe(l.roundId);
      expect(mirror.lanes[l.index]!.commit).toBe(l.commit);
    }
  });
});

describe("room: money", () => {
  it("moves the balance exactly as the engine's accounting says, at the server's price", () => {
    const h = harness(3);
    const { pid, mirror } = seat(h, "Ana");
    let expected = START_BALANCE;
    const units = [0n, 0n, 0n];
    const coinNo = [0, 0, 0];
    const boughtAt = [0, 0, 0];
    const paidSoFar = [0n, 0n, 0n];
    let buys = 0;
    let sells = 0;
    const step = (): void => {
      for (const l of h.room.lanes) {
        const c = l.state;
        const i = l.index;
        if (l.coinNo !== coinNo[i]) {
          coinNo[i] = l.coinNo;
          units[i] = 0n;
          expect(mirror.holding(i).stake).toBe(0n);
        }
        if (c.status !== STATUS_ALIVE) {
          if (units[i]! > 0n) {
            const hd = h.room.holding(pid, i);
            expected += hd.paid - paidSoFar[i]!;
            units[i] = 0n;
          }
          paidSoFar[i] = 0n;
          continue;
        }
        const stake = STAKES[(l.coinNo + i) % STAKES.length]!;
        if (units[i] === 0n && c.tick === (l.coinNo % 3) * 4 && stake <= mirror.balance && paidSoFar[i] === 0n) {
          const seq = mirror.buy(i, stake);
          expect(h.acks(pid).find((a) => a.seq === seq)?.ok).toBe(true);
          expected -= stake;
          units[i] = ((stake - entryFee(DEFAULT_CONFIG, stake)) * UNIT_SCALE) / c.price;
          boughtAt[i] = c.tick;
          buys++;
          expect(mirror.balance).toBe(expected);
          continue;
        }
        if (units[i]! === 0n) continue;
        const held = c.tick - boughtAt[i]!;
        const sellHalf = held === 12;
        const sellAll = held === 30 + 15 * i;
        if (!sellHalf && !sellAll) continue;
        const sold = sellAll ? units[i]! : (units[i]! * 5000n) / BPS;
        const payout = (sold * c.price) / UNIT_SCALE;
        const seq = sellAll ? mirror.sellAll(i) : mirror.sell(i, 5000n);
        expect(h.acks(pid).find((a) => a.seq === seq)?.ok).toBe(true);
        units[i] = units[i]! - sold;
        expected += payout;
        paidSoFar[i] = paidSoFar[i]! + payout;
        sells++;
        expect(mirror.balance).toBe(expected);
      }
    };
    step();
    skipAll(mirror);
    playCoins(h.room, 60, step);
    expect(buys).toBeGreaterThan(30);
    expect(sells).toBeGreaterThan(20);
    expect(mirror.balance).toBe(expected);
    expect(mirror.equity).toBe(h.room.equity(pid));
  });

  it("keeps each player's books apart, and the board adds up", () => {
    const h = harness(8);
    const a = seat(h, "Ana");
    const b = seat(h, "Bo");
    a.mirror.buy(0, STAKES[2]!);
    b.mirror.buy(0, STAKES[4]!);
    b.mirror.buy(1, STAKES[1]!);
    expect(a.mirror.balance).toBe(START_BALANCE - STAKES[2]!);
    expect(b.mirror.balance).toBe(START_BALANCE - STAKES[4]! - STAKES[1]!);
    skipAll(a.mirror);
    playCoins(h.room, 6);
    for (const { pid, mirror } of [a, b]) {
      const row = mirror.board.find((r) => r.id === pid)!;
      expect(row.result).toBe(h.room.equity(pid) - START_BALANCE);
      expect(mirror.balance).toBe(h.room.players.get(pid)!.ledger.balance);
    }
    // Each player sees their own result on an ended coin, not the other's.
    const coin = h.room.history.find((s) => s.coin.lane === 0 && s.coin.roundId === "degen-1")!;
    expect(a.mirror.history.find((f) => f.roundId === "degen-1")!.staked).toBe(STAKES[2]!);
    expect(b.mirror.history.find((f) => f.roundId === "degen-1")!.staked).toBe(STAKES[4]!);
    expect(coin.coin.staked).toBe(0n);
  });

  it("refills only an empty wallet with nothing riding, and the board shows it", () => {
    const h = harness(11);
    const { pid, mirror } = seat(h, "Ana");
    const seq = mirror.refill();
    expect(h.acks(pid).find((x) => x.seq === seq)?.error).toBe("not_broke");
    // Spend down to below the smallest stake.
    const player = h.room.players.get(pid)!;
    player.ledger.balance = 10n;
    const ok = mirror.refill();
    expect(h.acks(pid).find((x) => x.seq === ok)?.ok).toBe(true);
    expect(mirror.balance).toBe(START_BALANCE);
    expect(mirror.board[0]!.refills).toBe(1);
    expect(mirror.board[0]!.result).toBe(-START_BALANCE);
  });
});

describe("room: orders arrive late, twice or forged", () => {
  it("a late sell executes at the price of the tick the server is on, never the one the client saw", () => {
    const h = harness(12);
    const { pid, mirror } = seat(h, "Ana");
    mirror.buy(2, STAKES[3]!); // runner, 1.00x before launch
    skipAll(mirror);
    for (let i = 0; i < 5; i++) h.room.clock();
    const seenPrice = mirror.lanes[2]!.coin.state.price;
    const units = h.room.players.get(pid)!.ledger.positions[0]!.units;
    h.hold = true;
    mirror.sellAll(2);
    let moved = false;
    for (let i = 0; i < 40 && h.room.lanes[2]!.state.status === STATUS_ALIVE; i++) {
      h.room.clock();
      if (h.room.lanes[2]!.state.price !== seenPrice) moved = true;
    }
    expect(moved).toBe(true);
    const before = h.room.players.get(pid)!.ledger.balance;
    const serverPrice = h.room.lanes[2]!.state.price;
    const alive = h.room.lanes[2]!.state.status === STATUS_ALIVE;
    h.hold = false;
    h.deliverHeld();
    const after = h.room.players.get(pid)!.ledger.balance;
    if (alive) expect(after - before).toBe(valueOf(units, serverPrice));
    else expect(after).toBe(before);
    expect(after - before).not.toBe(valueOf(units, seenPrice));
  });

  it("a replayed or duplicated message does nothing", () => {
    const h = harness(13);
    const { pid, mirror } = seat(h, "Ana");
    h.hold = true;
    mirror.buy(0, STAKES[0]!);
    h.hold = false;
    const [{ text }] = h.held.splice(0);
    h.room.handle(pid, text!);
    h.room.handle(pid, text!);
    h.room.handle(pid, text!);
    expect(mirror.balance).toBe(START_BALANCE - STAKES[0]!);
    expect(h.acks(pid).map((a) => a.error ?? "ok")).toEqual(["ok", "stale_seq", "stale_seq"]);
    // An older number than the last one used is refused too.
    h.room.handle(pid, encode({ t: "buy", seq: 1, lane: 1, roundId: "mid-1", stake: STAKES[0]! }));
    expect(mirror.balance).toBe(START_BALANCE - STAKES[0]!);
  });

  it("an order meant for a coin that has since ended does not touch the next coin", () => {
    const h = harness(14);
    const { pid, mirror } = seat(h, "Ana");
    skipAll(mirror);
    const oldId = h.room.lanes[0]!.roundId;
    while (h.room.lanes[0]!.roundId === oldId) h.room.clock();
    h.room.handle(pid, encode({ t: "buy", seq: 99, lane: 0, roundId: oldId, stake: STAKES[0]! }));
    expect(h.acks(pid).at(-1)!.error).toBe("coin_changed");
    expect(mirror.balance).toBe(START_BALANCE);
  });

  it("refuses malformed messages: a client cannot name a price, a fraction above 100% or a bad amount", () => {
    const h = harness(15);
    const { pid, mirror } = seat(h, "Ana");
    mirror.buy(0, STAKES[0]!);
    const bad = [
      encode({ t: "sell", seq: 10, lane: 0, roundId: "degen-1", bps: 10_000n, price: 50n * PRICE_SCALE }),
      encode({ t: "sell", seq: 11, lane: 0, roundId: "degen-1", bps: 10_001n }),
      JSON.stringify({ t: "buy", seq: 12, lane: 0, roundId: "degen-1", stake: 25000 }),
      encode({ t: "buy", seq: 13, lane: 3, roundId: "degen-1", stake: 25_000n }),
      encode({ t: "buy", seq: 14.5, lane: 0, roundId: "degen-1", stake: 25_000n }),
      encode({ t: "hello", room: null, nick: "x", token: null }),
      "x".repeat(5000),
      "[]",
      "{",
    ];
    for (const text of bad) h.room.handle(pid, text);
    expect(h.acks(pid).slice(1).map((a) => a.error)).toEqual(bad.map(() => "bad_message"));
    expect(mirror.balance).toBe(START_BALANCE - STAKES[0]!);
  });
});

describe("room: what leaves the server", () => {
  it("never sends a tick before it is played, nor a seed before its coin has ended", () => {
    const h = harness(16);
    const a = seat(h, "Ana");
    const b = seat(h, "Bo");
    skipAll(a.mirror);
    playCoins(h.room, 25, () => {
      for (const p of [a, b]) {
        const l = p.mirror.lanes[h.room.coinsPlayed % 3]!;
        if (l.phase === "live" && l.coin.state.tick % 17 === 3) p.mirror.buy(l.index, STAKES[0]!);
        if (l.phase === "live" && l.coin.state.tick % 23 === 5) p.mirror.sellAll(l.index);
      }
    });
    // A late joiner and a reconnect, so welcomes are inspected too.
    const c = seat(h, "Cy");
    h.room.leave(c.pid);
    h.join("Cy", h.room.players.get(c.pid)!.token);
    playCoins(h.room, 5);

    const revealedAt = new Map<string, number>();
    h.frames.forEach((f, i) => {
      for (const m of f.msgs) if (m.t === "end" && !revealedAt.has(m.coin.seed)) revealedAt.set(m.coin.seed, i);
    });
    expect(revealedAt.size).toBeGreaterThan(25);
    let records = 0;
    h.frames.forEach((f, i) => {
      for (const [seed, at] of revealedAt) if (i < at) expect(f.text.includes(seed)).toBe(false);
      const check = (roundId: string, tick: number): void => {
        records++;
        const played = f.played.get(roundId);
        // A coin no longer on a lane has ended, so all its ticks were played.
        if (played !== undefined) expect(tick).toBeLessThanOrEqual(played);
      };
      for (const m of f.msgs) {
        if (m.t === "step") check(m.roundId, m.rec.tick);
        if (m.t === "coin") for (const r of m.lane.records) check(m.lane.roundId, r.tick);
        if (m.t === "welcome") for (const l of m.lanes) for (const r of l.records) check(l.roundId, r.tick);
      }
    });
    expect(records).toBeGreaterThan(1000);
    // No coin still on a lane, before its end, was ever revealed.
    const running = h.room.lanes.filter((l) => l.phase !== "cooldown");
    expect(running.length).toBeGreaterThan(0);
    for (const f of h.frames) for (const m of f.msgs) if (m.t === "end") expect(running.some((l) => l.roundId === m.coin.roundId)).toBe(false);
  });

  it("no property reachable from the room exposes a running coin's seed", () => {
    const seeds: Uint8Array[] = [];
    let n = 0;
    const h = harness(17, () => {
      const s = new Uint8Array(32).map((_, i) => (i * 7 + n * 13 + 1) & 255);
      n++;
      seeds.push(s);
      return s;
    });
    const { mirror } = seat(h, "Ana");
    skipAll(mirror);
    h.room.clock();
    const live = new Set(seeds.slice(-3).map((s) => toHex(s)));
    const leaks: string[] = [];
    const seen = new Set<unknown>();
    const walk = (value: unknown, path: string, depth: number): void => {
      if (value === null || typeof value !== "object" || seen.has(value) || depth > 7) return;
      seen.add(value);
      if (value instanceof Uint8Array) {
        if (live.has(toHex(value))) leaks.push(path);
        return;
      }
      if (ArrayBuffer.isView(value)) return;
      const entries = value instanceof Map ? [...value.entries()].map(([k, v]) => [String(k), v] as const) : Object.keys(value).map((k) => [k, (value as Record<string, unknown>)[k]] as const);
      for (const [k, v] of entries) {
        if (typeof v === "string" && live.has(v)) leaks.push(`${path}.${k}`);
        walk(v, `${path}.${k}`, depth + 1);
      }
    };
    walk(h.room, "room", 0);
    expect(leaks).toEqual([]);
  });

  it("every trade in the feed is a real order from a seated player (no synthetic activity)", () => {
    const h = harness(18);
    const players = [seat(h, "Ana"), seat(h, "Bo"), seat(h, "Cy")];
    skipAll(players[0]!.mirror);
    const orders = new Map<string, Set<number>>(players.map((p) => [p.pid, new Set<number>()]));
    playCoins(h.room, 20, () => {
      for (const [k, p] of players.entries()) {
        const l = p.mirror.lanes[(h.room.ticksPlayed + k) % 3]!;
        if (l.phase !== "cooldown" && h.room.ticksPlayed % (7 + k) === 0) orders.get(p.pid)!.add(p.mirror.buy(l.index, STAKES[k]!));
        if (l.phase === "live" && h.room.ticksPlayed % (11 + k) === 0) orders.get(p.pid)!.add(p.mirror.sell(l.index, 5000n));
      }
    });
    const trades = new Map<string, number>();
    for (const f of h.frames) {
      if (f.pid !== players[0]!.pid) continue;
      for (const m of f.msgs) if (m.t === "feed" && (m.item.kind === "buy" || m.item.kind === "sell" || m.item.kind === "initials")) {
        expect(h.room.players.has(m.item.pid!)).toBe(true);
        trades.set(m.item.pid!, (trades.get(m.item.pid!) ?? 0) + 1);
      }
    }
    for (const p of players) {
      const ok = h.acks(p.pid).filter((a) => a.ok && orders.get(p.pid)!.has(a.seq)).length;
      expect(trades.get(p.pid) ?? 0).toBe(ok);
      expect(ok).toBeGreaterThan(5);
    }
  });
});

describe("room: five players stay in sync", () => {
  it("5 clients agree with the server on every tick for 20 consecutive coins on every lane", () => {
    const h = harness(19);
    const players = ["Ana", "Bo", "Cy", "Dee", "Eli"].map((n) => seat(h, n));
    skipAll(players[0]!.mirror);
    const startNo = h.room.lanes.map((l) => l.coinNo);
    let checks = 0;
    let guard = 0;
    while (h.room.lanes.some((l, i) => l.coinNo < startNo[i]! + 21)) {
      h.room.clock();
      if (++guard > 400_000) throw new Error("lanes did not finish 20 coins");
      for (const [k, p] of players.entries()) {
        const l = p.mirror.lanes[k % 3]!;
        if (l.phase !== "cooldown" && guard % (13 + k) === 0 && p.mirror.balance > STAKES[0]!) p.mirror.buy(l.index, STAKES[0]!);
        if (l.phase === "live" && guard % (29 + k) === 0) p.mirror.sellAll(l.index);
      }
      for (const p of players) {
        const m = p.mirror;
        for (const l of h.room.lanes) {
          const v = m.lanes[l.index]!;
          if (v.roundId !== l.roundId || v.phase !== l.phase || v.commit !== l.commit || v.coin.state.tick !== l.state.tick || v.coin.state.price !== l.state.price || v.coin.records.length !== l.records.length) {
            throw new Error(`${p.pid} out of sync on lane ${l.index} at ${l.roundId} tick ${l.state.tick}`);
          }
          if (m.waitSeconds(l.index) !== Math.ceil(Math.max(0, h.room.waitUnits(l.index)) / WAIT_UNITS) && l.phase !== "live") {
            throw new Error(`${p.pid} shows a different countdown on lane ${l.index}`);
          }
        }
        if (m.balance !== h.room.players.get(p.pid)!.ledger.balance) throw new Error(`${p.pid} balance out of sync`);
        if (m.feed[0]?.id !== h.room.feed[0]?.id) throw new Error(`${p.pid} feed out of sync`);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(5 * 5000);
    // All five saw the same ended coins with the same seeds.
    const seen = players.map((p) => p.mirror.history.map((f) => `${f.roundId}:${f.seed}`).join("|"));
    expect(new Set(seen).size).toBe(1);
  });
});

describe("room: seats", () => {
  it("seats at most five, holds a dropped player's seat and bags, and gives them back on reconnect", () => {
    const h = harness(20);
    const ps = ["Ana", "Bo", "Cy", "Dee", "Eli"].map((n) => seat(h, n));
    expect(h.join("Fay")).toEqual({ error: "room_full" });
    expect(h.room.players.size).toBe(MAX_PLAYERS);
    const ana = ps[0]!;
    ana.mirror.buy(2, STAKES[3]!);
    const token = h.room.players.get(ana.pid)!.token;
    h.room.leave(ana.pid);
    // Host passes to the next player.
    expect(ps[1]!.mirror.isHost).toBe(true);
    // The seat is still held: a newcomer is turned away.
    expect(h.join("Fay")).toEqual({ error: "room_full" });
    for (let i = 0; i < 10; i++) h.room.clock();
    const back = h.join("whatever", token);
    if ("error" in back) throw new Error(back.error);
    expect(back.pid).toBe(ana.pid);
    expect(back.mirror.you!.nick).toBe("Ana");
    expect(back.mirror.holding(2).stake).toBe(STAKES[3]!);
    expect(back.mirror.balance).toBe(START_BALANCE - STAKES[3]!);
    // Action numbers carry on from where the seat left off.
    const seq = back.mirror.buy(1, STAKES[0]!);
    expect(h.acks(ana.pid).find((a) => a.seq === seq)?.ok).toBe(true);
    // After the hold runs out, a dropped seat is freed.
    h.room.leave(ps[4]!.pid);
    h.now += SEAT_HOLD_MS + 1;
    h.room.clock();
    expect(h.room.players.has(ps[4]!.pid)).toBe(false);
    expect("pid" in h.join("Fay")).toBe(true);
  });

  it("cleans and de-duplicates nicknames", () => {
    const h = harness(21);
    expect(h.join("  Ана   Б  ")).toMatchObject({ mirror: { you: { nick: "Ана Б" } } });
    expect(h.join("ана б")).toMatchObject({ mirror: { you: { nick: "ана б 2" } } });
    for (const bad of ["a", "", "<script>", "x".repeat(17), "a\u0000b"]) expect(h.join(bad)).toEqual({ error: "bad_nick" });
  });

  it("only the host changes the pace, the break or launches early", () => {
    const h = harness(22);
    const host = seat(h, "Ana");
    const guest = seat(h, "Bo");
    for (const seq of [guest.mirror.setPace("turbo"), guest.mirror.setBreak(20), guest.mirror.skipWait(0)]) {
      expect(h.acks(guest.pid).find((a) => a.seq === seq)?.error).toBe("host_only");
    }
    expect(h.room.pace.id).toBe("fast");
    host.mirror.setPace("turbo");
    host.mirror.setBreak(20);
    expect(guest.mirror.pace.ticksPerSecond).toBe(8);
    expect(guest.mirror.breakSeconds).toBe(20);
    const warp = host.mirror.setPace("warp");
    expect(h.acks(host.pid).find((a) => a.seq === warp)?.error).toBe("bad_setting");
    host.mirror.skipWait(0);
    expect(guest.mirror.lanes[0]!.phase).toBe("live");
  });
});
