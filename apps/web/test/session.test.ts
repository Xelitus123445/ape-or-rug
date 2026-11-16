import { describe, expect, it } from "vitest";
import { BPS, DEFAULT_CONFIG, PRICE_SCALE, STATUS_ALIVE, UNIT_SCALE, commitOf, entryFee, fromHex, sha256 } from "@ape/engine";
import { COIN_BANK } from "../src/game/coinBank.ts";
import { BREAKS, GameSession, PACES, STAKES, START_BALANCE } from "../src/game/session.ts";

function seeds(salt: number): () => Uint8Array {
  let i = 0;
  return () => sha256(new Uint8Array([salt, i++ & 255, (i >>> 8) & 255, 0x42]));
}

/** Runs the clock until `count` more coins have ended. */
function playCoins(s: GameSession, count: number, onTick?: () => void): void {
  const target = s.coinsPlayed + count;
  let guard = 0;
  while (s.coinsPlayed < target) {
    s.clock();
    onTick?.();
    if (++guard > 40 * DEFAULT_CONFIG.maxTicks) throw new Error("coins did not end");
  }
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

describe("game session (lanes)", () => {
  it("starts three lanes, one per profile, each committed before launch", () => {
    const s = new GameSession(seeds(1));
    expect(s.lanes.length).toBe(3);
    expect(s.lanes.map((l) => l.profile)).toEqual([0, 1, 2]);
    expect(new Set(s.coins.map((c) => c.meta.ticker)).size).toBe(3);
    for (const l of s.lanes) {
      expect(l.phase).toBe("prelaunch");
      expect(l.commit).toMatch(/^[0-9a-f]{64}$/);
      expect(l.ended).toBeNull();
      expect(l.coin.state.price).toBe(PRICE_SCALE);
      expect(l.coin.state.profile).toBe(l.profile);
    }
    expect(s.history.length).toBe(0);
  });

  it("runs lanes independently: a lane relaunches while the others keep going", () => {
    const s = new GameSession(seeds(7));
    s.skipWait();
    const seenTogether = new Set<string>();
    playCoins(s, 12, () => seenTogether.add(s.lanes.map((l) => l.phase).join(",")));
    // Some lane was resting or waiting while another was live.
    expect([...seenTogether].some((p) => p.includes("live") && (p.includes("cooldown") || p.includes("prelaunch")))).toBe(true);
    // The degen lane gets through more coins than the runner lane.
    expect(s.lanes[0]!.coinNo).toBeGreaterThan(s.lanes[2]!.coinNo);
    // Lane profiles never change and three different coins are always on screen.
    for (const l of s.lanes) expect(l.coin.state.profile).toBe(l.index);
    expect(new Set(s.coins.map((c) => c.meta.ticker)).size).toBe(3);
    // The ended-coins list never shows two different coins under one name.
    // (A lane in cooldown still shows its ended coin, which is already in the history.)
    const names = [...s.history.map((f) => f.meta.ticker), ...s.lanes.filter((l) => l.phase !== "cooldown").map((l) => l.coin.meta.ticker)];
    expect(new Set(names).size).toBe(names.length);
  });

  it("reveals for every ended coin a seed that matches its commit and replays to the same coin", () => {
    const s = new GameSession(seeds(2));
    const commits = new Map<string, string>();
    const note = (): void => {
      for (const l of s.lanes) if (!commits.has(l.roundId)) commits.set(l.roundId, l.commit);
    };
    note();
    s.skipWait();
    playCoins(s, 12, note);
    expect(s.history.length).toBe(12);
    for (const f of s.history) {
      // The commit was on show before the coin launched.
      expect(commits.get(f.roundId)).toBe(f.commit);
      expect(commitOf(fromHex(f.seed), f.roundId)).toBe(f.commit);
      const v = s.verify(f);
      expect(v.commitOk).toBe(true);
      expect(v.roundOk).toBe(true);
      expect(f.roundId).toMatch(/^(degen|mid|runner)-\d+$/);
    }
    // A coin checked against another coin's commit fails.
    const [a, b] = s.history;
    expect(s.verify({ ...a!, commit: b!.commit }).commitOk).toBe(false);
    // A coin shown under another profile than its round id names does not replay.
    expect(s.verify({ ...a!, profile: (a!.profile + 1) % 3 }).roundOk).toBe(false);
    expect(s.verify({ ...a!, roundId: `x${a!.roundId}` }).roundOk).toBe(false);
  });

  it("moves the balance exactly as the engine's accounting says", () => {
    const s = new GameSession(seeds(3));
    let expected = START_BALANCE;
    // Independent books per lane, recomputed from the public formulas.
    const units = [0n, 0n, 0n];
    const coinNo = [0, 0, 0];
    const boughtAt = [0, 0, 0];
    let buys = 0;
    let sells = 0;
    const step = (): void => {
      for (const l of s.lanes) {
        const c = l.coin.state;
        const i = l.index;
        if (l.coinNo !== coinNo[i]) {
          // New coin on the lane: the old one is gone, nothing carried over.
          coinNo[i] = l.coinNo;
          units[i] = 0n;
          expect(s.holding(i).stake).toBe(0n);
        }
        if (c.status !== STATUS_ALIVE) {
          if (units[i]! > 0n) {
            // Rugged pays nothing; settled or capped pays what the ledger says.
            const h = s.holding(i);
            expect(h.positions.every((p) => !p.open)).toBe(true);
            expected += h.paid - paidSoFar[i]!;
            units[i] = 0n;
          }
          paidSoFar[i] = 0n;
          continue;
        }
        const stake = STAKES[(l.coinNo + i) % STAKES.length]!;
        if (units[i] === 0n && c.tick === (l.coinNo % 3) * 4 && stake <= s.balance && paidSoFar[i] === 0n) {
          expect(s.buy(i, stake)).toEqual({ ok: true });
          expected -= stake;
          units[i] = ((stake - entryFee(DEFAULT_CONFIG, stake)) * UNIT_SCALE) / c.price;
          boughtAt[i] = c.tick;
          buys++;
          expect(s.balance).toBe(expected);
          continue;
        }
        if (units[i]! === 0n) continue;
        const held = c.tick - boughtAt[i]!;
        const sellHalf = held === 12;
        const sellAll = held === 30 + 15 * i;
        if (!sellHalf && !sellAll) continue;
        const sold = sellAll ? units[i]! : (units[i]! * 5000n) / BPS;
        const payout = (sold * c.price) / UNIT_SCALE;
        expect(sellAll ? s.sellAll(i) : s.sell(i, 5000n)).toEqual({ ok: true });
        units[i] = units[i]! - sold;
        expected += payout;
        paidSoFar[i] = paidSoFar[i]! + payout;
        sells++;
        expect(s.balance).toBe(expected);
      }
    };
    const paidSoFar = [0n, 0n, 0n];
    step();
    s.skipWait();
    playCoins(s, 60, step);
    expect(buys).toBeGreaterThan(30);
    expect(sells).toBeGreaterThan(20);
    // Whatever is still open is worth what the books say; the rest is settled.
    let open = 0n;
    for (const l of s.lanes) open += (units[l.index]! * l.coin.state.price) / UNIT_SCALE;
    expect(s.equity).toBe(s.balance + open);
    expect(s.balance).toBe(expected);
  });

  it("keeps each ended coin's own stake and payout", () => {
    const s = new GameSession(seeds(8));
    s.buy(0, STAKES[2]!);
    s.buy(1, STAKES[3]!);
    s.skipWait();
    let net = 0n;
    let counted = 0;
    playCoins(s, 6, () => {
      for (const l of s.lanes) {
        if (l.phase === "prelaunch" && l.coinNo > 1 && s.holding(l.index).stake === 0n && l.coinNo % 2 === 0) s.buy(l.index, STAKES[1]!);
      }
      while (counted < s.coinsPlayed) {
        const f = s.history[s.coinsPlayed - counted - 1]!;
        net += f.paid - f.staked;
        counted++;
      }
    });
    let openStake = 0n;
    for (const l of s.lanes) for (const p of s.holding(l.index).positions) if (p.open) openStake += p.stake;
    expect(s.balance).toBe(START_BALANCE + net - openStake);
  });

  it("rejects buys on an ended coin and bad lanes, and never goes negative", () => {
    const s = new GameSession(seeds(4));
    s.skipWait();
    while (s.lanes[0]!.phase !== "cooldown") s.clock();
    expect(s.buy(0, STAKES[0]!)).toEqual({ ok: false, error: "coin_not_alive" });
    expect(s.sellAll(0).ok).toBe(false);
    expect(s.buy(7, STAKES[0]!)).toEqual({ ok: false, error: "bad_coin" });
    expect(s.sell(-1, 5000n)).toEqual({ ok: false, error: "bad_coin" });
    expect(s.takeInitials(1.5)).toEqual({ ok: false, error: "bad_coin" });
    expect(s.holding(9).stake).toBe(0n);
    const before = s.balance;
    expect(s.buy(1, 1n).ok).toBe(false);
    expect(s.buy(1, START_BALANCE * 2n).ok).toBe(false);
    expect(s.balance).toBe(before);
  });

  it("only reports events the engine produced", () => {
    const s = new GameSession(seeds(5));
    s.skipWait();
    // Every event the engine starts, noted straight from the coin state as it happens.
    const produced = new Set<string>();
    const shown = new Set<string>();
    playCoins(s, 15, () => {
      for (const l of s.lanes) {
        const c = l.coin.state;
        if (l.phase !== "prelaunch" && c.tick > 0 && c.eventStarted) produced.add(`${l.coin.meta.ticker}:${c.tick}:${c.tickEvent}`);
      }
      for (const f of s.feed) if (f.kind === "event") shown.add(`${f.ticker}:${f.tick}:${f.event}`);
    });
    expect(produced.size).toBeGreaterThan(5);
    // Nothing decorative: every event line matches an engine event, and none is missing.
    expect([...shown].sort()).toEqual([...produced].sort());
  });

  it("keeps waits in seconds when the pace changes, applies the break setting, and resets cleanly", () => {
    const s = new GameSession(seeds(6));
    const seconds = s.waitSeconds(0);
    s.setPace(PACES[2]!.id);
    expect(s.waitSeconds(0)).toBe(seconds);
    s.setBreak(BREAKS[2]!);
    expect(s.breakSeconds).toBe(20);
    s.setBreak(7);
    expect(s.breakSeconds).toBe(20);
    s.skipWait();
    while (s.lanes[0]!.phase !== "cooldown") s.clock();
    // Break of 20 s at 8 ticks/s: 3 s of cooldown, then 17 s of prelaunch.
    expect(s.lanes[0]!.wait).toBe(3 * 8);
    while (s.lanes[0]!.phase === "cooldown") s.clock();
    expect(s.lanes[0]!.phase).toBe("prelaunch");
    expect(s.lanes[0]!.wait).toBe(17 * 8);
    s.buy(1, STAKES[0]!);
    const idsBefore = new Set(s.lanes.map((l) => l.roundId));
    s.reset();
    expect(s.balance).toBe(START_BALANCE);
    expect(s.feed.length).toBe(0);
    expect(s.history.length).toBe(0);
    expect(s.lanes.every((l) => l.phase === "prelaunch" && l.ended === null)).toBe(true);
    // Coin numbers keep counting, so a round id never names two different commits.
    expect(s.lanes.some((l) => idsBefore.has(l.roundId))).toBe(false);
  });
});
