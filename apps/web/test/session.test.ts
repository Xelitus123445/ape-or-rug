import { describe, expect, it } from "vitest";
import { BPS, DEFAULT_CONFIG, PRICE_SCALE, STATUS_ALIVE, UNIT_SCALE, commitOf, entryFee, fromHex, sha256 } from "@ape/engine";
import { COIN_BANK } from "../src/game/coinBank.ts";
import { GameSession, PACES, STAKES, START_BALANCE } from "../src/game/session.ts";

function seeds(salt: number): () => Uint8Array {
  let i = 0;
  return () => sha256(new Uint8Array([salt, i++ & 255, (i >>> 8) & 255, 0x42]));
}

function playToEnd(s: GameSession, onTick?: () => void): void {
  s.skipWait();
  let guard = 0;
  while (s.phase === "live") {
    s.clock();
    onTick?.();
    if (++guard > 3 * DEFAULT_CONFIG.maxTicks) throw new Error("round did not end");
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

describe("game session", () => {
  it("launches three different coins and commits to the seed before the round", () => {
    const s = new GameSession(seeds(1));
    expect(s.phase).toBe("countdown");
    expect(s.coins.length).toBe(3);
    expect(new Set(s.coins.map((c) => c.meta.ticker)).size).toBe(3);
    expect(s.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(s.revealedSeed).toBeNull();
    expect(s.verify()).toBeNull();
    for (const c of s.coins) expect(c.state.price).toBe(PRICE_SCALE);
  });

  it("reveals a seed that matches the commit and replays to the same round", () => {
    const s = new GameSession(seeds(2));
    for (let round = 0; round < 5; round++) {
      const commit = s.commit;
      playToEnd(s);
      expect(s.phase).toBe("ended");
      expect(commitOf(fromHex(s.revealedSeed!), s.roundId)).toBe(commit);
      const v = s.verify()!;
      expect(v.commitOk).toBe(true);
      expect(v.roundOk).toBe(true);
      s.skipWait();
      expect(s.phase).toBe("countdown");
      expect(s.revealedSeed).toBeNull();
    }
    expect(s.roundsPlayed).toBe(5);
  });

  it("moves the balance exactly as the engine's accounting says", () => {
    const s = new GameSession(seeds(3));
    let expected = START_BALANCE;
    for (let round = 0; round < 25; round++) {
      // Independent books: units per coin, recomputed from the public formulas.
      const units = [0n, 0n, 0n];
      const stake = STAKES[round % STAKES.length]!;
      for (let coin = 0; coin < 3; coin++) {
        if (stake > s.balance) continue;
        expect(s.buy(coin, stake)).toEqual({ ok: true });
        expected -= stake;
        units[coin] = ((stake - entryFee(DEFAULT_CONFIG, stake)) * UNIT_SCALE) / PRICE_SCALE;
        expect(s.balance).toBe(expected);
      }
      playToEnd(s, () => {
        for (let coin = 0; coin < 3; coin++) {
          const c = s.coins[coin]!.state;
          const held = s.holding(coin);
          if (c.status !== STATUS_ALIVE) {
            if (units[coin]! > 0n && held.positions.every((p) => !p.open)) {
              // Rugged (nothing paid) or settled / capped (paid by the ledger).
              const paidNow = held.paid;
              expected += paidNow - paidSoFar[coin]!;
              paidSoFar[coin] = paidNow;
              units[coin] = 0n;
            }
            continue;
          }
          if (units[coin]! === 0n) continue;
          // Sell half at tick 15, everything at tick 40 + 20 * coin.
          const sellHalf = c.tick === 15;
          const sellAll = c.tick === 40 + 20 * coin;
          if (!sellHalf && !sellAll) continue;
          const sold = sellAll ? units[coin]! : (units[coin]! * 5000n) / BPS;
          const payout = (sold * c.price) / UNIT_SCALE;
          expect(sellAll ? s.sellAll(coin) : s.sell(coin, 5000n)).toEqual({ ok: true });
          units[coin] = units[coin]! - sold;
          expected += payout;
          paidSoFar[coin] = paidSoFar[coin]! + payout;
          expect(s.balance).toBe(expected);
        }
      });
      expect(s.balance).toBe(expected);
      expect(s.summary!.net).toBe(s.balance - roundStart);
      roundStart = s.balance;
      paidSoFar.fill(0n);
      s.skipWait();
    }
    expect(s.balance + 0n).toBe(expected);
  });

  it("rejects buys after the round and on dead coins, and never goes negative", () => {
    const s = new GameSession(seeds(4));
    playToEnd(s);
    expect(s.buy(0, STAKES[0]!)).toEqual({ ok: false, error: "round_not_open" });
    expect(s.sellAll(0).ok).toBe(false);
    s.skipWait();
    expect(s.buy(0, 1n).ok).toBe(false);
    expect(s.buy(0, START_BALANCE * 2n).ok).toBe(false);
    expect(s.balance).toBe(START_BALANCE);
  });

  it("only reports events the engine produced", () => {
    const s = new GameSession(seeds(5));
    for (let round = 0; round < 10; round++) {
      playToEnd(s);
      const started = s.coins.flatMap((c) => c.records.filter((r) => r.eventStarted).map((r) => `${c.index}:${r.tick}:${r.tickEvent}`));
      const shown = s.feed.filter((f) => f.kind === "event").map((f) => `${f.coin}:${f.tick}:${f.event}`);
      // The feed keeps the latest 60 lines, so every shown event must be real.
      for (const e of shown) expect(started).toContain(e);
      if (started.length <= 20) expect(shown.length).toBe(started.length);
      s.skipWait();
    }
  });

  it("keeps the same wait in seconds when the pace changes, and resets cleanly", () => {
    const s = new GameSession(seeds(6));
    const seconds = s.waitSeconds;
    s.setPace(PACES[2]!.id);
    expect(s.waitSeconds).toBe(seconds);
    s.buy(0, STAKES[0]!);
    s.reset();
    expect(s.balance).toBe(START_BALANCE);
    expect(s.feed.length).toBe(0);
    expect(s.phase).toBe("countdown");
  });
});

const paidSoFar = [0n, 0n, 0n];
let roundStart = START_BALANCE;
