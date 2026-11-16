// Checks an ended coin: its seed against the commit shown before launch, a
// full replay from the seed, and every fact about the coin the screen shows.
// Runs on the client with the client's own copy of the engine.

import { STATUS_RUGGED, fromHex, generateCoinRound, laneProfile, roundHash, verifyCommit } from "@ape/engine";
import type { Engine, TickRecord } from "@ape/engine";
import type { FinishedCoin } from "./protocol.ts";

export interface Verification {
  readonly commitOk: boolean;
  readonly roundOk: boolean;
  readonly playedHash: string;
  readonly recomputedHash: string;
}

/** Never throws: anything malformed is reported as a failed check. */
export function verifyCoin(engine: Engine, coin: FinishedCoin): Verification {
  const failed: Verification = { commitOk: false, roundOk: false, playedHash: "", recomputedHash: "" };
  try {
    if (typeof coin.seed !== "string" || !/^[0-9a-f]{64}$/.test(coin.seed)) return failed;
    // The profile for the replay is read from the round id, which the commit
    // covers, not from what the screen claimed. An unknown name fails the check.
    const profile = laneProfile(coin.roundId);
    if (profile < 0) return failed;
    const seed = fromHex(coin.seed);
    const commitOk = verifyCommit(seed, coin.roundId, coin.commit);
    const replay = generateCoinRound(engine, seed, coin.roundId);
    const ticks = replay.coins[0]!.ticks;
    const last = ticks[ticks.length - 1]!;
    let peak = 0n;
    for (const t of ticks) if (t.price > peak) peak = t.price;
    const endPrice = last.status === STATUS_RUGGED ? ticks[ticks.length - 2]!.price : last.price;
    const recomputedHash = roundHash(replay);
    const factsOk = coin.profile === profile && coin.status === last.status && coin.ticks === last.tick && coin.peak === peak && coin.endPrice === endPrice;
    // A coin that ended before this player joined comes without ticks: only
    // the facts shown about it (profile, end, peak, length) can be checked.
    if (coin.records.length === 0) return { commitOk, roundOk: factsOk, playedHash: "", recomputedHash };
    const playedHash = roundHash({ roundId: coin.roundId, coins: [{ coinIndex: 0, profile: coin.profile, ticks: coin.records }] });
    return { commitOk, roundOk: playedHash === recomputedHash && factsOk && sameRecords(coin.records, ticks), playedHash, recomputedHash };
  } catch {
    return failed;
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
