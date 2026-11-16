// Room and pacing numbers. The math lives in the engine config; these only
// decide how the game is shown and shared.

export interface Pace {
  readonly id: string;
  readonly ticksPerSecond: number;
}

/** Pace only changes how fast ticks are played. The math is per tick, so every pace is the same game. */
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
export const WAIT_UNITS = 24;
/** Tickers not reused for this many coins; the bank has 120, three are on screen. */
export const RECENT_TICKERS = 60;
/** Ended coins a room keeps for late joiners and the verify view. */
export const HISTORY_SIZE = 12;
export const FEED_SIZE = 60;

export const MAX_PLAYERS = 5;
/** A player who drops out keeps their seat and bags this long. */
export const SEAT_HOLD_MS = 10 * 60_000;
/** Largest message a client may send, in bytes. */
export const MAX_CLIENT_MESSAGE = 1024;

export const ROOM_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const ROOM_CODE_LENGTH = 6;
