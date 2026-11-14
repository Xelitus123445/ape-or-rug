// Strategy simulator core. Decision rules live here (they may look at anything
// a player can see); prices come from the real engine and money from the
// engine's accounting functions.

import {
  CoinStream,
  EVENT_DEV_SOLD,
  EVENT_WHALE_IN,
  PRICE_SCALE,
  RoundKey,
  STATUS_ALIVE,
  STATUS_RUGGED,
  STATUS_SETTLED,
  UNIT_SCALE,
  capTriggerPrice,
  ceilDiv,
  entryFee,
  launchCoin,
  payoutCap,
  roundProfiles,
  sha256,
  stepCoin,
  unitsFor,
  valueOf,
} from "@ape/engine";
import type { Engine } from "@ape/engine";

export const ENTRY_START = 0;
export const ENTRY_RANDOM = 1;
export const ENTRY_WHALE = 2;

export const EXIT_TARGET = 0;
export const EXIT_HOLD = 1;
export const EXIT_TRAIL = 2;
export const EXIT_DOWN3 = 3;
export const EXIT_DEV_SOLD = 4;
export const EXIT_INITIALS = 5;
export const EXIT_NEVER = 6;
export const EXIT_RANDOM = 7;
export const EXIT_WHALE_END = 8;

export interface Strategy {
  readonly name: string;
  readonly entry: number;
  readonly exit: number;
  /** Target in tenths of x, hold ticks, or trailing stop percent. */
  readonly param: number;
}

function exits(prefix: string, entry: number): Strategy[] {
  const s = (name: string, exit: number, param = 0): Strategy => ({ name: prefix + name, entry, exit, param });
  return [
    s("target 1.5x", EXIT_TARGET, 15),
    s("target 2x", EXIT_TARGET, 20),
    s("target 5x", EXIT_TARGET, 50),
    s("target 10x", EXIT_TARGET, 100),
    s("target 50x", EXIT_TARGET, 500),
    s("hold 10 ticks", EXIT_HOLD, 10),
    s("hold 40 ticks", EXIT_HOLD, 40),
    s("hold 200 ticks", EXIT_HOLD, 200),
    s("trailing stop 10%", EXIT_TRAIL, 10),
    s("trailing stop 20%", EXIT_TRAIL, 20),
    s("trailing stop 40%", EXIT_TRAIL, 40),
    s("3 down ticks in profit", EXIT_DOWN3),
    s("sell on DEV_SOLD", EXIT_DEV_SOLD),
    s("initials at 2x, hold rest", EXIT_INITIALS),
    s("hold to cap or rug", EXIT_NEVER),
    s("random exit (1/50 per tick)", EXIT_RANDOM),
  ];
}

export const STRATEGIES: readonly Strategy[] = [
  ...exits("", ENTRY_START),
  ...exits("mid-round entry: ", ENTRY_RANDOM),
  { name: "buy on WHALE_IN: sell when it ends", entry: ENTRY_WHALE, exit: EXIT_WHALE_END, param: 0 },
  { name: "buy on WHALE_IN: sell on DEV_SOLD", entry: ENTRY_WHALE, exit: EXIT_DEV_SOLD, param: 0 },
  { name: "buy on WHALE_IN: target 2x", entry: ENTRY_WHALE, exit: EXIT_TARGET, param: 20 },
  { name: "buy on WHALE_IN: hold to cap or rug", entry: ENTRY_WHALE, exit: EXIT_NEVER, param: 0 },
];

/** Strategies whose per-round house result is recorded for the risk report. */
export const RISK_STRATEGIES = ["hold to cap or rug", "target 10x", "trailing stop 20%"] as const;

export const STAKE = 100_000n;
/** Mid-round entry happens at a uniformly random tick in 1..RANDOM_ENTRY_SPAN. */
export const RANDOM_ENTRY_SPAN = 80;

export const STAT_FIELDS = 6; // n, sum, sumsq, sumUncapped, sumsqUncapped, capHits
export const PROFILES = 3;

export interface TraceAction {
  readonly tick: number;
  readonly kind: "buy" | "sell" | "initials";
}

export interface ChunkResult {
  /** [strategy][profile][field] */
  stats: Float64Array;
  /** Coin life in ticks: [profile][ticks] */
  lifeHist: Uint32Array;
  /** Round length (longest coin) in ticks */
  roundHist: Uint32Array;
  graduated: Uint32Array;
  settled: Uint32Array;
  coins: Uint32Array;
  /** Per round, per risk strategy: sum over the round's coins of (1 - payout/stake) */
  housePerRound: Float32Array;
  ticks: number;
}

export function seedForRound(baseSeed: Uint8Array, round: number): Uint8Array {
  const buf = new Uint8Array(40);
  buf.set(baseSeed);
  // Rounds stay far below 2^32.
  buf[36] = (round >>> 24) & 255;
  buf[37] = (round >>> 16) & 255;
  buf[38] = (round >>> 8) & 255;
  buf[39] = round & 255;
  return sha256(buf);
}

export function roundIdFor(round: number): string {
  return `s${round}`;
}

const WAITING = 0;
const ACTIVE = 1;
const DONE = 2;

/**
 * Simulates `rounds` rounds starting at round index `first`. Every strategy
 * places at most one bet per coin. With `trace`, records each strategy's
 * actions and final payout for cross-checking against the Ledger class.
 */
export function simulateChunk(
  engine: Engine,
  baseSeed: Uint8Array,
  first: number,
  rounds: number,
  trace?: (round: number, coin: number, strategy: number, actions: TraceAction[], paid: bigint) => void,
): ChunkResult {
  const config = engine.config;
  const S = STRATEGIES.length;
  const maxTicks = config.maxTicks;
  const coinsPerRound = config.coinsPerRound;
  const stakeNum = Number(STAKE);
  const fee = entryFee(config, STAKE);
  const net = STAKE - fee;
  const cap = payoutCap(config, STAKE);

  const stats = new Float64Array(S * PROFILES * STAT_FIELDS);
  const lifeHist = new Uint32Array(PROFILES * (maxTicks + 1));
  const roundHist = new Uint32Array(maxTicks + 1);
  const graduated = new Uint32Array(PROFILES);
  const settled = new Uint32Array(PROFILES);
  const coinCount = new Uint32Array(PROFILES);
  const riskIndex = RISK_STRATEGIES.map((name) => STRATEGIES.findIndex((s) => s.name === name));
  const housePerRound = new Float32Array(rounds * riskIndex.length);
  let totalTicks = 0;

  const state = new Uint8Array(S);
  const units: bigint[] = new Array(S).fill(0n);
  const paid: bigint[] = new Array(S).fill(0n);
  const uncapped: bigint[] = new Array(S).fill(0n);
  const capPrice: bigint[] = new Array(S).fill(0n);
  const entryPrice: bigint[] = new Array(S).fill(0n);
  const mark: bigint[] = new Array(S).fill(0n); // target price or running peak
  const breakEven: bigint[] = new Array(S).fill(0n);
  const held = new Int32Array(S);
  const downs = new Int32Array(S);
  const flag = new Uint8Array(S);
  const capHit = new Uint8Array(S);
  const actions: TraceAction[][] = STRATEGIES.map(() => []);

  let rng = 1;
  const nextRandom = (): number => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return rng >>> 0;
  };

  const enter = (s: number, price: bigint, tick: number): void => {
    const u = unitsFor(net, price);
    if (u <= 0n) {
      state[s] = DONE;
      flag[s] = 2; // no bet
      return;
    }
    state[s] = ACTIVE;
    units[s] = u;
    paid[s] = 0n;
    entryPrice[s] = price;
    capPrice[s] = capTriggerPrice(cap, u);
    breakEven[s] = ceilDiv(STAKE * UNIT_SCALE, u);
    held[s] = 0;
    downs[s] = 0;
    flag[s] = 0;
    const strat = STRATEGIES[s]!;
    if (strat.exit === EXIT_TARGET || strat.exit === EXIT_INITIALS) {
      const tenths = strat.exit === EXIT_INITIALS ? 20n : BigInt(strat.param);
      mark[s] = ceilDiv(price * tenths, 10n);
    } else {
      mark[s] = price;
    }
    if (trace) actions[s]!.push({ tick, kind: "buy" });
  };

  for (let r = 0; r < rounds; r++) {
    const round = first + r;
    const key = new RoundKey(seedForRound(baseSeed, round), roundIdFor(round));
    const profiles = roundProfiles(key, coinsPerRound);
    let roundLife = 0;

    for (let coin = 0; coin < coinsPerRound; coin++) {
      const stream = new CoinStream(key, coin);
      const c = launchCoin(profiles[coin]!);
      rng = (Math.imul(round * coinsPerRound + coin + 1, 0x9e3779b1) ^ 0x5bd1e995) | 0;
      if (rng === 0) rng = 1;
      const randomEntryTick = 1 + (nextRandom() % RANDOM_ENTRY_SPAN);

      for (let s = 0; s < S; s++) {
        state[s] = WAITING;
        capHit[s] = 0;
        flag[s] = 2;
        paid[s] = 0n;
        uncapped[s] = 0n;
        if (trace) actions[s] = [];
        if (STRATEGIES[s]!.entry === ENTRY_START) enter(s, c.price, 0);
      }

      let prevPrice = c.price;
      while (c.status === STATUS_ALIVE) {
        stepCoin(engine, stream, c);
        const price = c.price;
        const tick = c.tick;
        const status: number = c.status;
        const rugged = status === STATUS_RUGGED;
        const settledNow = status === STATUS_SETTLED;
        const down = price < prevPrice;
        const lucky = nextRandom() % 50 === 0;

        for (let s = 0; s < S; s++) {
          const st = state[s]!;
          if (st === DONE) continue;
          const strat = STRATEGIES[s]!;
          if (st === WAITING) {
            if (rugged || settledNow) {
              state[s] = DONE;
            } else if (strat.entry === ENTRY_RANDOM) {
              if (tick === randomEntryTick) enter(s, price, tick);
            } else if (c.eventStarted && c.tickEvent === EVENT_WHALE_IN) {
              enter(s, price, tick);
            }
            continue;
          }
          // Active position: rug, cap and settlement come before any order.
          if (rugged) {
            uncapped[s] = paid[s]!;
            state[s] = DONE;
            continue;
          }
          if (price >= capPrice[s]!) {
            uncapped[s] = paid[s]! + valueOf(units[s]!, price);
            paid[s] = cap;
            capHit[s] = 1;
            state[s] = DONE;
            continue;
          }
          if (settledNow) {
            paid[s] = paid[s]! + valueOf(units[s]!, price);
            uncapped[s] = paid[s]!;
            state[s] = DONE;
            continue;
          }
          held[s]!++;
          let sell = false;
          switch (strat.exit) {
            case EXIT_TARGET:
              sell = price >= mark[s]!;
              break;
            case EXIT_HOLD:
              sell = held[s]! >= strat.param;
              break;
            case EXIT_TRAIL:
              if (price > mark[s]!) mark[s] = price;
              else sell = price * 100n <= mark[s]! * BigInt(100 - strat.param);
              break;
            case EXIT_DOWN3:
              downs[s] = down ? downs[s]! + 1 : 0;
              sell = downs[s]! >= 3 && price > breakEven[s]!;
              break;
            case EXIT_DEV_SOLD:
              sell = c.tickEvent === EVENT_DEV_SOLD;
              break;
            case EXIT_INITIALS:
              if (flag[s] === 0 && price >= mark[s]!) {
                const need = STAKE - paid[s]!;
                const u = ceilDiv(need * UNIT_SCALE, price);
                if (u < units[s]!) {
                  units[s] = units[s]! - u;
                  paid[s] = paid[s]! + need;
                  capPrice[s] = capTriggerPrice(cap - paid[s]!, units[s]!);
                  flag[s] = 1;
                  if (trace) actions[s]!.push({ tick, kind: "initials" });
                }
              }
              break;
            case EXIT_RANDOM:
              sell = lucky;
              break;
            case EXIT_WHALE_END:
              sell = c.event !== EVENT_WHALE_IN;
              break;
            default:
              break;
          }
          if (sell) {
            paid[s] = paid[s]! + valueOf(units[s]!, price);
            uncapped[s] = paid[s]!;
            state[s] = DONE;
            if (trace) actions[s]!.push({ tick, kind: "sell" });
          }
        }
        prevPrice = price;
      }

      const profile = c.profile;
      const base = profile * STAT_FIELDS;
      for (let s = 0; s < S; s++) {
        const placed = flag[s] !== 2;
        if (trace && placed) trace(round, coin, s, actions[s]!, paid[s]!);
        if (!placed) continue;
        const x = Number(paid[s]!) / stakeNum;
        const xu = Number(uncapped[s]!) / stakeNum;
        const o = s * PROFILES * STAT_FIELDS + base;
        stats[o]! += 1;
        stats[o + 1]! += x;
        stats[o + 2]! += x * x;
        stats[o + 3]! += xu;
        stats[o + 4]! += xu * xu;
        stats[o + 5]! += capHit[s]!;
      }
      for (let k = 0; k < riskIndex.length; k++) {
        housePerRound[r * riskIndex.length + k]! += 1 - Number(paid[riskIndex[k]!]!) / stakeNum;
      }
      coinCount[profile]!++;
      lifeHist[profile * (maxTicks + 1) + c.tick]!++;
      if (c.graduated) graduated[profile]!++;
      if (c.status === STATUS_SETTLED) settled[profile]!++;
      if (c.tick > roundLife) roundLife = c.tick;
      totalTicks += c.tick;
    }
    roundHist[roundLife]!++;
  }

  return { stats, lifeHist, roundHist, graduated, settled, coins: coinCount, housePerRound, ticks: totalTicks };
}

export { PRICE_SCALE };
