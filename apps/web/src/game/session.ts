// One player's game session: runs rounds locally with the real engine and the
// real Ledger. No clock in here; the UI calls clock() once per tick interval.

import {
  BPS,
  CoinStream,
  DEFAULT_CONFIG,
  EVENT_NONE,
  Ledger,
  PRICE_SCALE,
  RoundKey,
  STATUS_ALIVE,
  STATUS_RUGGED,
  STATUS_SETTLED,
  commitOf,
  createEngine,
  generateRound,
  launchCoin,
  roundHash,
  roundProfiles,
  snapshot,
  stepCoin,
  toHex,
  valueOf,
  verifyCommit,
} from "@ape/engine";
import type { CoinState, Engine, LedgerError, Position, Round, TickRecord } from "@ape/engine";
import { COIN_BANK } from "./coinBank.ts";
import type { CoinIdea } from "./coinBank.ts";

export interface Pace {
  readonly id: string;
  readonly ticksPerSecond: number;
}

/** Pace only changes how fast ticks are shown. The math is per tick, so every pace is the same game. */
export const PACES: readonly Pace[] = [
  { id: "chill", ticksPerSecond: 4 },
  { id: "fast", ticksPerSecond: 6 },
  { id: "turbo", ticksPerSecond: 8 },
];

export const START_BALANCE = 10_000_000n; // 100,000.00 USDK
export const STAKES: readonly bigint[] = [25_000n, 50_000n, 100_000n, 250_000n, 500_000n, 1_000_000n];
export const COUNTDOWN_SECONDS = 5;
export const NEXT_ROUND_SECONDS = 12;

export type Phase = "countdown" | "live" | "ended";

export interface CoinMeta extends CoinIdea {
  readonly hue: number;
}

export interface LiveCoin {
  readonly index: number;
  readonly meta: CoinMeta;
  readonly state: CoinState;
  /** Multiplier per tick as a float, for drawing only. */
  readonly history: number[];
  readonly records: TickRecord[];
  /** Ticks at which the player bought or sold, for chart markers. */
  readonly marks: { tick: number; kind: "buy" | "sell" }[];
  /** Last price before the rug, for the summary. */
  lastAlivePrice: bigint;
}

export type FeedKind = "buy" | "sell" | "initials" | "rug" | "lost" | "event" | "graduated" | "cap" | "settled";

export interface FeedItem {
  readonly id: number;
  readonly kind: FeedKind;
  readonly coin: number;
  readonly tick: number;
  /** Coin price at that moment. */
  readonly price: bigint;
  readonly amount?: bigint;
  readonly event?: number;
}

export interface Summary {
  readonly net: bigint;
  readonly staked: bigint;
  readonly ticks: number;
  readonly best: { coin: number; price: bigint } | null;
  readonly worst: { coin: number; price: bigint } | null;
}

export interface Verification {
  readonly commitOk: boolean;
  readonly roundOk: boolean;
  readonly playedHash: string;
  readonly recomputedHash: string;
}

export interface CoinHolding {
  readonly positions: Position[];
  readonly stake: bigint;
  readonly paid: bigint;
  readonly value: bigint;
  readonly canInitials: boolean;
}

export type ActionResult = { ok: true } | { ok: false; error: LedgerError | "round_not_open" };

function cosmetics(stream: CoinStream, taken: Set<number>): CoinMeta {
  const w = new Int32Array(8);
  // Cosmetic digest: far away from the digests the price uses.
  stream.digest(0, 9000, w);
  let pick = (w[0]! >>> 0) % COIN_BANK.length;
  while (taken.has(pick)) pick = (pick + 1) % COIN_BANK.length;
  taken.add(pick);
  return { ...COIN_BANK[pick]!, hue: (w[1]! >>> 0) % 360 };
}

export class GameSession {
  readonly engine: Engine = createEngine();
  version = 0;
  phase: Phase = "countdown";
  /** Ticks of waiting left in the countdown or before the next round. */
  wait = 0;
  pace: Pace = PACES[1]!;
  roundNo = 0;
  roundId = "";
  commit = "";
  /** Hex seed, shown only after the round has ended. */
  revealedSeed: string | null = null;
  coins: LiveCoin[] = [];
  ledger: Ledger = new Ledger(DEFAULT_CONFIG, START_BALANCE);
  feed: FeedItem[] = [];
  summary: Summary | null = null;
  roundsPlayed = 0;
  ticksPlayed = 0;
  firstRugSeen = false;

  private readonly newSeed: () => Uint8Array;
  private seed: Uint8Array | null = null;
  private streams: CoinStream[] = [];
  private roundStartBalance = START_BALANCE;
  private staked = 0n;
  private feedId = 0;
  private best: { coin: number; price: bigint } | null = null;
  private worst: { coin: number; price: bigint } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(newSeed: () => Uint8Array) {
    this.newSeed = newSeed;
    this.prepareRound();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get balance(): bigint {
    return this.ledger.balance;
  }

  get tick(): number {
    let t = 0;
    for (const c of this.coins) if (c.state.tick > t) t = c.state.tick;
    return t;
  }

  /** Whole seconds left in the current wait, rounded up. */
  get waitSeconds(): number {
    const tps = this.pace.ticksPerSecond;
    return (this.wait + tps - 1 - ((this.wait + tps - 1) % tps)) / tps;
  }

  setPace(id: string): void {
    const next = PACES.find((p) => p.id === id);
    if (next === undefined || next === this.pace) return;
    // Keep the remaining wait the same number of seconds.
    const seconds = this.waitSeconds;
    this.pace = next;
    if (this.phase !== "live") this.wait = seconds * next.ticksPerSecond;
    this.changed();
  }

  /** Commits to a fresh seed and launches three coins at 1.00x. Buying is open during the countdown. */
  prepareRound(): void {
    const seed = this.newSeed();
    this.seed = seed;
    this.roundNo++;
    this.roundId = `solo-${this.roundNo}`;
    this.commit = commitOf(seed);
    this.revealedSeed = null;
    const key = new RoundKey(seed, this.roundId);
    const taken = new Set<number>();
    const profiles = roundProfiles(key, this.engine.config.coinsPerRound);
    this.streams = [];
    this.coins = [];
    for (let i = 0; i < this.engine.config.coinsPerRound; i++) {
      const stream = new CoinStream(key, i);
      const state = launchCoin(profiles[i]!);
      this.streams.push(stream);
      this.coins.push({ index: i, meta: cosmetics(stream, taken), state, history: [1], records: [snapshot(state)], marks: [], lastAlivePrice: state.price });
    }
    this.ledger = new Ledger(DEFAULT_CONFIG, this.ledger.balance);
    this.roundStartBalance = this.ledger.balance;
    this.staked = 0n;
    this.feed = [];
    this.summary = null;
    this.best = null;
    this.worst = null;
    this.phase = "countdown";
    this.wait = COUNTDOWN_SECONDS * this.pace.ticksPerSecond;
    this.changed();
  }

  /** Called by the UI once per tick interval. */
  clock(): void {
    if (this.phase === "live") {
      this.playTick();
      return;
    }
    this.wait--;
    if (this.wait <= 0) {
      if (this.phase === "countdown") this.phase = "live";
      else {
        this.prepareRound();
        return;
      }
    }
    this.changed();
  }

  skipWait(): void {
    if (this.phase === "ended") this.prepareRound();
    else if (this.phase === "countdown") {
      this.phase = "live";
      this.changed();
    }
  }

  private push(kind: FeedKind, coin: number, extra: { amount?: bigint; event?: number; price?: bigint } = {}): void {
    const c = this.coins[coin]!;
    this.feed.unshift({ id: ++this.feedId, kind, coin, tick: c.state.tick, price: extra.price ?? c.state.price, amount: extra.amount, event: extra.event });
    if (this.feed.length > 60) this.feed.length = 60;
  }

  private playTick(): void {
    let alive = 0;
    for (const coin of this.coins) {
      const c = coin.state;
      if (c.status !== STATUS_ALIVE) continue;
      const before = c.price;
      stepCoin(this.engine, this.streams[coin.index]!, c);
      this.ticksPlayed++;
      coin.records.push(snapshot(c));
      coin.history.push(Number(c.price) / Number(PRICE_SCALE));
      // Truthful events: each feed line mirrors a regime change the engine just made.
      if (c.eventStarted) this.push("event", coin.index, { event: c.tickEvent });
      if (c.justGraduated) this.push("graduated", coin.index);
      const status: number = c.status;
      if (status === STATUS_RUGGED) {
        this.push("rug", coin.index, { price: before });
        this.firstRugSeen = true;
      } else coin.lastAlivePrice = c.price;

      for (const o of this.ledger.onTick(coin.index, c.status, c.price)) {
        if (o.reason === "rug") {
          const pos = this.ledger.get(o.positionId)!;
          this.push("lost", coin.index, { amount: pos.stake - pos.paid, price: before });
          if (this.worst === null || before > this.worst.price) this.worst = { coin: coin.index, price: before };
        } else {
          this.push(o.reason === "cap" ? "cap" : "settled", coin.index, { amount: o.payout });
          this.noteSale(coin.index, c.price);
        }
      }
      if (c.status === STATUS_ALIVE) alive++;
    }
    if (alive === 0) this.endRound();
    this.changed();
  }

  private noteSale(coin: number, price: bigint): void {
    if (this.best === null || price > this.best.price) this.best = { coin, price };
  }

  private endRound(): void {
    this.phase = "ended";
    this.roundsPlayed++;
    this.revealedSeed = toHex(this.seed!);
    this.summary = {
      net: this.ledger.balance - this.roundStartBalance,
      staked: this.staked,
      ticks: this.tick,
      best: this.best,
      worst: this.worst,
    };
    this.wait = NEXT_ROUND_SECONDS * this.pace.ticksPerSecond;
  }

  holding(coin: number): CoinHolding {
    const c = this.coins[coin]!.state;
    const positions = this.ledger.positions.filter((p) => p.coin === coin);
    let stake = 0n, paid = 0n, value = 0n, canInitials = false;
    for (const p of positions) {
      stake += p.stake;
      paid += p.paid;
      if (p.open) {
        value += valueOf(p.units, c.price);
        if (this.ledger.initialsUnits(p, c.price) !== null) canInitials = true;
      }
    }
    return { positions, stake, paid, value, canInitials };
  }

  buy(coin: number, stake: bigint): ActionResult {
    if (this.phase === "ended") return { ok: false, error: "round_not_open" };
    const c = this.coins[coin]!;
    const r = this.ledger.buy(coin, stake, c.state.status, c.state.price, c.state.tick);
    if (!r.ok) return r;
    this.staked += stake;
    c.marks.push({ tick: c.state.tick, kind: "buy" });
    this.push("buy", coin, { amount: stake });
    this.changed();
    return { ok: true };
  }

  /** Sell `bps` / 10000 of every open position in the coin. */
  sell(coin: number, bps: bigint): ActionResult {
    const c = this.coins[coin]!;
    let total = 0n;
    let sold = false;
    let last: ActionResult = { ok: false, error: "no_such_position" };
    for (const p of this.ledger.positions) {
      if (!p.open || p.coin !== coin) continue;
      const r = this.ledger.sell(p.id, bps, c.state.status, c.state.price);
      if (r.ok) {
        total += r.value.payout;
        sold = true;
      } else last = r;
    }
    if (!sold) return last;
    c.marks.push({ tick: c.state.tick, kind: "sell" });
    this.push("sell", coin, { amount: total });
    this.noteSale(coin, c.state.price);
    this.changed();
    return { ok: true };
  }

  sellAll(coin: number): ActionResult {
    return this.sell(coin, BPS);
  }

  takeInitials(coin: number): ActionResult {
    const c = this.coins[coin]!;
    let total = 0n;
    let done = false;
    for (const p of this.ledger.positions) {
      if (!p.open || p.coin !== coin) continue;
      const r = this.ledger.takeInitials(p.id, c.state.status, c.state.price);
      if (r.ok) {
        total += r.value.payout;
        done = true;
      }
    }
    if (!done) return { ok: false, error: "initials_unavailable" };
    c.marks.push({ tick: c.state.tick, kind: "sell" });
    this.push("initials", coin, { amount: total });
    this.noteSale(coin, c.state.price);
    this.changed();
    return { ok: true };
  }

  /** Back to the starting balance and a fresh round. */
  reset(): void {
    this.ledger = new Ledger(DEFAULT_CONFIG, START_BALANCE);
    this.roundsPlayed = 0;
    this.ticksPlayed = 0;
    this.prepareRound();
  }

  /** The round exactly as it was played, in the engine's canonical form. */
  playedRound(): Round {
    return { roundId: this.roundId, coins: this.coins.map((c) => ({ coinIndex: c.index, profile: c.state.profile, ticks: c.records })) };
  }

  /** After the round: check the seed against the commit and recompute the whole round from it. */
  verify(): Verification | null {
    if (this.phase !== "ended" || this.seed === null) return null;
    const playedHash = roundHash(this.playedRound());
    const recomputedHash = roundHash(generateRound(this.engine, this.seed, this.roundId));
    return { commitOk: verifyCommit(this.seed, this.commit), roundOk: playedHash === recomputedHash, playedHash, recomputedHash };
  }
}

export { EVENT_NONE, STATUS_ALIVE, STATUS_RUGGED, STATUS_SETTLED };
