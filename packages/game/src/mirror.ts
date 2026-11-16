// The client's copy of a room, built only from what the server sent. It
// plays nothing itself: every price comes from a "step" message, every
// balance from a "me" message. Actions are sent to the server and take effect
// when the server says so.

import { BPS, PRICE_SCALE, UNIT_SCALE, ceilDiv, createEngine, launchCoin, snapshot, valueOf } from "@ape/engine";
import type { Engine, Position, TickRecord } from "@ape/engine";
import { PACES, WAIT_UNITS } from "./constants.ts";
import type { Pace } from "./constants.ts";
import { decodeServer, encode, unpackTick } from "./protocol.ts";
import type { ActionError, BoardRow, CoinMeta, FeedItem, FinishedCoin, LanePhase, LaneView, MeView, RoomSettings, ServerMsg } from "./protocol.ts";
import { verifyCoin } from "./verify.ts";
import type { Verification } from "./verify.ts";

export interface LiveCoin {
  readonly lane: number;
  readonly meta: CoinMeta;
  /** The last tick played, as the server reported it. */
  state: TickRecord;
  /** Multiplier per tick as a float, for drawing only. */
  readonly history: number[];
  readonly records: TickRecord[];
  /** Ticks at which this player bought or sold, for chart markers. */
  readonly marks: { tick: number; kind: "buy" | "sell" }[];
}

export interface MirrorLane {
  readonly index: number;
  readonly profile: number;
  phase: LanePhase;
  coinNo: number;
  roundId: string;
  commit: string;
  coin: LiveCoin;
  ended: FinishedCoin | null;
}

export interface CoinHolding {
  readonly positions: readonly Position[];
  readonly stake: bigint;
  readonly paid: bigint;
  readonly value: bigint;
  readonly canInitials: boolean;
}

export type Status = "connecting" | "open" | "closed";

const HISTORY_KEEP = 40;
const FEED_KEEP = 60;

function liveCoin(view: LaneView): LiveCoin {
  const records = view.records.length > 0 ? view.records.map(unpackTick) : [snapshot(launchCoin(view.profile))];
  return {
    lane: view.index,
    meta: view.meta,
    state: records[records.length - 1]!,
    history: records.map((r) => Number(r.price) / Number(PRICE_SCALE)),
    records,
    marks: [],
  };
}

export class RoomMirror {
  version = 0;
  status: Status = "connecting";
  /** Set when the server refused the seat (room full, bad nickname) or replaced this connection. */
  fatal: string | null = null;
  you: { id: string; nick: string; token: string } | null = null;
  code = "";
  settings: RoomSettings = { host: "", pace: PACES[1]!.id, breakSeconds: 10 };
  lanes: MirrorLane[] = [];
  feed: FeedItem[] = [];
  /** Ended coins, newest first, with this player's own result on each. */
  history: FinishedCoin[] = [];
  me: MeView = { balance: 0n, positions: [], refills: 0 };
  board: BoardRow[] = [];
  /** Coins that ended while this player was in the room. */
  coinsPlayed = 0;
  /** The last refused action, with a counter so the same error twice still shows twice. */
  lastError: { n: number; error: ActionError } | null = null;

  #send: (text: string) => void;
  #seq = 0;
  #waits: number[] = [];
  #errors = 0;
  #engine: Engine | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(send: (text: string) => void) {
    this.#send = send;
  }

  /** Swap the transport, e.g. after a reconnect. */
  setSender(send: (text: string) => void): void {
    this.#send = send;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  changed(): void {
    this.version++;
    for (const fn of this.#listeners) fn();
  }

  /** The connection dropped or came back; the room's state stays on screen meanwhile. */
  setStatus(status: Status): void {
    if (status === this.status) return;
    this.status = status;
    this.changed();
  }

  get ready(): boolean {
    return this.you !== null && this.lanes.length > 0;
  }

  /** The client's own engine: used for config numbers and to replay ended coins. */
  get engine(): Engine {
    this.#engine ??= createEngine();
    return this.#engine;
  }

  get pace(): Pace {
    return PACES.find((p) => p.id === this.settings.pace) ?? PACES[1]!;
  }

  get breakSeconds(): number {
    return this.settings.breakSeconds;
  }

  get isHost(): boolean {
    return this.you !== null && this.settings.host === this.you.id;
  }

  get balance(): bigint {
    return this.me.balance;
  }

  /** Balance plus what the open bags are worth at the last price the server sent. */
  get equity(): bigint {
    let total = this.me.balance;
    for (const p of this.me.positions) if (p.open && this.lanes[p.coin] !== undefined) total += valueOf(p.units, this.lanes[p.coin]!.coin.state.price);
    return total;
  }

  get coins(): LiveCoin[] {
    return this.lanes.map((l) => l.coin);
  }

  /** Whole seconds left in a lane's wait, rounded up. */
  waitSeconds(lane: number): number {
    const u = this.#waits[lane] ?? 0;
    return u <= 0 ? 0 : Math.ceil(u / WAIT_UNITS);
  }

  holding(lane: number): CoinHolding {
    const l = this.lanes[lane];
    if (l === undefined) return { positions: [], stake: 0n, paid: 0n, value: 0n, canInitials: false };
    const price = l.coin.state.price;
    const positions = this.me.positions.filter((p) => p.coin === lane);
    let stake = 0n, paid = 0n, value = 0n, canInitials = false;
    for (const p of positions) {
      stake += p.stake;
      paid += p.paid;
      if (p.open) {
        value += valueOf(p.units, price);
        // Same rule as the ledger: enough units to pay back what is still owed, with some left over.
        const need = p.stake - p.paid;
        if (need > 0n && price > 0n && ceilDiv(need * UNIT_SCALE, price) < p.units) canInitials = true;
      }
    }
    return { positions, stake, paid, value, canInitials };
  }

  verify(coin: FinishedCoin): Verification {
    return verifyCoin(this.engine, coin);
  }

  // --------------------------------------------------------------- actions

  private order(msg: Record<string, unknown>): number {
    const seq = ++this.#seq;
    this.#send(encode({ ...msg, seq }));
    return seq;
  }

  buy(lane: number, stake: bigint): number {
    return this.order({ t: "buy", lane, roundId: this.lanes[lane]?.roundId ?? "", stake });
  }

  sell(lane: number, bps: bigint): number {
    return this.order({ t: "sell", lane, roundId: this.lanes[lane]?.roundId ?? "", bps });
  }

  sellAll(lane: number): number {
    return this.sell(lane, BPS);
  }

  takeInitials(lane: number): number {
    return this.order({ t: "initials", lane, roundId: this.lanes[lane]?.roundId ?? "" });
  }

  skipWait(lane: number): number {
    return this.order({ t: "skip", lane });
  }

  setPace(pace: string): number {
    return this.order({ t: "pace", pace });
  }

  setBreak(seconds: number): number {
    return this.order({ t: "break", seconds });
  }

  refill(): number {
    return this.order({ t: "refill" });
  }

  // --------------------------------------------------------------- inbound

  /** Applies one frame from the server. */
  receive(text: string): void {
    for (const m of decodeServer(text)) this.apply(m);
    this.changed();
  }

  private apply(m: ServerMsg): void {
    switch (m.t) {
      case "welcome": {
        this.you = m.you;
        this.code = m.code;
        this.settings = m.settings;
        // Coins already in the list (after a reconnect) keep the ticks this client saw live.
        // Matched by commit: round ids start again at 1 when the server restarts.
        const known = new Map(this.history.map((f) => [f.commit, f]));
        const fresh = m.history.map((f) => {
          const k = known.get(f.commit);
          return k !== undefined && k.records.length > 0 && k.roundId === f.roundId ? { ...f, records: k.records } : f;
        });
        const commits = new Set(fresh.map((f) => f.commit));
        this.history = [...fresh, ...this.history.filter((f) => !commits.has(f.commit))].slice(0, HISTORY_KEEP);
        this.lanes = m.lanes.map((v) => this.fromView(v));
        this.#waits = m.lanes.map((v) => v.waitUnits);
        this.feed = m.feed.slice();
        this.me = m.me;
        this.board = m.board.slice();
        if (m.lastSeq > this.#seq) this.#seq = m.lastSeq;
        this.status = "open";
        this.fatal = null;
        // Rebuild this player's chart marks from the feed the server kept.
        for (const f of [...this.feed].reverse()) this.mark(f);
        return;
      }
      case "coin": {
        this.lanes[m.lane.index] = this.fromView(m.lane);
        this.#waits[m.lane.index] = m.lane.waitUnits;
        return;
      }
      case "launch": {
        const l = this.lanes[m.lane];
        if (l === undefined || l.roundId !== m.roundId) return;
        l.phase = "live";
        this.#waits[m.lane] = 0;
        return;
      }
      case "step": {
        const l = this.lanes[m.lane];
        if (l === undefined || l.roundId !== m.roundId) return;
        const c = l.coin;
        const rec = unpackTick(m.rec);
        c.records.push(rec);
        c.history.push(Number(rec.price) / Number(PRICE_SCALE));
        c.state = rec;
        return;
      }
      case "end": {
        const l = this.lanes[m.lane];
        let coin = m.coin;
        if (l !== undefined && l.commit === m.coin.commit) {
          // The ticks this client was sent live are the ones the fairness check replays against.
          coin = { ...m.coin, records: l.coin.records.slice() };
          l.phase = "cooldown";
          l.ended = coin;
        }
        this.history.unshift(coin);
        if (this.history.length > HISTORY_KEEP) this.history.length = HISTORY_KEEP;
        this.coinsPlayed++;
        return;
      }
      case "feed":
        this.feed.unshift(m.item);
        if (this.feed.length > FEED_KEEP) this.feed.length = FEED_KEEP;
        this.mark(m.item);
        return;
      case "me":
        this.me = m.me;
        return;
      case "board":
        this.board = m.rows.slice();
        return;
      case "settings":
        this.settings = m.settings;
        return;
      case "waits":
        this.#waits = m.units.slice();
        return;
      case "ack":
        if (!m.ok && m.error !== undefined) this.lastError = { n: ++this.#errors, error: m.error };
        return;
      case "error":
        this.fatal = m.error;
        this.status = "closed";
        return;
    }
  }

  private fromView(v: LaneView): MirrorLane {
    const coin = liveCoin(v);
    // A lane in cooldown shows its ended coin; its records are the lane's own.
    const ended = v.ended !== null && v.ended.commit === v.commit ? { ...v.ended, records: coin.records.slice() } : v.ended;
    if (ended !== null) {
      const i = this.history.findIndex((f) => f.commit === ended.commit);
      if (i >= 0) this.history[i] = ended;
    }
    return { index: v.index, profile: v.profile, phase: v.phase, coinNo: v.coinNo, roundId: v.roundId, commit: v.commit, coin, ended };
  }

  /** Chart markers for this player's own trades on the coin now on the lane. */
  private mark(f: FeedItem): void {
    if (this.you === null || f.pid !== this.you.id) return;
    if (f.kind !== "buy" && f.kind !== "sell" && f.kind !== "initials") return;
    const l = this.lanes[f.lane];
    if (l === undefined || l.roundId !== f.roundId) return;
    if (!l.coin.marks.some((x) => x.tick === f.tick && x.kind === (f.kind === "buy" ? "buy" : "sell"))) {
      l.coin.marks.push({ tick: f.tick, kind: f.kind === "buy" ? "buy" : "sell" });
    }
  }
}
