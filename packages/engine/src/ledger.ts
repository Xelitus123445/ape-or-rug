// Position accounting. Reads prices, never writes them: fees and caps act on
// the position only. All money is BigInt minor units and every rounding step
// goes against the player (math spec 10.4).

import { BPS, STATUS_ALIVE, STATUS_RUGGED, STATUS_SETTLED, UNIT_SCALE } from "./config.ts";
import type { EngineConfig } from "./config.ts";

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Entry fee, rounded up. */
export function entryFee(config: EngineConfig, stake: bigint): bigint {
  return ceilDiv(stake * config.entryFeeBps, BPS);
}

/** Units bought with `net` at `price`, rounded down. */
export function unitsFor(net: bigint, price: bigint): bigint {
  return (net * UNIT_SCALE) / price;
}

/** Value of `units` at `price` in minor units, rounded down. */
export function valueOf(units: bigint, price: bigint): bigint {
  return (units * price) / UNIT_SCALE;
}

/** Most a position can ever pay in total. */
export function payoutCap(config: EngineConfig, stake: bigint): bigint {
  return config.maxPayoutMult * stake;
}

/** Lowest price at which `units` are worth at least `capRemaining`. */
export function capTriggerPrice(capRemaining: bigint, units: bigint): bigint {
  return ceilDiv(capRemaining * UNIT_SCALE, units);
}

export interface Position {
  readonly id: number;
  readonly coin: number;
  readonly stake: bigint;
  readonly fee: bigint;
  readonly entryPrice: bigint;
  readonly entryTick: number;
  units: bigint;
  /** Total paid out so far. */
  paid: bigint;
  open: boolean;
  /** Why it closed: "sold", "rug", "settled", "cap". */
  closedBy: string | null;
}

export type LedgerError =
  | "bad_stake"
  | "stake_below_min"
  | "stake_above_max"
  | "insufficient_balance"
  | "coin_not_alive"
  | "price_too_low"
  | "no_such_position"
  | "position_closed"
  | "bad_fraction"
  | "amount_too_small"
  | "initials_unavailable";

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: LedgerError };

export interface SellOutcome {
  readonly positionId: number;
  readonly payout: bigint;
  readonly closed: boolean;
  readonly reason: "sold" | "initials" | "settled" | "cap" | "rug";
}

const fail = (error: LedgerError): Result<never> => ({ ok: false, error });

/**
 * One player's balance and positions. `house` mirrors every movement, so
 * balance + house is constant for the life of the ledger.
 */
export class Ledger {
  balance: bigint;
  house: bigint = 0n;
  readonly positions: Position[] = [];
  private readonly config: EngineConfig;
  private nextId = 1;

  constructor(config: EngineConfig, startBalance: bigint) {
    this.config = config;
    this.balance = startBalance;
  }

  get(id: number): Position | undefined {
    return this.positions.find((p) => p.id === id);
  }

  /** Buy at the current tick's price. Rejected unless the coin is alive. */
  buy(coin: number, stake: bigint, coinStatus: number, price: bigint, tick: number): Result<Position> {
    if (typeof stake !== "bigint") return fail("bad_stake");
    if (stake < this.config.minStake) return fail("stake_below_min");
    if (stake > this.config.maxStake) return fail("stake_above_max");
    if (stake > this.balance) return fail("insufficient_balance");
    if (coinStatus !== STATUS_ALIVE) return fail("coin_not_alive");
    if (price <= 0n) return fail("price_too_low");
    const fee = entryFee(this.config, stake);
    const units = unitsFor(stake - fee, price);
    if (units <= 0n) return fail("price_too_low");
    const pos: Position = {
      id: this.nextId++,
      coin,
      stake,
      fee,
      entryPrice: price,
      entryTick: tick,
      units,
      paid: 0n,
      open: true,
      closedBy: null,
    };
    this.balance -= stake;
    this.house += stake;
    this.positions.push(pos);
    return { ok: true, value: pos };
  }

  private pay(pos: Position, unitsSold: bigint, payout: bigint): void {
    pos.units -= unitsSold;
    pos.paid += payout;
    this.balance += payout;
    this.house -= payout;
  }

  private close(pos: Position, reason: string): void {
    pos.units = 0n;
    pos.open = false;
    pos.closedBy = reason;
  }

  /** Sell `bps` / 10000 of the position's current units at `price`. */
  sell(positionId: number, bps: bigint, coinStatus: number, price: bigint): Result<SellOutcome> {
    const pos = this.get(positionId);
    if (pos === undefined) return fail("no_such_position");
    if (!pos.open) return fail("position_closed");
    if (typeof bps !== "bigint" || bps < 1n || bps > BPS) return fail("bad_fraction");
    if (coinStatus !== STATUS_ALIVE) return fail("coin_not_alive");
    const unitsSold = bps === BPS ? pos.units : (pos.units * bps) / BPS;
    if (unitsSold <= 0n) return fail("amount_too_small");
    const capLeft = payoutCap(this.config, pos.stake) - pos.paid;
    let payout = valueOf(unitsSold, price);
    if (payout >= capLeft) {
      this.pay(pos, pos.units, capLeft);
      this.close(pos, "cap");
      return { ok: true, value: { positionId, payout: capLeft, closed: true, reason: "cap" } };
    }
    if (payout < 0n) payout = 0n;
    this.pay(pos, unitsSold, payout);
    const closed = pos.units === 0n;
    if (closed) this.close(pos, "sold");
    return { ok: true, value: { positionId, payout, closed, reason: "sold" } };
  }

  /** Units that must be sold at `price` to bring total payouts up to the stake, or null if not available. */
  initialsUnits(pos: Position, price: bigint): bigint | null {
    if (!pos.open || price <= 0n) return null;
    const need = pos.stake - pos.paid;
    if (need <= 0n) return null;
    const units = ceilDiv(need * UNIT_SCALE, price);
    return units < pos.units ? units : null;
  }

  /** Take initials: sell exactly enough to get the original stake back, keep the rest. */
  takeInitials(positionId: number, coinStatus: number, price: bigint): Result<SellOutcome> {
    const pos = this.get(positionId);
    if (pos === undefined) return fail("no_such_position");
    if (!pos.open) return fail("position_closed");
    if (coinStatus !== STATUS_ALIVE) return fail("coin_not_alive");
    const units = this.initialsUnits(pos, price);
    if (units === null) return fail("initials_unavailable");
    const payout = pos.stake - pos.paid;
    this.pay(pos, units, payout);
    return { ok: true, value: { positionId, payout, closed: false, reason: "initials" } };
  }

  /**
   * Apply one tick of a coin to its open positions, before any order of that
   * tick: a rug wipes them, a settlement sells them, the payout cap sells
   * them at exactly the cap.
   */
  onTick(coin: number, coinStatus: number, price: bigint): SellOutcome[] {
    const out: SellOutcome[] = [];
    for (const pos of this.positions) {
      if (!pos.open || pos.coin !== coin) continue;
      if (coinStatus === STATUS_RUGGED) {
        this.close(pos, "rug");
        out.push({ positionId: pos.id, payout: 0n, closed: true, reason: "rug" });
        continue;
      }
      const capLeft = payoutCap(this.config, pos.stake) - pos.paid;
      const value = valueOf(pos.units, price);
      if (value >= capLeft) {
        this.pay(pos, pos.units, capLeft);
        this.close(pos, "cap");
        out.push({ positionId: pos.id, payout: capLeft, closed: true, reason: "cap" });
      } else if (coinStatus === STATUS_SETTLED) {
        this.pay(pos, pos.units, value);
        this.close(pos, "settled");
        out.push({ positionId: pos.id, payout: value, closed: true, reason: "settled" });
      }
    }
    return out;
  }
}
