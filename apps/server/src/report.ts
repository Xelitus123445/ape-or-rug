// Playtest report from the recorded events (data/events.jsonl). Pure: reads
// a list of events, returns numbers. Definitions, so a hand count can check
// them:
//
// - A player is one anonymous id. Repeat visits are the same player.
// - A player's first session is the session id of their earliest event.
// - A round is one coin the player bought into (round_join), counted once
//   per coin (by its commit) within the session.
// - Guided round: started = saw tip 0; finished = closed the tips by selling.
// - Next-day return: any event on the calendar day after the first one.
//   Within 3 days: any event on days 1-3 after. Only players whose window
//   has fully passed before the last recorded event are counted.
// - Group = the player's source tag on their first event ("none" if absent).

import type { TrackedEvent } from "./telemetry.ts";

export interface ReportOptions {
  /** Source tags whose players are left out (the developers' own play). */
  readonly excludeSources?: readonly string[];
  /** Anonymous ids left out. */
  readonly excludeAnons?: readonly string[];
  /** Hours added to UTC to decide calendar days (e.g. 3 for Moscow). */
  readonly tzHours?: number;
}

export interface Quartiles {
  readonly n: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
}

export interface GroupReport {
  readonly group: string;
  readonly players: number;
  readonly tutorialStarted: number;
  readonly tutorialFinished: number;
  readonly tutorialSkipped: number;
  /** Rounds in each player's first session. */
  readonly firstSessionRounds: Quartiles;
  /** Count of players per bucket: 0, 1, 2-4, 5-9, 10-19, 20+. */
  readonly roundBuckets: Readonly<Record<string, number>>;
  readonly tenPlus: number;
  readonly nextDay: { readonly eligible: number; readonly returned: number };
  readonly within3Days: { readonly eligible: number; readonly returned: number };
  /** First-session length in minutes. */
  readonly firstSessionMinutes: Quartiles;
  /** How the last round of the first session ended, for players with at least one round. */
  readonly lastRound: Readonly<Record<"rugged" | "won" | "lost" | "open", number>>;
  /** Rounds joined per coin profile (0 degen, 1 mid, 2 runner), all sessions. */
  readonly profileRounds: readonly number[];
  /** Ticks from a player's first buy on a coin to their first sell or the rug, all sessions. */
  readonly holdTicks: Quartiles;
}

export interface Report {
  readonly events: number;
  readonly excludedPlayers: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly groups: readonly GroupReport[];
}

export const BUCKETS = ["0", "1", "2-4", "5-9", "10-19", "20+"] as const;

function bucket(n: number): string {
  return n === 0 ? "0" : n === 1 ? "1" : n <= 4 ? "2-4" : n <= 9 ? "5-9" : n <= 19 ? "10-19" : "20+";
}

/** Quartiles by linear interpolation between closest ranks. */
export function quartiles(values: readonly number[]): Quartiles {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    if (v.length === 0) return 0;
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return v[lo]! + (v[hi]! - v[lo]!) * (i - lo);
  };
  return { n: v.length, q1: at(0.25), median: at(0.5), q3: at(0.75) };
}

const DAY = 86_400_000;

interface Player {
  readonly anon: string;
  readonly events: TrackedEvent[];
  group: string;
}

/** Parses JSONL text; lines that are not events are skipped and counted. */
export function parseEvents(text: string): { events: TrackedEvent[]; bad: number } {
  const events: TrackedEvent[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as TrackedEvent;
      if (typeof e.event === "string" && typeof e.anon === "string" && typeof e.ts === "string" && !Number.isNaN(Date.parse(e.ts))) events.push(e);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { events, bad };
}

export function buildReport(all: readonly TrackedEvent[], opts: ReportOptions = {}): Report {
  const excludeSources = new Set(opts.excludeSources ?? ["dev"]);
  const excludeAnons = new Set(opts.excludeAnons ?? []);
  const tz = (opts.tzHours ?? 0) * 3_600_000;
  const day = (ts: string): number => Math.floor((Date.parse(ts) + tz) / DAY);
  const sorted = [...all].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const players = new Map<string, Player>();
  for (const e of sorted) {
    let p = players.get(e.anon);
    if (p === undefined) {
      p = { anon: e.anon, events: [], group: e.source ?? "none" };
      players.set(e.anon, p);
    }
    p.events.push(e);
  }
  let excluded = 0;
  for (const p of [...players.values()]) {
    if (excludeAnons.has(p.anon) || excludeSources.has(p.group)) {
      players.delete(p.anon);
      excluded++;
    }
  }
  const lastTs = sorted.length > 0 ? sorted[sorted.length - 1]!.ts : null;
  const lastDay = lastTs === null ? 0 : day(lastTs);

  const groupNames = [...new Set([...players.values()].map((p) => p.group))].sort();
  const groups = ["all", ...groupNames].map((g) => groupReport(g, [...players.values()].filter((p) => g === "all" || p.group === g), day, lastDay));
  return { events: sorted.length, excludedPlayers: excluded, from: sorted[0]?.ts ?? null, to: lastTs, groups };
}

function groupReport(group: string, players: readonly Player[], day: (ts: string) => number, lastDay: number): GroupReport {
  let tutorialStarted = 0, tutorialFinished = 0, tutorialSkipped = 0, tenPlus = 0;
  const rounds: number[] = [];
  const minutes: number[] = [];
  const holds: number[] = [];
  const roundBuckets: Record<string, number> = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const lastRound = { rugged: 0, won: 0, lost: 0, open: 0 };
  const profileRounds = [0, 0, 0];
  const nextDay = { eligible: 0, returned: 0 };
  const within3Days = { eligible: 0, returned: 0 };

  for (const p of players) {
    const ev = p.events;
    const tips = ev.filter((e) => e.event === "tutorial_step");
    if (tips.some((e) => e.props.step === 0 && e.props.outcome === "shown")) tutorialStarted++;
    if (tips.some((e) => e.props.outcome === "done")) tutorialFinished++;
    else if (tips.some((e) => e.props.outcome === "skipped")) tutorialSkipped++;

    // First session: rounds, length and how its last round ended.
    const first = ev[0]!.session;
    const inFirst = ev.filter((e) => e.session === first);
    const joined: string[] = [];
    for (const e of inFirst) {
      const c = String(e.props.commit);
      if (e.event === "round_join" && !joined.includes(c)) joined.push(c);
    }
    rounds.push(joined.length);
    roundBuckets[bucket(joined.length)]!++;
    if (joined.length >= 10) tenPlus++;
    const start = Date.parse(inFirst[0]!.ts);
    const end = Math.max(...inFirst.map((e) => (e.event === "session_end" && typeof e.props.duration_s === "number" ? start + e.props.duration_s * 1000 : Date.parse(e.ts))));
    minutes.push((end - start) / 60_000);
    const lastCoin = joined[joined.length - 1];
    if (lastCoin !== undefined) {
      const endEv = inFirst.find((e) => e.event === "round_end" && e.props.commit === lastCoin);
      if (endEv === undefined) lastRound.open++;
      else if (endEv.props.outcome === "rugged" && inFirst.some((e) => e.event === "rugged" && e.props.commit === lastCoin)) lastRound.rugged++;
      else if (Number(endEv.props.paid) >= Number(endEv.props.staked)) lastRound.won++;
      else lastRound.lost++;
    }

    // Return: any event on a later calendar day, counted only once the window has passed.
    const d0 = day(ev[0]!.ts);
    const days = new Set(ev.map((e) => day(e.ts)));
    if (lastDay > d0 + 1) {
      nextDay.eligible++;
      if (days.has(d0 + 1)) nextDay.returned++;
    }
    if (lastDay > d0 + 3) {
      within3Days.eligible++;
      if (days.has(d0 + 1) || days.has(d0 + 2) || days.has(d0 + 3)) within3Days.returned++;
    }

    // All sessions: which coin kinds and how long the bag was held.
    const firstBuy = new Map<string, number>();
    const closed = new Set<string>();
    for (const e of ev) {
      const c = String(e.props.commit);
      if (e.event === "round_join" && typeof e.props.profile === "number") profileRounds[e.props.profile] = (profileRounds[e.props.profile] ?? 0) + 1;
      if (e.event === "buy" && !firstBuy.has(c) && typeof e.props.tick === "number") firstBuy.set(c, e.props.tick);
      if ((e.event === "sell" || e.event === "rugged") && firstBuy.has(c) && !closed.has(c) && typeof e.props.tick === "number") {
        closed.add(c);
        holds.push(e.props.tick - firstBuy.get(c)!);
      }
    }
  }

  return {
    group,
    players: players.length,
    tutorialStarted,
    tutorialFinished,
    tutorialSkipped,
    firstSessionRounds: quartiles(rounds),
    roundBuckets,
    tenPlus,
    nextDay,
    within3Days,
    firstSessionMinutes: quartiles(minutes),
    lastRound,
    profileRounds,
    holdTicks: quartiles(holds),
  };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((100 * part) / whole)}% (${part}/${whole})`;
}

function q(x: Quartiles, digits = 0): string {
  return x.n === 0 ? "—" : `${x.median.toFixed(digits)} (IQR ${x.q1.toFixed(digits)}–${x.q3.toFixed(digits)}, n=${x.n})`;
}

/** The report as Markdown, one column per group. */
export function formatReport(r: Report): string {
  const g = r.groups;
  const row = (label: string, f: (x: GroupReport) => string): string => `| ${label} | ${g.map(f).join(" | ")} |`;
  const lines = [
    `Events: ${r.events}, from ${r.from ?? "—"} to ${r.to ?? "—"}. Players left out (dev tag or listed ids): ${r.excludedPlayers}.`,
    "",
    `| | ${g.map((x) => x.group).join(" | ")} |`,
    `|---|${g.map(() => "---").join("|")}|`,
    row("Players", (x) => String(x.players)),
    row("Small sample (<30)", (x) => (x.players < 30 ? "yes" : "no")),
    row("Guided round started", (x) => pct(x.tutorialStarted, x.players)),
    row("Guided round finished", (x) => pct(x.tutorialFinished, x.tutorialStarted)),
    row("Tips skipped", (x) => pct(x.tutorialSkipped, x.tutorialStarted)),
    row("Rounds in first session, median", (x) => q(x.firstSessionRounds, 1)),
    row("10+ rounds in first session", (x) => pct(x.tenPlus, x.players)),
    ...BUCKETS.map((b) => row(`  rounds ${b}`, (x) => String(x.roundBuckets[b] ?? 0))),
    row("Returned next day", (x) => pct(x.nextDay.returned, x.nextDay.eligible)),
    row("Returned within 3 days", (x) => pct(x.within3Days.returned, x.within3Days.eligible)),
    row("First session, minutes", (x) => q(x.firstSessionMinutes, 1)),
    row("Last round of first session: rugged", (x) => String(x.lastRound.rugged)),
    row("  won (got back ≥ stake)", (x) => String(x.lastRound.won)),
    row("  lost (sold below stake)", (x) => String(x.lastRound.lost)),
    row("  still open", (x) => String(x.lastRound.open)),
    row("Rounds joined: degen / mid / runner", (x) => x.profileRounds.join(" / ")),
    row("Hold, ticks from first buy", (x) => q(x.holdTicks)),
  ];
  return lines.join("\n");
}
