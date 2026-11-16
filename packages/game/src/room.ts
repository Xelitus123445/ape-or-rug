// One shared room: three lanes (degen, mid, runner) that every player in the
// room sees at the same time, and one ledger per player. The room is the
// authority: it plays the ticks, executes every order at the price of the
// tick it has just played, and tells each client what happened. It has no
// clock and no network; the server calls clock() at the room's pace and
// hands it client messages, and the room hands back encoded frames.
//
// Seeds and keyed streams live in private fields. A coin's seed leaves the
// room only inside that coin's "end" message, after its last tick.

import {
  CoinStream,
  DEFAULT_CONFIG,
  Ledger,
  RoundKey,
  STATUS_ALIVE,
  STATUS_RUGGED,
  commitOf,
  createEngine,
  laneRoundId,
  launchCoin,
  snapshot,
  stepCoin,
  toHex,
  valueOf,
} from "@ape/engine";
import type { CoinState, Engine, LedgerError, TickRecord } from "@ape/engine";
import { COIN_BANK } from "./coinBank.ts";
import {
  BREAKS,
  COOLDOWN_SECONDS,
  FEED_SIZE,
  FIRST_LAUNCH_SECONDS,
  HISTORY_SIZE,
  LANES,
  MAX_PLAYERS,
  PACES,
  RECENT_TICKERS,
  SEAT_HOLD_MS,
  START_BALANCE,
  WAIT_UNITS,
} from "./constants.ts";
import type { Pace } from "./constants.ts";
import { cleanNick, encode, parseClient } from "./protocol.ts";
import type { ActionError, BoardRow, ClientMsg, CoinMeta, FeedItem, FeedKind, FinishedCoin, LanePhase, LaneView, MeView, RoomSettings, ServerMsg } from "./protocol.ts";

export interface RoomDeps {
  /** 32 random bytes for a coin seed. */
  readonly newSeed: () => Uint8Array;
  /** 32 hex characters for a reconnect token. */
  readonly newToken: () => string;
  /** Wall clock in ms; only used to hold seats of players who dropped out. */
  readonly now: () => number;
  /** Delivers one encoded frame (a list of messages) to one player. */
  readonly send: (pid: string, frame: string) => void;
  /** Called when the host changes the pace, so the caller can re-arm its timer. */
  readonly onPace?: (ticksPerSecond: number) => void;
}

export interface RoomLane {
  readonly index: number;
  /** Fixed for the lane: 0 degen, 1 mid, 2 runner. */
  readonly profile: number;
  phase: LanePhase;
  coinNo: number;
  roundId: string;
  /** Published before the coin launches. */
  commit: string;
  meta: CoinMeta;
  state: CoinState;
  records: TickRecord[];
  peak: bigint;
  lastAlivePrice: bigint;
  ended: StoredCoin | null;
}

interface StoredCoin {
  /** Shared facts; staked and paid are zero here and filled in per player. */
  readonly coin: FinishedCoin;
  readonly results: ReadonlyMap<string, { readonly staked: bigint; readonly paid: bigint }>;
}

export interface Player {
  readonly id: string;
  readonly nick: string;
  readonly token: string;
  ledger: Ledger;
  refills: number;
  lastSeq: number;
  online: boolean;
  leftAt: number;
}

export type JoinResult = { readonly ok: true; readonly pid: string; readonly rejoined: boolean } | { readonly ok: false; readonly error: "room_full" | "bad_nick" };

function cosmetics(stream: CoinStream, taken: Set<string>): CoinMeta {
  const w = new Int32Array(8);
  // Cosmetic digest: far away from the digests the price uses.
  stream.digest(0, 9000, w);
  let pick = (w[0]! >>> 0) % COIN_BANK.length;
  while (taken.has(COIN_BANK[pick]!.ticker)) pick = (pick + 1) % COIN_BANK.length;
  return { ...COIN_BANK[pick]!, hue: (w[1]! >>> 0) % 360 };
}

export class Room {
  readonly code: string;
  readonly engine: Engine = createEngine();
  pace: Pace = PACES[1]!;
  breakSeconds: number = BREAKS[1]!;
  readonly lanes: RoomLane[] = [];
  readonly players = new Map<string, Player>();
  feed: FeedItem[] = [];
  /** Recently ended coins, newest first. */
  history: StoredCoin[] = [];
  coinsPlayed = 0;
  ticksPlayed = 0;

  readonly #deps: RoomDeps;
  // Real private fields: seeds and keyed streams never show up in
  // Object.keys, JSON dumps or anything the room sends before a coin ends.
  #seeds: (Uint8Array | null)[] = [];
  #streams: (CoinStream | null)[] = [];
  // Remaining wait per lane in 1/24 s, divisible by every tick rate.
  #waitUnits: number[] = new Array<number>(LANES).fill(0);
  #recentTickers: string[] = [];
  #host = "";
  #nextPlayer = 0;
  #feedId = 0;
  #finishedId = 0;
  #queues = new Map<string, ServerMsg[]>();
  #dirtyMe = new Set<string>();
  #lastBoard = "";

  constructor(code: string, deps: RoomDeps) {
    this.code = code;
    this.#deps = deps;
    for (let i = 0; i < LANES; i++) {
      this.#seeds.push(null);
      this.#streams.push(null);
      this.prepareCoin(i, FIRST_LAUNCH_SECONDS, null);
    }
  }

  get ticksPerSecond(): number {
    return this.pace.ticksPerSecond;
  }

  get host(): string {
    return this.#host;
  }

  get settings(): RoomSettings {
    return { host: this.#host, pace: this.pace.id, breakSeconds: this.breakSeconds };
  }

  get online(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.online) n++;
    return n;
  }

  waitUnits(lane: number): number {
    return this.#waitUnits[lane] ?? 0;
  }

  // ---------------------------------------------------------------- output

  private to(pid: string, msg: ServerMsg): void {
    const p = this.players.get(pid);
    if (p === undefined || !p.online) return;
    let q = this.#queues.get(pid);
    if (q === undefined) {
      q = [];
      this.#queues.set(pid, q);
    }
    q.push(msg);
  }

  private broadcast(msg: ServerMsg): void {
    for (const p of this.players.values()) this.to(p.id, msg);
  }

  /** Sends what has queued up: one frame per player, in the order it happened. */
  flush(): void {
    for (const pid of this.#dirtyMe) this.to(pid, { t: "me", me: this.meView(pid) });
    this.#dirtyMe.clear();
    const rows = this.board();
    const text = encode(rows);
    if (text !== this.#lastBoard) {
      this.#lastBoard = text;
      this.broadcast({ t: "board", rows });
    }
    const queues = this.#queues;
    this.#queues = new Map();
    for (const [pid, msgs] of queues) if (msgs.length > 0) this.#deps.send(pid, encode(msgs));
  }

  /** A feed line for everyone in the room. `lane` is null for joins and leaves. */
  private push(kind: FeedKind, lane: RoomLane | null, extra: { amount?: bigint; event?: number; price?: bigint; won?: boolean; pid?: string } = {}): void {
    const nick = extra.pid !== undefined ? this.players.get(extra.pid)?.nick : undefined;
    const item: FeedItem = {
      id: ++this.#feedId,
      kind,
      lane: lane?.index ?? -1,
      roundId: lane?.roundId ?? "",
      ticker: lane?.meta.ticker ?? "",
      tick: lane?.state.tick ?? 0,
      price: extra.price ?? lane?.state.price ?? 0n,
      ...(extra.amount !== undefined ? { amount: extra.amount } : {}),
      ...(extra.event !== undefined ? { event: extra.event } : {}),
      ...(extra.won !== undefined ? { won: extra.won } : {}),
      ...(extra.pid !== undefined ? { pid: extra.pid, nick } : {}),
    };
    this.feed.unshift(item);
    if (this.feed.length > FEED_SIZE) this.feed.length = FEED_SIZE;
    this.broadcast({ t: "feed", item });
  }

  // ----------------------------------------------------------------- views

  private finishedFor(stored: StoredCoin, pid: string): FinishedCoin {
    const r = stored.results.get(pid);
    return r === undefined ? stored.coin : { ...stored.coin, staked: r.staked, paid: r.paid };
  }

  private laneView(lane: RoomLane, pid: string): LaneView {
    return {
      index: lane.index,
      profile: lane.profile,
      phase: lane.phase,
      waitUnits: this.#waitUnits[lane.index]!,
      coinNo: lane.coinNo,
      roundId: lane.roundId,
      commit: lane.commit,
      meta: lane.meta,
      records: lane.records.slice(),
      ended: lane.ended === null ? null : this.finishedFor(lane.ended, pid),
    };
  }

  private meView(pid: string): MeView {
    const p = this.players.get(pid)!;
    return { balance: p.ledger.balance, positions: p.ledger.positions.map((x) => ({ ...x })), refills: p.refills };
  }

  /** Balance plus open bags at the current price. */
  equity(pid: string): bigint {
    const p = this.players.get(pid);
    if (p === undefined) return 0n;
    let total = p.ledger.balance;
    for (const x of p.ledger.positions) if (x.open) total += valueOf(x.units, this.lanes[x.coin]!.state.price);
    return total;
  }

  board(): BoardRow[] {
    const rows: BoardRow[] = [];
    for (const p of this.players.values()) {
      rows.push({ id: p.id, nick: p.nick, online: p.online, result: this.equity(p.id) - START_BALANCE * BigInt(1 + p.refills), refills: p.refills });
    }
    return rows.sort((a, b) => (a.result === b.result ? 0 : a.result > b.result ? -1 : 1));
  }

  // ----------------------------------------------------------------- lanes

  /**
   * Commits to a fresh seed and shows the lane's next coin at 1.00x. The
   * round id carries the lane's profile, so the commit fixes it too.
   */
  private prepareCoin(index: number, seconds: number, current: RoomLane | null): void {
    for (const p of this.players.values()) {
      if (p.ledger.positions.some((x) => x.open && x.coin === index)) throw new Error("lane still has an open position");
    }
    // Everything that can fail happens before the lane is touched.
    const profile = index;
    const seed = this.#deps.newSeed();
    const coinNo = (current?.coinNo ?? 0) + 1;
    const roundId = laneRoundId(profile, coinNo);
    const commit = commitOf(seed, roundId);
    const stream = new CoinStream(new RoundKey(seed, roundId), 0);
    const state = launchCoin(profile);
    const taken = new Set([...this.#recentTickers, ...this.lanes.filter((l) => l.index !== index).map((l) => l.meta.ticker)]);
    const meta = cosmetics(stream, taken);

    for (const p of this.players.values()) {
      if (p.ledger.positions.some((x) => x.coin === index)) {
        p.ledger.clearClosed(index);
        this.#dirtyMe.add(p.id);
      }
    }
    this.#recentTickers.push(meta.ticker);
    if (this.#recentTickers.length > RECENT_TICKERS) this.#recentTickers.shift();
    this.#seeds[index] = seed;
    this.#streams[index] = stream;
    const lane: RoomLane = { index, profile, phase: "prelaunch", coinNo, roundId, commit, meta, state, records: [snapshot(state)], peak: state.price, lastAlivePrice: state.price, ended: null };
    this.lanes[index] = lane;
    this.#waitUnits[index] = (seconds < 1 ? 1 : seconds) * WAIT_UNITS;
    for (const p of this.players.values()) this.to(p.id, { t: "coin", lane: this.laneView(lane, p.id) });
  }

  private nextBreak(): number {
    return this.breakSeconds > COOLDOWN_SECONDS ? this.breakSeconds - COOLDOWN_SECONDS : 1;
  }

  /**
   * Plays one tick interval. A failure on one lane does not stop the others;
   * it is rethrown after every lane has run and the frames have been sent.
   */
  clock(): void {
    let failure: unknown = null;
    const step = WAIT_UNITS / this.pace.ticksPerSecond;
    for (const lane of this.lanes) {
      try {
        if (lane.phase === "live") {
          this.playTick(lane);
          continue;
        }
        const left = this.#waitUnits[lane.index]! - step;
        this.#waitUnits[lane.index] = left;
        if (left > 0) continue;
        if (lane.phase === "prelaunch") this.launch(lane);
        else this.prepareCoin(lane.index, this.nextBreak(), lane);
      } catch (e) {
        if (failure === null) failure = e;
      }
    }
    // Countdowns go out whenever a lane is waiting, including one that has just ended.
    if (this.lanes.some((l) => l.phase !== "live")) this.broadcast({ t: "waits", units: this.#waitUnits.slice() });
    this.prune();
    this.flush();
    if (failure !== null) throw failure;
  }

  private launch(lane: RoomLane): void {
    lane.phase = "live";
    this.#waitUnits[lane.index] = 0;
    this.broadcast({ t: "launch", lane: lane.index, roundId: lane.roundId });
    this.push("launch", lane);
  }

  private playTick(lane: RoomLane): void {
    const c = lane.state;
    const before = c.price;
    // What each player's bag in this coin is worth right before the tick.
    const bagBefore = new Map<string, bigint>();
    for (const p of this.players.values()) {
      let v = 0n;
      for (const x of p.ledger.positions) if (x.open && x.coin === lane.index) v += valueOf(x.units, before);
      if (v > 0n) bagBefore.set(p.id, v);
    }
    stepCoin(this.engine, this.#streams[lane.index]!, c);
    this.ticksPlayed++;
    const rec = snapshot(c);
    lane.records.push(rec);
    if (c.price > lane.peak) lane.peak = c.price;
    this.broadcast({ t: "step", lane: lane.index, roundId: lane.roundId, rec });
    // Truthful events: each feed line mirrors a regime change the engine just made.
    if (c.eventStarted) this.push("event", lane, { event: c.tickEvent });
    if (c.justGraduated) this.push("graduated", lane);
    const status: number = c.status;
    if (status === STATUS_RUGGED) this.push("rug", lane, { price: before });
    else lane.lastAlivePrice = c.price;

    // The tick settles every open position before any order of the next interval.
    for (const p of this.players.values()) {
      let rugShown = false;
      for (const o of p.ledger.onTick(lane.index, c.status, c.price)) {
        this.#dirtyMe.add(p.id);
        if (o.reason === "rug") {
          // One line per player and coin: the value that just went to zero.
          if (!rugShown) this.push("lost", lane, { amount: bagBefore.get(p.id) ?? 0n, price: before, pid: p.id });
          rugShown = true;
        } else {
          const h = this.holding(p.id, lane.index);
          this.push(o.reason === "cap" ? "cap" : "settled", lane, { amount: o.payout, won: h.paid + h.value >= h.stake, pid: p.id });
        }
      }
    }
    if (status !== STATUS_ALIVE) this.finish(lane);
  }

  private finish(lane: RoomLane): void {
    const results = new Map<string, { staked: bigint; paid: bigint }>();
    for (const p of this.players.values()) {
      const h = this.holding(p.id, lane.index);
      if (h.stake > 0n) results.set(p.id, { staked: h.stake, paid: h.paid });
    }
    const coin: FinishedCoin = {
      id: ++this.#finishedId,
      lane: lane.index,
      profile: lane.profile,
      roundId: lane.roundId,
      commit: lane.commit,
      seed: toHex(this.#seeds[lane.index]!),
      meta: lane.meta,
      records: lane.records,
      status: lane.state.status,
      ticks: lane.state.tick,
      peak: lane.peak,
      endPrice: lane.lastAlivePrice,
      staked: 0n,
      paid: 0n,
    };
    const stored: StoredCoin = { coin, results };
    lane.ended = stored;
    this.history.unshift(stored);
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;
    this.coinsPlayed++;
    this.#seeds[lane.index] = null;
    this.#streams[lane.index] = null;
    lane.phase = "cooldown";
    this.#waitUnits[lane.index] = (this.breakSeconds > COOLDOWN_SECONDS ? COOLDOWN_SECONDS : this.breakSeconds) * WAIT_UNITS;
    // The seed goes out only now, after the coin's last tick.
    for (const p of this.players.values()) this.to(p.id, { t: "end", lane: lane.index, coin: this.finishedFor(stored, p.id) });
  }

  // --------------------------------------------------------------- players

  /** The seat a reconnect token belongs to, if it is still held. */
  findByToken(token: string | null): string | null {
    if (token === null) return null;
    for (const p of this.players.values()) if (p.token === token) return p.id;
    return null;
  }

  /**
   * Seats a new player, or gives a returning player their seat back. Queues
   * the welcome; the caller attaches the connection and then calls flush().
   */
  join(nickRaw: unknown, token: string | null): JoinResult {
    const known = this.findByToken(token);
    let player = known === null ? undefined : this.players.get(known);
    const rejoined = player !== undefined;
    if (player === undefined) {
      if (this.players.size >= MAX_PLAYERS) return { ok: false, error: "room_full" };
      const clean = cleanNick(nickRaw);
      if (clean === null) return { ok: false, error: "bad_nick" };
      const taken = new Set([...this.players.values()].map((p) => p.nick.toLowerCase()));
      let nick = clean;
      for (let i = 2; taken.has(nick.toLowerCase()); i++) nick = `${clean.slice(0, 13)} ${i}`;
      player = { id: `p${++this.#nextPlayer}`, nick, token: this.#deps.newToken(), ledger: new Ledger(DEFAULT_CONFIG, START_BALANCE), refills: 0, lastSeq: 0, online: true, leftAt: 0 };
      this.players.set(player.id, player);
    }
    player.online = true;
    this.#queues.set(player.id, []);
    const hostChanged = this.pickHost();
    this.to(player.id, {
      t: "welcome",
      you: { id: player.id, nick: player.nick, token: player.token },
      code: this.code,
      settings: this.settings,
      lanes: this.lanes.map((l) => this.laneView(l, player.id)),
      history: this.history.map((s) => this.finishedFor(s, player.id)),
      feed: this.feed.slice(),
      me: this.meView(player.id),
      board: this.board(),
      lastSeq: player.lastSeq,
    });
    if (!rejoined) this.push("join", null, { pid: player.id });
    if (hostChanged) this.broadcast({ t: "settings", settings: this.settings });
    return { ok: true, pid: player.id, rejoined };
  }

  /** The player's connection dropped. Their seat and bags are held for a while. */
  leave(pid: string): void {
    const p = this.players.get(pid);
    if (p === undefined || !p.online) return;
    p.online = false;
    p.leftAt = this.#deps.now();
    this.#queues.delete(pid);
    this.#dirtyMe.delete(pid);
    this.push("leave", null, { pid });
    if (this.pickHost()) this.broadcast({ t: "settings", settings: this.settings });
    this.flush();
  }

  /** Frees seats of players who have been gone longer than the hold. */
  private prune(): void {
    const now = this.#deps.now();
    for (const p of [...this.players.values()]) {
      if (!p.online && now - p.leftAt > SEAT_HOLD_MS) this.players.delete(p.id);
    }
  }

  /** Host is the longest-seated player who is online. Returns whether it changed. */
  private pickHost(): boolean {
    const current = this.players.get(this.#host);
    if (current !== undefined && current.online) return false;
    for (const p of this.players.values()) {
      if (p.online) {
        this.#host = p.id;
        return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------- actions

  holding(pid: string, lane: number): { stake: bigint; paid: bigint; value: bigint } {
    const p = this.players.get(pid);
    let stake = 0n, paid = 0n, value = 0n;
    if (p === undefined || this.lanes[lane] === undefined) return { stake, paid, value };
    const price = this.lanes[lane]!.state.price;
    for (const x of p.ledger.positions) {
      if (x.coin !== lane) continue;
      stake += x.stake;
      paid += x.paid;
      if (x.open) value += valueOf(x.units, price);
    }
    return { stake, paid, value };
  }

  /** One raw client message from a seated player. Malformed input is answered, never executed. */
  handle(pid: string, text: string): void {
    const p = this.players.get(pid);
    if (p === undefined || !p.online) return;
    const msg = parseClient(text);
    if (msg === null || msg.t === "hello") {
      this.to(pid, { t: "ack", seq: 0, ok: false, error: "bad_message" });
      this.flush();
      return;
    }
    // Every action carries a number larger than the last one: a replayed or
    // duplicated message is refused before it can do anything.
    if (msg.seq <= p.lastSeq) {
      this.to(pid, { t: "ack", seq: msg.seq, ok: false, error: "stale_seq" });
      this.flush();
      return;
    }
    p.lastSeq = msg.seq;
    const error = this.act(p, msg);
    this.to(pid, error === null ? { t: "ack", seq: msg.seq, ok: true } : { t: "ack", seq: msg.seq, ok: false, error });
    this.flush();
  }

  private act(p: Player, msg: Exclude<ClientMsg, { t: "hello" }>): ActionError | null {
    switch (msg.t) {
      case "buy":
      case "sell":
      case "initials": {
        const lane = this.lanes[msg.lane]!;
        // An order is for one coin. Sent for a coin that has since ended, it is refused.
        if (msg.roundId !== lane.roundId) return "coin_changed";
        if (msg.t === "buy") return this.buy(p, lane, msg.stake);
        if (msg.t === "sell") return this.sell(p, lane, msg.bps);
        return this.initials(p, lane);
      }
      case "skip": {
        if (p.id !== this.#host) return "host_only";
        const lane = this.lanes[msg.lane]!;
        if (lane.phase === "prelaunch") this.launch(lane);
        else if (lane.phase === "cooldown") this.prepareCoin(lane.index, this.nextBreak(), lane);
        return null;
      }
      case "pace": {
        if (p.id !== this.#host) return "host_only";
        const next = PACES.find((x) => x.id === msg.pace);
        if (next === undefined) return "bad_setting";
        if (next !== this.pace) {
          this.pace = next;
          this.broadcast({ t: "settings", settings: this.settings });
          this.#deps.onPace?.(next.ticksPerSecond);
        }
        return null;
      }
      case "break": {
        if (p.id !== this.#host) return "host_only";
        if (!BREAKS.includes(msg.seconds)) return "bad_setting";
        if (msg.seconds !== this.breakSeconds) {
          this.breakSeconds = msg.seconds;
          this.broadcast({ t: "settings", settings: this.settings });
        }
        return null;
      }
      case "refill": {
        // Only an empty wallet with nothing riding can be refilled, and it shows on the board.
        if (p.ledger.balance >= DEFAULT_CONFIG.minStake || p.ledger.positions.some((x) => x.open)) return "not_broke";
        p.ledger = new Ledger(DEFAULT_CONFIG, START_BALANCE);
        p.refills++;
        this.#dirtyMe.add(p.id);
        return null;
      }
    }
  }

  /** Buys at the price of the tick the room has just played; the client never names a price. */
  private buy(p: Player, lane: RoomLane, stake: bigint): ActionError | null {
    const c = lane.state;
    const r = p.ledger.buy(lane.index, stake, c.status, c.price, c.tick);
    if (!r.ok) return r.error;
    this.#dirtyMe.add(p.id);
    this.push("buy", lane, { amount: stake, pid: p.id });
    return null;
  }

  private sell(p: Player, lane: RoomLane, bps: bigint): ActionError | null {
    const c = lane.state;
    let total = 0n;
    let sold = false;
    let last: LedgerError = "no_such_position";
    for (const x of p.ledger.positions) {
      if (!x.open || x.coin !== lane.index) continue;
      const r = p.ledger.sell(x.id, bps, c.status, c.price);
      if (r.ok) {
        total += r.value.payout;
        sold = true;
      } else last = r.error;
    }
    if (!sold) return last;
    this.#dirtyMe.add(p.id);
    const h = this.holding(p.id, lane.index);
    this.push("sell", lane, { amount: total, won: h.paid + h.value >= h.stake, pid: p.id });
    return null;
  }

  private initials(p: Player, lane: RoomLane): ActionError | null {
    const c = lane.state;
    let total = 0n;
    let done = false;
    for (const x of p.ledger.positions) {
      if (!x.open || x.coin !== lane.index) continue;
      const r = p.ledger.takeInitials(x.id, c.status, c.price);
      if (r.ok) {
        total += r.value.payout;
        done = true;
      }
    }
    if (!done) return "initials_unavailable";
    this.#dirtyMe.add(p.id);
    // Initials gets the stake of one position back; with several buys the coin can still be in the red.
    const h = this.holding(p.id, lane.index);
    this.push("initials", lane, { amount: total, won: h.paid + h.value >= h.stake, pid: p.id });
    return null;
  }
}
