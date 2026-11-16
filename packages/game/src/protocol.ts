// Wire format between the room server and its clients. JSON, with BigInt
// values written as {"$b": "<digits>"} so money and prices stay exact.
//
// The server never sends a tick before it has played it, and never sends a
// coin's seed before that coin has ended (tested by inspecting every frame).

import type { Position, TickRecord } from "@ape/engine";
import type { CoinIdea } from "./coinBank.ts";
import { LANES, MAX_CLIENT_MESSAGE } from "./constants.ts";

export interface CoinMeta extends CoinIdea {
  readonly hue: number;
}

export type LanePhase = "prelaunch" | "live" | "cooldown";

/** A coin that has ended, with its revealed seed and this player's own result on it. */
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

/**
 * A tick on the wire: [tick, price digits, status, tickEvent, event,
 * eventLeft, flags] with flags 1 graduated, 2 eventStarted, 4 justGraduated.
 * About a quarter of the size of the same record as a JSON object.
 */
export type PackedTick = readonly [number, string, number, number, number, number, number];

export function packTick(r: TickRecord): PackedTick {
  return [r.tick, r.price.toString(), r.status, r.tickEvent, r.event, r.eventLeft, (r.graduated ? 1 : 0) | (r.eventStarted ? 2 : 0) | (r.justGraduated ? 4 : 0)];
}

export function unpackTick(p: PackedTick): TickRecord {
  return {
    tick: p[0],
    price: BigInt(p[1]),
    status: p[2],
    tickEvent: p[3],
    event: p[4],
    eventLeft: p[5],
    graduated: (p[6] & 1) !== 0,
    eventStarted: (p[6] & 2) !== 0,
    justGraduated: (p[6] & 4) !== 0,
  };
}

/**
 * One lane as a joining player first sees it. Records are ticks already
 * played. `ended` comes without records: they are the lane's own records.
 */
export interface LaneView {
  readonly index: number;
  readonly profile: number;
  readonly phase: LanePhase;
  readonly waitUnits: number;
  readonly coinNo: number;
  readonly roundId: string;
  readonly commit: string;
  readonly meta: CoinMeta;
  readonly records: readonly PackedTick[];
  readonly ended: FinishedCoin | null;
}

export type FeedKind = "buy" | "sell" | "initials" | "rug" | "lost" | "event" | "graduated" | "cap" | "settled" | "launch" | "join" | "leave";

export interface FeedItem {
  readonly id: number;
  readonly kind: FeedKind;
  /** -1 for joins and leaves. */
  readonly lane: number;
  /** The coin the line is about; empty for joins and leaves. */
  readonly roundId: string;
  readonly ticker: string;
  readonly tick: number;
  /** Coin price at that moment. */
  readonly price: bigint;
  readonly amount?: bigint;
  readonly event?: number;
  /** For sells: whether that player's bag in the coin is at or above its stake after this sale. */
  readonly won?: boolean;
  /** The player behind a trade, a loss, a cap or a join. Absent for coin events. */
  readonly pid?: string;
  readonly nick?: string;
}

export interface MeView {
  readonly balance: bigint;
  readonly positions: readonly Position[];
  readonly refills: number;
}

export interface BoardRow {
  readonly id: string;
  readonly nick: string;
  readonly online: boolean;
  /** Balance plus open bags at the current price, minus every balance handed out. */
  readonly result: bigint;
  readonly refills: number;
}

export interface RoomSettings {
  readonly host: string;
  readonly pace: string;
  readonly breakSeconds: number;
}

export type ActionError =
  | "bad_message"
  | "stale_seq"
  | "coin_changed"
  | "host_only"
  | "not_broke"
  | "bad_setting"
  | "bad_coin"
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

export type ServerMsg =
  | {
      readonly t: "welcome";
      readonly you: { readonly id: string; readonly nick: string; readonly token: string };
      readonly code: string;
      readonly settings: RoomSettings;
      readonly lanes: readonly LaneView[];
      readonly history: readonly FinishedCoin[];
      readonly feed: readonly FeedItem[];
      readonly me: MeView;
      readonly board: readonly BoardRow[];
      /** Highest action number already used by this seat; the next one must be larger. */
      readonly lastSeq: number;
    }
  | { readonly t: "step"; readonly lane: number; readonly roundId: string; readonly rec: PackedTick }
  // "end" and the welcome's history carry no tick records: the client keeps
  // the ticks it was sent live, and replays older coins from their seed.
  | { readonly t: "launch"; readonly lane: number; readonly roundId: string }
  | { readonly t: "coin"; readonly lane: LaneView }
  | { readonly t: "end"; readonly lane: number; readonly coin: FinishedCoin }
  | { readonly t: "feed"; readonly item: FeedItem }
  | { readonly t: "me"; readonly me: MeView }
  | { readonly t: "board"; readonly rows: readonly BoardRow[] }
  | { readonly t: "settings"; readonly settings: RoomSettings }
  | { readonly t: "waits"; readonly units: readonly number[] }
  | { readonly t: "ack"; readonly seq: number; readonly ok: boolean; readonly error?: ActionError }
  | { readonly t: "error"; readonly error: "room_full" | "bad_nick" | "bad_room" | "bad_message" | "replaced" | "rate_limited" };

export type ClientMsg =
  | { readonly t: "hello"; readonly room: string | null; readonly nick: string; readonly token: string | null }
  | { readonly t: "buy"; readonly seq: number; readonly lane: number; readonly roundId: string; readonly stake: bigint }
  | { readonly t: "sell"; readonly seq: number; readonly lane: number; readonly roundId: string; readonly bps: bigint }
  | { readonly t: "initials"; readonly seq: number; readonly lane: number; readonly roundId: string }
  | { readonly t: "skip"; readonly seq: number; readonly lane: number }
  | { readonly t: "pace"; readonly seq: number; readonly pace: string }
  | { readonly t: "break"; readonly seq: number; readonly seconds: number }
  | { readonly t: "refill"; readonly seq: number };

export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? { $b: v.toString() } : v));
}

/** Parses a server frame (an array of messages). Trusts the server's shapes. */
export function decodeServer(text: string): ServerMsg[] {
  const out: unknown = JSON.parse(text, (_k, v: unknown) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const b = (v as { $b?: unknown }).$b;
      if (keys.length === 1 && typeof b === "string" && /^-?[0-9]+$/.test(b)) return BigInt(b);
    }
    return v;
  });
  if (!Array.isArray(out)) throw new Error("server frame is not a list");
  return out as ServerMsg[];
}

// --- Client messages: the server trusts nothing and checks every field. ---

const NICK_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

/**
 * Trimmed, single-spaced nickname, or null if it is not allowed. Full-width
 * and other compatibility forms are folded (NFKC), and letters from two
 * scripts in one name (a Cyrillic "А" inside "Ana") are refused, so one
 * player cannot pose as another.
 */
export function cleanNick(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const nick = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!NICK_RE.test(nick)) return null;
  const letters = [...nick].filter((ch) => /\p{L}/u.test(ch));
  const used = SCRIPTS.filter((re) => letters.some((ch) => re.test(ch))).length;
  const other = letters.some((ch) => !SCRIPTS.some((re) => re.test(ch)));
  return used + (other ? 1 : 0) > 1 ? null : nick;
}

// Cyrillic and Greek letters that look like Latin ones. Capitals are mapped
// before lowercasing: Greek "Ν" looks like "N" but its lowercase "ν" like "v".
const LOOKALIKE_UPPER: Record<string, string> = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S", Ь: "b",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};
const LOOKALIKE_LOWER: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ь: "b",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ζ: "z", η: "n",
};

/** What a nickname looks like, for telling apart two names that render the same. */
export function nickSkeleton(nick: string): string {
  const upper = [...nick.normalize("NFKC")].map((ch) => LOOKALIKE_UPPER[ch] ?? ch).join("");
  return [...upper.toLowerCase()].map((ch) => LOOKALIKE_LOWER[ch] ?? ch).join("").replace(/0/g, "o").replace(/[1l]/g, "i");
}

function isSeq(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isLane(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < LANES;
}

function isRoundId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 24 && /^[a-z]+-[0-9]+$/.test(v);
}

function amount(v: unknown, max: number): bigint | null {
  // Amounts come as {"$b": "<digits>"}; plain numbers are refused so nothing is ever rounded.
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  const b = (v as { $b?: unknown }).$b;
  if (keys.length !== 1 || typeof b !== "string" || !/^[1-9][0-9]{0,15}$/.test(b)) return null;
  const n = BigInt(b);
  return n <= BigInt(max) ? n : null;
}

/** Parses one client message; anything malformed or with extra fields is null. */
export function parseClient(text: string): ClientMsg | null {
  if (typeof text !== "string" || text.length > MAX_CLIENT_MESSAGE) return null;
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  switch (o.t) {
    case "hello": {
      if (keys !== "nick,room,t,token") return null;
      const room = o.room === null ? null : typeof o.room === "string" && /^[a-z0-9]{6}$/.test(o.room) ? o.room : undefined;
      const token = o.token === null ? null : typeof o.token === "string" && /^[0-9a-f]{32}$/.test(o.token) ? o.token : undefined;
      if (room === undefined || token === undefined || typeof o.nick !== "string") return null;
      return { t: "hello", room, nick: o.nick, token };
    }
    case "buy": {
      if (keys !== "lane,roundId,seq,stake,t" || !isSeq(o.seq) || !isLane(o.lane) || !isRoundId(o.roundId)) return null;
      const stake = amount(o.stake, 1e15);
      return stake === null ? null : { t: "buy", seq: o.seq, lane: o.lane, roundId: o.roundId, stake };
    }
    case "sell": {
      if (keys !== "bps,lane,roundId,seq,t" || !isSeq(o.seq) || !isLane(o.lane) || !isRoundId(o.roundId)) return null;
      const bps = amount(o.bps, 10_000);
      return bps === null ? null : { t: "sell", seq: o.seq, lane: o.lane, roundId: o.roundId, bps };
    }
    case "initials":
      if (keys !== "lane,roundId,seq,t" || !isSeq(o.seq) || !isLane(o.lane) || !isRoundId(o.roundId)) return null;
      return { t: "initials", seq: o.seq, lane: o.lane, roundId: o.roundId };
    case "skip":
      if (keys !== "lane,seq,t" || !isSeq(o.seq) || !isLane(o.lane)) return null;
      return { t: "skip", seq: o.seq, lane: o.lane };
    case "pace":
      if (keys !== "pace,seq,t" || !isSeq(o.seq) || typeof o.pace !== "string" || o.pace.length > 16) return null;
      return { t: "pace", seq: o.seq, pace: o.pace };
    case "break":
      if (keys !== "seconds,seq,t" || !isSeq(o.seq) || typeof o.seconds !== "number" || !Number.isInteger(o.seconds)) return null;
      return { t: "break", seq: o.seq, seconds: o.seconds };
    case "refill":
      if (keys !== "seq,t" || !isSeq(o.seq)) return null;
      return { t: "refill", seq: o.seq };
    default:
      return null;
  }
}
