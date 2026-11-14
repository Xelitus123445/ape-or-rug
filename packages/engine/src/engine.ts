// Price engine: one coin, one tick at a time. Pure and integer-only.
// Nothing here knows about players, positions or balances.

import {
  DEFAULT_CONFIG,
  EVENT_NONE,
  PRICE_SCALE,
  REGIME_COUNT,
  STATUS_ALIVE,
  STATUS_RUGGED,
  STATUS_SETTLED,
  TABLE_SIZE,
  TWO_32,
  regimeParams,
} from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { HMAC_MAX_MESSAGE, HmacKey, asciiBytes, sha256, toHex } from "./sha256.ts";
import { TABLES_SHA256 } from "./tables.checksum.ts";
import { TABLE_LINES } from "./tables.generated.ts";

export interface ParsedTable {
  readonly H: bigint;
  readonly sigmaPpb: bigint;
  readonly g: readonly bigint[];
}

/** Verifies the checksum of the committed tables and parses them. Throws on any mismatch. */
export function loadTables(lines: readonly string[] = TABLE_LINES, checksum: string = TABLES_SHA256): ParsedTable[] {
  const actual = toHex(sha256(asciiBytes(lines.join("\n"))));
  if (actual !== checksum) {
    throw new Error(`growth tables checksum mismatch: expected ${checksum}, got ${actual}`);
  }
  if (lines.length !== REGIME_COUNT) throw new Error("growth tables: wrong table count");
  return lines.map((line, i) => {
    const parts = line.split(":");
    if (parts.length !== 4 || parts[0] !== String(i)) throw new Error(`growth table ${i}: bad header`);
    const g = parts[3]!.split(",").map((x) => BigInt(x));
    if (g.length !== TABLE_SIZE) throw new Error(`growth table ${i}: wrong size`);
    return { H: BigInt(parts[1]!), sigmaPpb: BigInt(parts[2]!), g };
  });
}

export interface Engine {
  readonly config: EngineConfig;
  /** Rug threshold per regime, an integer in [0, 2^32). */
  readonly hazard: readonly number[];
  readonly tables: readonly (readonly bigint[])[];
  readonly eventStartThreshold: number;
  readonly eventDurationRange: number;
}

let cachedTables: ParsedTable[] | null = null;

/**
 * Builds an engine for a config. The committed tables must match the regimes
 * the config describes, otherwise this throws: a table is only fair for the
 * hazard it was built for.
 */
export function createEngine(config: EngineConfig = DEFAULT_CONFIG): Engine {
  if (cachedTables === null) cachedTables = loadTables();
  const tables = cachedTables;
  const params = regimeParams(config);
  const hazard: number[] = [];
  for (let i = 0; i < REGIME_COUNT; i++) {
    const p = params[i]!;
    const t = tables[i]!;
    if (p.H !== t.H || p.sigmaPpb !== t.sigmaPpb) {
      throw new Error(`config does not match growth table ${i}; regenerate tables (pnpm gen:tables)`);
    }
    hazard.push(Number(t.H));
  }
  const range = config.eventMaxTicks - config.eventMinTicks + 1;
  if (range < 1 || range > 32) throw new Error("event duration range must be 1..32 ticks");
  if (config.maxTicks < 1 || config.maxTicks > 9_999_999) throw new Error("maxTicks out of range");
  if (config.coinsPerRound < 1 || config.coinsPerRound > 9) throw new Error("coinsPerRound out of range");
  const start = (TWO_32 * config.eventStart.num) / config.eventStart.den;
  if (start < 0n || start >= TWO_32) throw new Error("eventStart out of range");
  return {
    config,
    hazard,
    tables: tables.map((t) => t.g),
    eventStartThreshold: Number(start),
    eventDurationRange: range,
  };
}

const ROUND_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

/** HMAC key state of one round; shared by the round's coins. */
export class RoundKey {
  readonly hmac: HmacKey;
  readonly roundId: string;

  constructor(serverSeed: Uint8Array, roundId: string) {
    if (serverSeed.length !== 32) throw new Error("serverSeed must be 32 bytes");
    if (!ROUND_ID_PATTERN.test(roundId)) throw new Error("roundId must be 1-48 chars of [A-Za-z0-9_-]");
    this.hmac = new HmacKey(serverSeed);
    this.roundId = roundId;
  }
}

/**
 * Random stream of one coin: digest(tick, n) = HMAC-SHA256(serverSeed,
 * "roundId:coinIndex:tick:n") as eight 32-bit words.
 */
export class CoinStream {
  private readonly hmac: HmacKey;
  private readonly msg = new Uint8Array(HMAC_MAX_MESSAGE);
  private readonly prefixLen: number;

  /** `coinIndex` is the coin's number, or the label "p" for the round's profile draw. */
  constructor(key: RoundKey, coinIndex: number | "p") {
    this.hmac = key.hmac;
    const prefix = asciiBytes(`${key.roundId}:${coinIndex}:`);
    this.msg.set(prefix);
    this.prefixLen = prefix.length;
  }

  digest(tick: number, n: number, out: Int32Array): void {
    const s = `${tick}:${n}`;
    const msg = this.msg;
    let len = this.prefixLen;
    for (let i = 0; i < s.length; i++) msg[len++] = s.charCodeAt(i);
    this.hmac.digestWords(msg, len, out);
  }
}

/**
 * Uniform integer in [0, n) by rejection sampling over fixed `bits`-wide
 * chunks of words[first..first+count). Returns -1 if every chunk was rejected.
 */
function pickFromWords(words: Int32Array, first: number, count: number, bits: number, n: number): number {
  const mask = (1 << bits) - 1;
  for (let w = first; w < first + count; w++) {
    const word = words[w]!;
    for (let shift = 32 - bits; shift >= 0; shift -= bits) {
      const v = (word >>> shift) & mask;
      if (v < n) return v;
    }
  }
  return -1;
}

const MAX_OVERFLOW_DIGESTS = 64;

/** Continues rejection sampling in digests n = firstN, firstN + stepN, ... */
function pickFromOverflow(stream: CoinStream, tick: number, firstN: number, stepN: number, bits: number, n: number, scratch: Int32Array): number {
  for (let k = 0; k < MAX_OVERFLOW_DIGESTS; k++) {
    stream.digest(tick, firstN + k * stepN, scratch);
    const v = pickFromWords(scratch, 0, 8, bits, n);
    if (v >= 0) return v;
  }
  throw new Error("rejection sampling did not terminate");
}

export interface CoinState {
  profile: number;
  status: number;
  /** Price multiplier scaled by PRICE_SCALE. */
  price: bigint;
  tick: number;
  /** Event that will govern the next tick (EVENT_NONE if none). */
  event: number;
  eventLeft: number;
  graduated: boolean;
  /** Event that governed the tick just played. */
  tickEvent: number;
  /** True if an event started on the tick just played. */
  eventStarted: boolean;
  /** True if the coin graduated on the tick just played. */
  justGraduated: boolean;
}

const scratchMain = new Int32Array(8);
const scratchExtra = new Int32Array(8);

const PROFILE_ORDERS: readonly (readonly number[])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * Profiles of a round's coins: one degen, one mid and one runner, in an order
 * drawn from the round stream "roundId:p:0:n" (3-bit chunks, first chunk
 * below 6 picks one of the six orders). Coin i gets order[i mod 3].
 */
export function roundProfiles(key: RoundKey, coins: number): number[] {
  const stream = new CoinStream(key, "p");
  stream.digest(0, 0, scratchMain);
  let pick = pickFromWords(scratchMain, 0, 8, 3, 6);
  if (pick < 0) pick = pickFromOverflow(stream, 0, 1, 1, 3, 6, scratchExtra);
  const order = PROFILE_ORDERS[pick]!;
  const out: number[] = [];
  for (let i = 0; i < coins; i++) out.push(order[i % 3]!);
  return out;
}

/** Launch state of a coin with the given profile: tick 0, price 1.00x. */
export function launchCoin(profile: number): CoinState {
  if (profile !== 0 && profile !== 1 && profile !== 2) throw new Error("launchCoin: bad profile");
  return {
    profile,
    status: STATUS_ALIVE,
    price: PRICE_SCALE,
    tick: 0,
    event: EVENT_NONE,
    eventLeft: 0,
    graduated: false,
    tickEvent: EVENT_NONE,
    eventStarted: false,
    justGraduated: false,
  };
}

/**
 * Plays one tick of a live coin, mutating `c`. Fixed layout of digest n = 0:
 * word 0 event start, word 1 rug check, word 2 (top 10 bits) growth index,
 * word 3 event type (2-bit chunks), words 4-7 event duration (5-bit chunks).
 * Every field has its own bits, so the layout never depends on state.
 */
export function stepCoin(engine: Engine, stream: CoinStream, c: CoinState): void {
  if (c.status !== STATUS_ALIVE) return;
  const w = scratchMain;
  const tick = c.tick + 1;
  stream.digest(tick, 0, w);

  c.eventStarted = false;
  c.justGraduated = false;
  if (c.event === EVENT_NONE && w[0]! >>> 0 < engine.eventStartThreshold) {
    let type = pickFromWords(w, 3, 1, 2, 3);
    if (type < 0) type = pickFromOverflow(stream, tick, 1, 2, 2, 3, scratchExtra);
    let dur = pickFromWords(w, 4, 4, 5, engine.eventDurationRange);
    if (dur < 0) dur = pickFromOverflow(stream, tick, 2, 2, 5, engine.eventDurationRange, scratchExtra);
    c.event = type + 1;
    c.eventLeft = engine.config.eventMinTicks + dur;
    c.eventStarted = true;
  }

  const regime = c.profile * 8 + c.event * 2 + (c.graduated ? 1 : 0);
  c.tick = tick;
  c.tickEvent = c.event;

  if (w[1]! >>> 0 < engine.hazard[regime]!) {
    c.price = 0n;
    c.status = STATUS_RUGGED;
    return;
  }

  c.price = (c.price * engine.tables[regime]![w[2]! >>> 22]!) / PRICE_SCALE;
  if (!c.graduated && c.price >= engine.config.graduation.price) {
    c.graduated = true;
    c.justGraduated = true;
  }
  if (c.event !== EVENT_NONE) {
    c.eventLeft -= 1;
    if (c.eventLeft === 0) c.event = EVENT_NONE;
  }
  if (tick === engine.config.maxTicks) c.status = STATUS_SETTLED;
}

export interface TickRecord {
  readonly tick: number;
  readonly price: bigint;
  readonly status: number;
  readonly tickEvent: number;
  readonly event: number;
  readonly eventLeft: number;
  readonly graduated: boolean;
  readonly eventStarted: boolean;
  readonly justGraduated: boolean;
}

export interface CoinPath {
  readonly coinIndex: number;
  readonly profile: number;
  /** ticks[0] is the launch state (tick 0, price 1.00x). */
  readonly ticks: readonly TickRecord[];
}

export interface Round {
  readonly roundId: string;
  readonly coins: readonly CoinPath[];
}

export function snapshot(c: CoinState): TickRecord {
  return {
    tick: c.tick,
    price: c.price,
    status: c.status,
    tickEvent: c.tickEvent,
    event: c.event,
    eventLeft: c.eventLeft,
    graduated: c.graduated,
    eventStarted: c.eventStarted,
    justGraduated: c.justGraduated,
  };
}

/** The whole round for a seed: every coin played to its rug or settlement. */
export function generateRound(engine: Engine, serverSeed: Uint8Array, roundId: string): Round {
  const key = new RoundKey(serverSeed, roundId);
  const coins: CoinPath[] = [];
  const profiles = roundProfiles(key, engine.config.coinsPerRound);
  for (let i = 0; i < engine.config.coinsPerRound; i++) {
    const stream = new CoinStream(key, i);
    const c = launchCoin(profiles[i]!);
    const ticks: TickRecord[] = [snapshot(c)];
    while (c.status === STATUS_ALIVE) {
      stepCoin(engine, stream, c);
      ticks.push(snapshot(c));
    }
    coins.push({ coinIndex: i, profile: c.profile, ticks });
  }
  return { roundId, coins };
}

/** Canonical text of a round: one line per coin tick. */
export function roundCanonicalText(round: Round): string {
  const lines: string[] = [];
  for (const coin of round.coins) {
    lines.push(`coin:${coin.coinIndex}:profile:${coin.profile}`);
    for (const t of coin.ticks) {
      lines.push(`${coin.coinIndex}:${t.tick}:${t.price}:${t.status}:${t.tickEvent}:${t.event}:${t.eventLeft}:${t.graduated ? 1 : 0}`);
    }
  }
  return lines.join("\n");
}

/** SHA-256 (hex) over the canonical text; equal hashes mean bit-identical rounds. */
export function roundHash(round: Round): string {
  return toHex(sha256(asciiBytes(roundCanonicalText(round))));
}

/** Commitment published before the round: SHA-256 of the server seed. */
export function commitOf(serverSeed: Uint8Array): string {
  return toHex(sha256(serverSeed));
}

export function verifyCommit(serverSeed: Uint8Array, commit: string): boolean {
  return commitOf(serverSeed) === commit.toLowerCase();
}

export { STATUS_ALIVE, STATUS_RUGGED, STATUS_SETTLED };
