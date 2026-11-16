import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PRICE_SCALE, STATUS_ALIVE, STATUS_RUGGED, STATUS_SETTLED, UNIT_SCALE } from "../src/config.ts";
import { Ledger, entryFee, payoutCap, unitsFor, valueOf } from "../src/ledger.ts";

const cfg = DEFAULT_CONFIG;
const START = 10_000_000n;
const X = PRICE_SCALE;

describe("ledger basics", () => {
  it("charges the entry fee and holds units", () => {
    const l = new Ledger(cfg, START);
    const r = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fee).toBe(3_000n);
    expect(valueOf(r.value.units, X)).toBe(97_000n);
    expect(l.balance).toBe(START - 100_000n);
    const s = l.sell(r.value.id, 10_000n, STATUS_ALIVE, 2n * X);
    expect(s.ok && s.value.payout).toBe(194_000n);
    expect(l.balance).toBe(START + 94_000n);
    expect(l.balance + l.house).toBe(START);
  });

  it("rounds the fee up and units down", () => {
    expect(entryFee(cfg, 25_001n)).toBe(751n);
    expect(unitsFor(7n, 3n) * 3n <= 7n * UNIT_SCALE).toBe(true);
  });

  it("rejects bad stakes", () => {
    const l = new Ledger(cfg, START);
    const bad: unknown[] = [100_000, "100000", NaN, 1.5, null, undefined, -100_000];
    for (const stake of bad) {
      const r = l.buy(0, stake as bigint, STATUS_ALIVE, X, 0);
      expect(r.ok).toBe(false);
    }
    expect(l.buy(0, -100_000n, STATUS_ALIVE, X, 0)).toEqual({ ok: false, error: "stake_below_min" });
    expect(l.buy(0, 0n, STATUS_ALIVE, X, 0)).toEqual({ ok: false, error: "stake_below_min" });
    expect(l.buy(0, cfg.minStake - 1n, STATUS_ALIVE, X, 0)).toEqual({ ok: false, error: "stake_below_min" });
    expect(l.buy(0, cfg.maxStake + 1n, STATUS_ALIVE, X, 0)).toEqual({ ok: false, error: "stake_above_max" });
    expect(l.buy(0, 100_000n, STATUS_RUGGED, 0n, 5)).toEqual({ ok: false, error: "coin_not_alive" });
    expect(l.buy(0, 100_000n, STATUS_SETTLED, X, 5)).toEqual({ ok: false, error: "coin_not_alive" });
    expect(l.buy(0, 100_000n, STATUS_ALIVE, 0n, 5)).toEqual({ ok: false, error: "price_too_low" });
    expect(new Ledger(cfg, 50_000n).buy(0, 100_000n, STATUS_ALIVE, X, 0)).toEqual({ ok: false, error: "insufficient_balance" });
    expect(l.balance).toBe(START);
    expect(l.positions.length).toBe(0);
  });

  it("cannot sell more than the position", () => {
    const l = new Ledger(cfg, START);
    const r = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    if (!r.ok) throw new Error("buy failed");
    const id = r.value.id;
    expect(l.sell(id, 10_001n, STATUS_ALIVE, X).ok).toBe(false);
    expect(l.sell(id, 0n, STATUS_ALIVE, X).ok).toBe(false);
    expect(l.sell(id, 6_000n, STATUS_ALIVE, X).ok).toBe(true);
    expect(l.sell(id, 6_000n, STATUS_ALIVE, X).ok).toBe(true);
    expect(l.sell(id, 10_000n, STATUS_ALIVE, X).ok).toBe(true);
    expect(l.sell(id, 10_000n, STATUS_ALIVE, X)).toEqual({ ok: false, error: "position_closed" });
    expect(l.sell(999, 10_000n, STATUS_ALIVE, X)).toEqual({ ok: false, error: "no_such_position" });
    const pos = l.get(id)!;
    expect(pos.paid <= 97_000n).toBe(true);
    expect(pos.paid >= 96_998n).toBe(true);
    expect(l.balance + l.house).toBe(START);
  });

  it("takes initials only above break-even and pays exactly the stake", () => {
    const l = new Ledger(cfg, START);
    const r = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    if (!r.ok) throw new Error("buy failed");
    const id = r.value.id;
    const pos = l.get(id)!;
    // Break-even price: value == stake needs price = 1/0.97.
    const breakEven = (100_000n * UNIT_SCALE) / pos.units;
    expect(l.takeInitials(id, STATUS_ALIVE, X)).toEqual({ ok: false, error: "initials_unavailable" });
    expect(l.takeInitials(id, STATUS_ALIVE, breakEven)).toEqual({ ok: false, error: "initials_unavailable" });
    const t = l.takeInitials(id, STATUS_ALIVE, 2n * X);
    expect(t.ok && t.value.payout).toBe(100_000n);
    expect(l.balance).toBe(START);
    expect(pos.open).toBe(true);
    // Rest is worth 194000 - 100000 = 94000, minus rounding against the player.
    const rest = valueOf(pos.units, 2n * X);
    expect(rest <= 94_000n && rest >= 93_999n).toBe(true);
    // Stake is already back: no second helping.
    expect(l.takeInitials(id, STATUS_ALIVE, 50n * X)).toEqual({ ok: false, error: "initials_unavailable" });
  });

  it("loses the position on a rug and leaves other coins alone", () => {
    const l = new Ledger(cfg, START);
    const a = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    const b = l.buy(1, 100_000n, STATUS_ALIVE, X, 0);
    if (!a.ok || !b.ok) throw new Error("buy failed");
    const out = l.onTick(0, STATUS_RUGGED, 0n);
    expect(out).toEqual([{ positionId: a.value.id, payout: 0n, closed: true, reason: "rug" }]);
    expect(l.get(a.value.id)!.open).toBe(false);
    expect(l.get(b.value.id)!.open).toBe(true);
    expect(l.sell(a.value.id, 10_000n, STATUS_RUGGED, 0n).ok).toBe(false);
    expect(l.balance).toBe(START - 200_000n);
  });

  it("sells everything at settlement", () => {
    const l = new Ledger(cfg, START);
    const a = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    if (!a.ok) throw new Error("buy failed");
    const out = l.onTick(0, STATUS_SETTLED, 3n * X);
    expect(out[0]!.payout).toBe(291_000n);
    expect(out[0]!.reason).toBe("settled");
    expect(l.balance).toBe(START + 191_000n);
  });

  it("pays exactly the cap: one unit below, at, and far above", () => {
    const stake = 100_000n;
    const cap = payoutCap(cfg, stake);
    const probe = new Ledger(cfg, START);
    const p = probe.buy(0, stake, STATUS_ALIVE, X, 0);
    if (!p.ok) throw new Error("buy failed");
    const units = p.value.units;
    const trigger = (cap * UNIT_SCALE + units - 1n) / units;
    expect(valueOf(units, trigger) >= cap).toBe(true);
    expect(valueOf(units, trigger - 1n) < cap).toBe(true);

    for (const [price, capped] of [[trigger - 1n, false], [trigger, true], [trigger * 1000n, true]] as const) {
      const l = new Ledger(cfg, START);
      const r = l.buy(0, stake, STATUS_ALIVE, X, 0);
      if (!r.ok) throw new Error("buy failed");
      const out = l.onTick(0, STATUS_ALIVE, price);
      if (capped) {
        expect(out).toEqual([{ positionId: r.value.id, payout: cap, closed: true, reason: "cap" }]);
        expect(l.balance).toBe(START - stake + cap);
      } else {
        expect(out).toEqual([]);
        // A manual sell above the cap is clamped as well.
        const s = l.sell(r.value.id, 10_000n, STATUS_ALIVE, price * 5n);
        expect(s.ok && s.value.payout).toBe(cap);
      }
      expect(l.get(r.value.id)!.paid <= cap).toBe(true);
    }
  });

  it("clears a coin slot only when nothing in it is open", () => {
    const l = new Ledger(cfg, START);
    const a = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    const b = l.buy(1, 100_000n, STATUS_ALIVE, X, 0);
    if (!a.ok || !b.ok) throw new Error("buy failed");
    // Open position: the slot cannot be cleared, so nothing can carry over to a new coin.
    expect(l.clearClosed(0)).toBe(false);
    expect(l.positions.length).toBe(2);
    l.onTick(0, STATUS_RUGGED, 0n);
    expect(l.clearClosed(0)).toBe(true);
    expect(l.positions.map((p) => p.coin)).toEqual([1]);
    expect(l.get(a.value.id)).toBeUndefined();
    // A new coin in the cleared slot starts from nothing and old ids are dead.
    const c = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    expect(c.ok && c.value.id !== a.value.id).toBe(true);
    expect(l.sell(a.value.id, 10_000n, STATUS_ALIVE, 5n * X)).toEqual({ ok: false, error: "no_such_position" });
    expect(l.balance + l.house).toBe(START);
  });

  it("counts earlier partial sells toward the cap", () => {
    const l = new Ledger(cfg, START);
    const r = l.buy(0, 100_000n, STATUS_ALIVE, X, 0);
    if (!r.ok) throw new Error("buy failed");
    l.sell(r.value.id, 5_000n, STATUS_ALIVE, 100n * X);
    l.onTick(0, STATUS_ALIVE, 100_000n * X);
    expect(l.get(r.value.id)!.paid).toBe(payoutCap(cfg, 100_000n));
    expect(l.get(r.value.id)!.open).toBe(false);
  });
});

type Op =
  | { kind: "buy"; coin: number; stake: bigint }
  | { kind: "sell"; pick: number; bps: bigint }
  | { kind: "initials"; pick: number }
  | { kind: "tick"; coin: number; price: bigint; fate: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("buy" as const), coin: fc.integer({ min: 0, max: 2 }), stake: fc.bigInt({ min: 1n, max: 1_200_000n }) }),
  fc.record({ kind: fc.constant("sell" as const), pick: fc.nat(1000), bps: fc.bigInt({ min: -5n, max: 10_005n }) }),
  fc.record({ kind: fc.constant("initials" as const), pick: fc.nat(1000) }),
  fc.record({
    kind: fc.constant("tick" as const),
    coin: fc.integer({ min: 0, max: 2 }),
    // From 0.000001x to 10,000,000x.
    price: fc.oneof(fc.bigInt({ min: 1_000n, max: 10n * X }), fc.bigInt({ min: 1n, max: 10_000_000n * X })),
    fate: fc.nat(60),
  }),
);

describe("ledger properties (10.5 #5)", () => {
  it("conserves money and never rounds in the player's favour", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 120 }), (ops) => {
        const l = new Ledger(cfg, START);
        const price = [X, X, X];
        const status = [STATUS_ALIVE, STATUS_ALIVE, STATUS_ALIVE];
        let stakesIn = 0n;
        let payouts = 0n;
        for (const op of ops) {
          const before = l.balance;
          if (op.kind === "buy") {
            const r = l.buy(op.coin, op.stake, status[op.coin]!, price[op.coin]!, 0);
            if (r.ok) {
              stakesIn += op.stake;
              const net = op.stake - r.value.fee;
              // fee >= 3% exactly, units never worth more than the net stake
              if (r.value.fee * 10_000n < op.stake * 300n) return false;
              if (r.value.units * price[op.coin]! > net * UNIT_SCALE) return false;
              if (l.balance !== before - op.stake) return false;
            } else if (l.balance !== before) return false;
          } else if (op.kind === "sell" || op.kind === "initials") {
            if (l.positions.length === 0) continue;
            const pos = l.positions[op.pick % l.positions.length]!;
            const unitsBefore = pos.units;
            const paidBefore = pos.paid;
            const r = op.kind === "sell" ? l.sell(pos.id, op.bps, status[pos.coin]!, price[pos.coin]!) : l.takeInitials(pos.id, status[pos.coin]!, price[pos.coin]!);
            if (r.ok) {
              payouts += r.value.payout;
              const sold = unitsBefore - pos.units;
              if (sold <= 0n || r.value.payout < 0n) return false;
              // payout never exceeds the exact value of what was sold
              if (r.value.payout * UNIT_SCALE > sold * price[pos.coin]!) return false;
              if (pos.paid !== paidBefore + r.value.payout) return false;
              if (op.kind === "initials" && pos.paid !== pos.stake) return false;
            } else if (l.balance !== before || pos.units !== unitsBefore) return false;
          } else {
            if (status[op.coin] !== STATUS_ALIVE) continue;
            if (op.fate === 0) {
              status[op.coin] = STATUS_RUGGED;
              price[op.coin] = 0n;
            } else {
              price[op.coin] = op.price;
              if (op.fate === 1) status[op.coin] = STATUS_SETTLED;
            }
            const openValue = new Map(l.positions.filter((p) => p.open && p.coin === op.coin).map((p) => [p.id, p.units * price[op.coin]!]));
            for (const o of l.onTick(op.coin, status[op.coin]!, price[op.coin]!)) {
              payouts += o.payout;
              if (o.payout * UNIT_SCALE > openValue.get(o.positionId)!) return false;
              if (o.reason === "rug" && o.payout !== 0n) return false;
            }
            // nothing stays open on a dead coin
            if (status[op.coin] !== STATUS_ALIVE && l.positions.some((p) => p.open && p.coin === op.coin)) return false;
          }
          if (l.balance + l.house !== START) return false;
          if (l.balance !== START - stakesIn + payouts) return false;
          if (l.balance < 0n) return false;
          for (const p of l.positions) {
            if (p.units < 0n || p.paid < 0n) return false;
            if (p.paid > payoutCap(cfg, p.stake)) return false;
            if (!p.open && p.units !== 0n) return false;
            if (p.open && p.units === 0n) return false;
          }
        }
        return true;
      }),
      { numRuns: 3000 },
    );
  });

  it("gains nothing by splitting a stake or a sale", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 100_000n, max: 1_000_000n }),
        fc.integer({ min: 2, max: 4 }),
        fc.bigInt({ min: 1_000_000n, max: 500n * X }),
        fc.bigInt({ min: 1_000_000n, max: 150n * X }),
        fc.array(fc.bigInt({ min: 1n, max: 9_999n }), { minLength: 1, maxLength: 12 }),
        (stake, parts, buyPrice, sellPrice, fractions) => {
          const whole = new Ledger(cfg, START);
          const w = whole.buy(0, stake, STATUS_ALIVE, buyPrice, 0);
          if (!w.ok) return true;
          whole.onTick(0, STATUS_ALIVE, sellPrice);
          if (w.value.open) whole.sell(w.value.id, 10_000n, STATUS_ALIVE, sellPrice);

          // Same money split into several buys, then sold in many small pieces.
          const split = new Ledger(cfg, START);
          const piece = stake / BigInt(parts);
          const ids: number[] = [];
          for (let i = 0; i < parts; i++) {
            const part = i === parts - 1 ? stake - piece * BigInt(parts - 1) : piece;
            const r = split.buy(0, part, STATUS_ALIVE, buyPrice, 0);
            if (!r.ok) return true;
            ids.push(r.value.id);
          }
          split.onTick(0, STATUS_ALIVE, sellPrice);
          for (const id of ids) {
            for (const f of fractions) split.sell(id, f, STATUS_ALIVE, sellPrice);
            split.sell(id, 10_000n, STATUS_ALIVE, sellPrice);
          }
          return split.balance <= whole.balance;
        },
      ),
      { numRuns: 2000 },
    );
  });
});
