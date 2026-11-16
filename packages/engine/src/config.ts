// Every tunable number of the game lives here. Integers and exact rationals
// only: the engine never sees a float.

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export interface ProfileConfig {
  /** Rug probability per tick. */
  readonly hazard: Rational;
  /** Volatility per tick in parts per million (0.060 = 60000). */
  readonly sigmaPpm: bigint;
}

export interface EventConfig {
  readonly hMul: Rational;
  readonly sMul: Rational;
}

export const PROFILE_NAMES = ["degen", "mid", "runner"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/** Index 0 is "no event". */
export const EVENT_NAMES = ["NONE", "DEV_SOLD", "WHALE_IN", "KOL_TWEET"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const EVENT_NONE = 0;
export const EVENT_DEV_SOLD = 1;
export const EVENT_WHALE_IN = 2;
export const EVENT_KOL_TWEET = 3;

export const STATUS_ALIVE = 0;
export const STATUS_RUGGED = 1;
export const STATUS_SETTLED = 2;

/** 1.00x as an integer price. */
export const PRICE_SCALE = 1_000_000_000n;
/** Position units carry 18 decimal digits: value = units * price / UNIT_SCALE. */
export const UNIT_SCALE = 1_000_000_000_000_000_000n;
export const TWO_32 = 4_294_967_296n;
export const BPS = 10_000n;
/** Growth table size; a tick draws a 10-bit index. */
export const TABLE_SIZE = 1024;

export interface EngineConfig {
  readonly ticksPerSecond: number;
  readonly maxTicks: number;
  readonly coinsPerRound: number;
  /** Order matches PROFILE_NAMES. */
  readonly profiles: readonly [ProfileConfig, ProfileConfig, ProfileConfig];
  /** Order matches EVENT_NAMES without NONE: DEV_SOLD, WHALE_IN, KOL_TWEET. */
  readonly events: readonly [EventConfig, EventConfig, EventConfig];
  /** Probability per tick that an event starts while none is active. */
  readonly eventStart: Rational;
  readonly eventMinTicks: number;
  readonly eventMaxTicks: number;
  readonly graduation: {
    /** Price at which a coin graduates (10x). */
    readonly price: bigint;
    readonly hMul: Rational;
    readonly sMul: Rational;
  };
  /** Entry fee in basis points (300 = 3%). */
  readonly entryFeeBps: bigint;
  readonly maxPayoutMult: bigint;
  /** Stakes are in minor units, 1/100 of a play coin. */
  readonly minStake: bigint;
  readonly maxStake: bigint;
}

const r = (num: bigint, den: bigint): Rational => Object.freeze({ num, den });
const freezeAll = <T extends object>(items: readonly T[]): readonly T[] => Object.freeze(items.map((x) => Object.freeze(x)));

/** Frozen at every level: every default engine and Ledger share it. */
export const DEFAULT_CONFIG: EngineConfig = Object.freeze({
  ticksPerSecond: 4,
  maxTicks: 2400,
  coinsPerRound: 3,
  profiles: freezeAll([
    { hazard: r(1n, 160n), sigmaPpm: 60_000n },
    { hazard: r(1n, 360n), sigmaPpm: 35_000n },
    { hazard: r(1n, 720n), sigmaPpm: 20_000n },
  ]) as EngineConfig["profiles"],
  events: freezeAll([
    { hMul: r(3n, 1n), sMul: r(3n, 2n) },
    { hMul: r(1n, 2n), sMul: r(13n, 10n) },
    { hMul: r(1n, 1n), sMul: r(2n, 1n) },
  ]) as EngineConfig["events"],
  eventStart: r(1n, 120n),
  eventMinTicks: 20,
  eventMaxTicks: 40,
  graduation: Object.freeze({
    price: 10n * PRICE_SCALE,
    hMul: r(1n, 2n),
    sMul: r(7n, 10n),
  }),
  entryFeeBps: 300n,
  maxPayoutMult: 200n,
  // 250.00 play coins: with at most 2 minor units lost to rounding per bet
  // this keeps rounding loss below 0.01% of stake (math spec 10.4).
  minStake: 25_000n,
  maxStake: 1_000_000n,
});

export const REGIME_COUNT = 24;

/** Regime index: profile * 8 + event * 2 + graduated. */
export function regimeIndex(profile: number, event: number, graduated: boolean): number {
  return profile * 8 + event * 2 + (graduated ? 1 : 0);
}

export interface RegimeParams {
  /** Rug threshold: rug if a 32-bit draw is below H. */
  readonly H: bigint;
  /** Volatility per tick in parts per billion. */
  readonly sigmaPpb: bigint;
}

/** Exact integer parameters of every regime, derived from the config. */
export function regimeParams(config: EngineConfig): RegimeParams[] {
  const out: RegimeParams[] = [];
  for (let p = 0; p < 3; p++) {
    const prof = config.profiles[p]!;
    for (let e = 0; e < 4; e++) {
      for (let g = 0; g < 2; g++) {
        let hNum = prof.hazard.num;
        let hDen = prof.hazard.den;
        let sNum = prof.sigmaPpm * 1000n;
        let sDen = 1n;
        if (e > 0) {
          const ev = config.events[e - 1]!;
          hNum *= ev.hMul.num;
          hDen *= ev.hMul.den;
          sNum *= ev.sMul.num;
          sDen *= ev.sMul.den;
        }
        if (g === 1) {
          hNum *= config.graduation.hMul.num;
          hDen *= config.graduation.hMul.den;
          sNum *= config.graduation.sMul.num;
          sDen *= config.graduation.sMul.den;
        }
        out.push({ H: (TWO_32 * hNum) / hDen, sigmaPpb: sNum / sDen });
      }
    }
  }
  return out;
}
