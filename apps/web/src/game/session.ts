// One player's game session in lane mode: three lanes (degen, mid, runner),
// each running one coin at a time on its own seed. When a coin ends, the lane
// rests and then launches the next coin. Uses the real engine and the real
// Ledger. No clock in here; the UI calls clock() once per tick interval.

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
  fromHex,
  generateCoinRound,
  laneProfile,
  laneRoundId,
  launchCoin,
  roundHash,
  snapshot,
  stepCoin,
  toHex,
  valueOf,
  verifyCommit,
} from "@ape/engine";
import type { CoinState, Engine, LedgerError, Position, TickRecord } from "@ape/engine";
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

/** Seconds between a coin's end and the next coin's launch on the same lane. */
export const BREAKS: readonly number[] = [5, 10, 20];
/** Of the break, how long the ended coin stays on screen before the next one is shown. */
export const COOLDOWN_SECONDS = 3;
export const FIRST_LAUNCH_SECONDS = 5;

export const START_BALANCE = 10_000_000n; // 100,000.00 USDK
export const STAKES: readonly bigint[] = [25_000n, 50_000n, 100_000n, 250_000n, 500_000n, 1_000_000n];
export const LANES = 3;
/** Wait timers count in 1/24 s: divisible by every tick rate in PACES. */
const WAIT_UNITS = 24;
/** Tickers not reused for this many coins; the bank has 120, three are on screen. */
const RECENT_TICKERS = 60;
const HISTORY_SIZE = 12;

/** prelaunch: coin shown at 1.00x, buying open. live: ticking. cooldown: ended coin still on screen. */
export type LanePhase = "prelaunch" | "live" | "cooldown";

export interface CoinMeta extends CoinIdea {
  readonly hue: number;
}

export interface LiveCoin {
  readonly lane: number;
  readonly meta: CoinMeta;
  readonly state: CoinState;
  /** Multiplier per tick as a float, for drawing only. */
  readonly history: number[];
  readonly records: TickRecord[];
  /** Ticks at which the player bought or sold, for chart markers. */
  readonly marks: { tick: number; kind: "buy" | "sell" }[];
  /** Last price before the end, for the result line. */
  lastAlivePrice: bigint;
  peak: bigint;
}

/** A coin that has ended, with its revealed seed. */
export interface FinishedCoin {
  readonly id: number;
  readonly lane: number;
  readonly profile: number;
  readonly roundId: string;
  readonly commit: string;
  readonly seed: string;
  readonly meta: CoinMeta;
  readonly records: readonly TickRecord[];
  readonly status: number;
  readonly ticks: number;
  readonly peak: bigint;
  /** Price the coin ended from: last price before the rug, or the settlement price. */
  readonly endPrice: bigint;
  readonly staked: bigint;
  readonly paid: bigint;
}

export interface Lane {
  readonly index: number;
  /** Fixed for the lane: 0 degen, 1 mid, 2 runner. */
  readonly profile: number;
  phase: LanePhase;
  /** Ticks left in prelaunch or cooldown. */
  wait: number;
  coinNo: number;
  roundId: string;
  /** Published before the coin launches. */
  commit: string;
  coin: LiveCoin;
  /** The coin that just ended on this lane, while it is still on screen. */
  ended: FinishedCoin | null;
}

export type FeedKind = "buy" | "sell" | "initials" | "rug" | "lost" | "event" | "graduated" | "cap" | "settled" | "launch";

export interface FeedItem {
  readonly id: number;
  readonly kind: FeedKind;
  readonly lane: number;
  readonly ticker: string;
  readonly tick: number;
  /** Coin price at that moment. */
  readonly price: bigint;
  readonly amount?: bigint;
  readonly event?: number;
  /** For sells: whether the coin's bag is at or above its stake after this sale. */
  readonly won?: boolean;
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

export type ActionResult = { ok: true } | { ok: false; error: LedgerError };

function cosmetics(stream: CoinStream, taken: Set<string>): CoinMeta {
  const w = new Int32Array(8);
  // Cosmetic digest: far away from the digests the price uses.
  stream.digest(0, 9000, w);
  let pick = (w[0]! >>> 0) % COIN_BANK.length;
  while (taken.has(COIN_BANK[pick]!.ticker)) pick = (pick + 1) % COIN_BANK.length;
  return { ...COIN_BANK[pick]!, hue: (w[1]! >>> 0) % 360 };
}

export class GameSession {
  readonly engine: Engine = createEngine();
  version = 0;
  pace: Pace = PACES[1]!;
  breakSeconds: number = BREAKS[1]!;
  lanes: Lane[] = [];
  ledger: Ledger = new Ledger(DEFAULT_CONFIG, START_BALANCE);
  feed: FeedItem[] = [];
  /** Recently ended coins, newest first. */
  history: FinishedCoin[] = [];
  coinsPlayed = 0;
  ticksPlayed = 0;
  firstRugSeen = false;

  private readonly newSeed: () => Uint8Array;
  // Real private fields: seeds and keyed streams do not show up in
  // Object.keys, JSON dumps or error reports. In this single-player build the
  // coins still run inside the browser, so this keeps the seeds out of
  // accidents, not out of reach of someone with a debugger; M3 moves them to
  // the server.
  #seeds: (Uint8Array | null)[] = [];
  #streams: (CoinStream | null)[] = [];
  // Coin numbers keep counting across resets, so a round id names one committed coin only.
  #coinNos: number[] = new Array<number>(LANES).fill(0);
  // Remaining wait per lane in 1/24 s. 24 is divisible by every tick rate, so
  // changing the pace never rounds the wait and never adds time to it.
  #waitUnits: number[] = new Array<number>(LANES).fill(0);
  #recentTickers: string[] = [];
  private feedId = 0;
  private finishedId = 0;
  private readonly listeners = new Set<() => void>();

  constructor(newSeed: () => Uint8Array) {
    this.newSeed = newSeed;
    this.start();
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

  /** Balance plus what the open bags are worth right now. */
  get equity(): bigint {
    let total = this.ledger.balance;
    for (const p of this.ledger.positions) if (p.open) total += valueOf(p.units, this.lanes[p.coin]!.coin.state.price);
    return total;
  }

  /** The current coin of every lane. */
  get coins(): LiveCoin[] {
    return this.lanes.map((l) => l.coin);
  }

  private start(): void {
    this.lanes = [];
    this.#seeds = [];
    this.#streams = [];
    for (let i = 0; i < LANES; i++) {
      // Placeholder coin; prepareCoin replaces it straight away.
      const lane: Lane = { index: i, profile: i, phase: "prelaunch", wait: 0, coinNo: 0, roundId: "", commit: "", coin: null as unknown as LiveCoin, ended: null };
      this.lanes.push(lane);
      this.#seeds.push(null);
      this.#streams.push(null);
      this.prepareCoin(lane, FIRST_LAUNCH_SECONDS);
    }
    this.changed();
  }

  /** Whole seconds left in a lane's wait, rounded up. */
  waitSeconds(lane: number): number {
    const units = this.#waitUnits[lane];
    if (units === undefined || units <= 0) return 0;
    return (units + WAIT_UNITS - 1 - ((units + WAIT_UNITS - 1) % WAIT_UNITS)) / WAIT_UNITS;
  }

  private unitsPerTick(): number {
    return WAIT_UNITS / this.pace.ticksPerSecond;
  }

  private setWait(lane: Lane, seconds: number): void {
    this.#waitUnits[lane.index] = (seconds < 1 ? 1 : seconds) * WAIT_UNITS;
    this.syncWait(lane);
  }

  /** lane.wait in ticks at the current pace, rounded up. */
  private syncWait(lane: Lane): void {
    const units = this.#waitUnits[lane.index]!;
    const step = this.unitsPerTick();
    lane.wait = units <= 0 ? 0 : (units + step - 1 - ((units + step - 1) % step)) / step;
  }

  setPace(id: string): void {
    const next = PACES.find((p) => p.id === id);
    if (next === undefined || next === this.pace) return;
    this.pace = next;
    // The wait is kept in a pace-free unit, so only its tick count is recomputed.
    for (const l of this.lanes) if (l.phase !== "live") this.syncWait(l);
    this.changed();
  }

  /** Applies to breaks that start from now on. */
  setBreak(seconds: number): void {
    if (!BREAKS.includes(seconds) || seconds === this.breakSeconds) return;
    this.breakSeconds = seconds;
    this.changed();
  }

  /**
   * Commits to a fresh seed and shows the lane's next coin at 1.00x. The
   * round id carries the lane's profile, so the commit fixes it too. Buying
   * is open until launch.
   */
  private prepareCoin(lane: Lane, seconds: number): void {
    // A lane can only move on when nothing is open on it.
    if (this.ledger.positions.some((p) => p.open && p.coin === lane.index)) throw new Error("lane still has an open position");
    // Everything that can fail happens before the lane is touched, so a bad
    // seed leaves the lane exactly as it was.
    const seed = this.newSeed();
    const coinNo = this.#coinNos[lane.index]! + 1;
    const roundId = laneRoundId(lane.profile, coinNo);
    const commit = commitOf(seed, roundId);
    const stream = new CoinStream(new RoundKey(seed, roundId), 0);
    const state = launchCoin(lane.profile);
    // No ticker on two lanes at once, and none of the last few dozen comes back,
    // so the list of ended coins never shows two different coins with one name.
    const taken = new Set([...this.#recentTickers, ...this.lanes.filter((l) => l !== lane && l.coin !== null).map((l) => l.coin.meta.ticker)]);
    const meta = cosmetics(stream, taken);

    this.ledger.clearClosed(lane.index);
    this.#recentTickers.push(meta.ticker);
    if (this.#recentTickers.length > RECENT_TICKERS) this.#recentTickers.shift();
    this.#coinNos[lane.index] = coinNo;
    this.#seeds[lane.index] = seed;
    this.#streams[lane.index] = stream;
    lane.coinNo = coinNo;
    lane.roundId = roundId;
    lane.commit = commit;
    lane.coin = { lane: lane.index, meta, state, history: [1], records: [snapshot(state)], marks: [], lastAlivePrice: state.price, peak: state.price };
    lane.ended = null;
    lane.phase = "prelaunch";
    this.setWait(lane, seconds);
  }

  private nextBreak(): number {
    return this.breakSeconds > COOLDOWN_SECONDS ? this.breakSeconds - COOLDOWN_SECONDS : 1;
  }

  /**
   * Called by the UI once per tick interval. A failure on one lane does not
   * stop the others from ticking; it is rethrown after all lanes have run.
   */
  clock(): void {
    let failure: unknown = null;
    for (const lane of this.lanes) {
      try {
        if (lane.phase === "live") {
          this.playTick(lane);
          continue;
        }
        const left = this.#waitUnits[lane.index]! - this.unitsPerTick();
        this.#waitUnits[lane.index] = left;
        if (left > 0) {
          this.syncWait(lane);
          continue;
        }
        if (lane.phase === "prelaunch") this.launch(lane);
        else this.prepareCoin(lane, this.nextBreak());
      } catch (e) {
        if (failure === null) failure = e;
      }
    }
    this.changed();
    if (failure !== null) throw failure;
  }

  private launch(lane: Lane): void {
    lane.phase = "live";
    this.#waitUnits[lane.index] = 0;
    lane.wait = 0;
    this.push("launch", lane);
  }

  /** Launch a waiting coin now, or skip the rest of a cooldown. Without an argument: every lane. */
  skipWait(lane?: number): void {
    for (const l of this.lanes) {
      if (lane !== undefined && l.index !== lane) continue;
      if (l.phase === "prelaunch") this.launch(l);
      else if (l.phase === "cooldown") this.prepareCoin(l, this.nextBreak());
    }
    this.changed();
  }

  private push(kind: FeedKind, lane: Lane, extra: { amount?: bigint; event?: number; price?: bigint; won?: boolean } = {}): void {
    const c = lane.coin;
    this.feed.unshift({
      id: ++this.feedId,
      kind,
      lane: lane.index,
      ticker: c.meta.ticker,
      tick: c.state.tick,
      price: extra.price ?? c.state.price,
      amount: extra.amount,
      event: extra.event,
      won: extra.won,
    });
    if (this.feed.length > 60) this.feed.length = 60;
  }

  private playTick(lane: Lane): void {
    const coin = lane.coin;
    const c = coin.state;
    const before = c.price;
    // What the player's open bag in this coin is worth right before the tick.
    let bagBefore = 0n;
    for (const p of this.ledger.positions) if (p.open && p.coin === lane.index) bagBefore += valueOf(p.units, before);
    stepCoin(this.engine, this.#streams[lane.index]!, c);
    this.ticksPlayed++;
    coin.records.push(snapshot(c));
    coin.history.push(Number(c.price) / Number(PRICE_SCALE));
    if (c.price > coin.peak) coin.peak = c.price;
    // Truthful events: each feed line mirrors a regime change the engine just made.
    if (c.eventStarted) this.push("event", lane, { event: c.tickEvent });
    if (c.justGraduated) this.push("graduated", lane);
    const status: number = c.status;
    if (status === STATUS_RUGGED) {
      this.push("rug", lane, { price: before });
      this.firstRugSeen = true;
    } else coin.lastAlivePrice = c.price;

    let rugLossShown = false;
    for (const o of this.ledger.onTick(lane.index, c.status, c.price)) {
      if (o.reason === "rug") {
        // One line per coin: the value that just went to zero, never negative.
        if (!rugLossShown) this.push("lost", lane, { amount: bagBefore, price: before });
        rugLossShown = true;
      } else {
        const h = this.holding(lane.index);
        this.push(o.reason === "cap" ? "cap" : "settled", lane, { amount: o.payout, won: h.paid + h.value >= h.stake });
      }
    }
    if (status !== STATUS_ALIVE) this.finish(lane);
  }

  private finish(lane: Lane): void {
    const coin = lane.coin;
    const h = this.holding(lane.index);
    const finished: FinishedCoin = {
      id: ++this.finishedId,
      lane: lane.index,
      profile: lane.profile,
      roundId: lane.roundId,
      commit: lane.commit,
      seed: toHex(this.#seeds[lane.index]!),
      meta: coin.meta,
      records: coin.records,
      status: coin.state.status,
      ticks: coin.state.tick,
      peak: coin.peak,
      endPrice: coin.lastAlivePrice,
      staked: h.stake,
      paid: h.paid,
    };
    lane.ended = finished;
    this.history.unshift(finished);
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;
    this.coinsPlayed++;
    this.#seeds[lane.index] = null;
    this.#streams[lane.index] = null;
    lane.phase = "cooldown";
    this.setWait(lane, this.breakSeconds > COOLDOWN_SECONDS ? COOLDOWN_SECONDS : this.breakSeconds);
  }

  private hasLane(lane: number): boolean {
    return Number.isInteger(lane) && lane >= 0 && lane < this.lanes.length;
  }

  /** The player's positions in the lane's current coin. */
  holding(lane: number): CoinHolding {
    if (!this.hasLane(lane)) return { positions: [], stake: 0n, paid: 0n, value: 0n, canInitials: false };
    const c = this.lanes[lane]!.coin.state;
    const positions = this.ledger.positions.filter((p) => p.coin === lane);
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

  buy(lane: number, stake: bigint): ActionResult {
    if (!this.hasLane(lane)) return { ok: false, error: "bad_coin" };
    const l = this.lanes[lane]!;
    const c = l.coin;
    const r = this.ledger.buy(lane, stake, c.state.status, c.state.price, c.state.tick);
    if (!r.ok) return r;
    c.marks.push({ tick: c.state.tick, kind: "buy" });
    this.push("buy", l, { amount: stake });
    this.changed();
    return { ok: true };
  }

  /** Sell `bps` / 10000 of every open position in the lane's coin. */
  sell(lane: number, bps: bigint): ActionResult {
    if (!this.hasLane(lane)) return { ok: false, error: "bad_coin" };
    const l = this.lanes[lane]!;
    const c = l.coin;
    let total = 0n;
    let sold = false;
    let last: ActionResult = { ok: false, error: "no_such_position" };
    for (const p of this.ledger.positions) {
      if (!p.open || p.coin !== lane) continue;
      const r = this.ledger.sell(p.id, bps, c.state.status, c.state.price);
      if (r.ok) {
        total += r.value.payout;
        sold = true;
      } else last = r;
    }
    if (!sold) return last;
    c.marks.push({ tick: c.state.tick, kind: "sell" });
    const h = this.holding(lane);
    this.push("sell", l, { amount: total, won: h.paid + h.value >= h.stake });
    this.changed();
    return { ok: true };
  }

  sellAll(lane: number): ActionResult {
    return this.sell(lane, BPS);
  }

  takeInitials(lane: number): ActionResult {
    if (!this.hasLane(lane)) return { ok: false, error: "bad_coin" };
    const l = this.lanes[lane]!;
    const c = l.coin;
    let total = 0n;
    let done = false;
    for (const p of this.ledger.positions) {
      if (!p.open || p.coin !== lane) continue;
      const r = this.ledger.takeInitials(p.id, c.state.status, c.state.price);
      if (r.ok) {
        total += r.value.payout;
        done = true;
      }
    }
    if (!done) return { ok: false, error: "initials_unavailable" };
    c.marks.push({ tick: c.state.tick, kind: "sell" });
    // Initials gets the stake of one position back; with several buys the coin can still be in the red.
    const h = this.holding(lane);
    this.push("initials", l, { amount: total, won: h.paid + h.value >= h.stake });
    this.changed();
    return { ok: true };
  }

  /** Back to the starting balance and three fresh coins. */
  reset(): void {
    this.ledger = new Ledger(DEFAULT_CONFIG, START_BALANCE);
    this.coinsPlayed = 0;
    this.ticksPlayed = 0;
    this.feed = [];
    this.history = [];
    this.start();
  }

  /** Check an ended coin: its seed against its commit, and a full replay from the seed. */
  /**
   * Check an ended coin: its seed against its commit, a full replay from the
   * seed, and every fact about the coin the screen shows (profile, how it
   * ended, from which price, its peak and length). Never throws: anything
   * malformed is reported as a failed check.
   */
  verify(coin: FinishedCoin): Verification {
    const failed: Verification = { commitOk: false, roundOk: false, playedHash: "", recomputedHash: "" };
    try {
      if (typeof coin.seed !== "string" || !/^[0-9a-f]{64}$/.test(coin.seed)) return failed;
      // The profile for the replay is read from the round id, which the commit
      // covers, not from what the screen claimed. An unknown name fails the check.
      const profile = laneProfile(coin.roundId);
      if (profile < 0) return failed;
      const seed = fromHex(coin.seed);
      const commitOk = verifyCommit(seed, coin.roundId, coin.commit);
      const replay = generateCoinRound(this.engine, seed, coin.roundId);
      const ticks = replay.coins[0]!.ticks;
      const last = ticks[ticks.length - 1]!;
      let peak = 0n;
      for (const t of ticks) if (t.price > peak) peak = t.price;
      const endPrice = last.status === STATUS_RUGGED ? ticks[ticks.length - 2]!.price : last.price;
      const recomputedHash = roundHash(replay);
      const playedHash = roundHash({ roundId: coin.roundId, coins: [{ coinIndex: 0, profile: coin.profile, ticks: coin.records }] });
      const factsOk =
        coin.profile === profile &&
        coin.status === last.status &&
        coin.ticks === last.tick &&
        coin.peak === peak &&
        coin.endPrice === endPrice &&
        sameRecords(coin.records, ticks);
      return { commitOk, roundOk: playedHash === recomputedHash && factsOk, playedHash, recomputedHash };
    } catch {
      return failed;
    }
  }
}

/** Every field of every tick, including the flags that drive the feed lines. */
function sameRecords(a: readonly TickRecord[], b: readonly TickRecord[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.tick !== y.tick ||
      x.price !== y.price ||
      x.status !== y.status ||
      x.tickEvent !== y.tickEvent ||
      x.event !== y.event ||
      x.eventLeft !== y.eventLeft ||
      x.graduated !== y.graduated ||
      x.eventStarted !== y.eventStarted ||
      x.justGraduated !== y.justGraduated
    ) {
      return false;
    }
  }
  return true;
}

export { EVENT_NONE, STATUS_ALIVE, STATUS_RUGGED, STATUS_SETTLED };
