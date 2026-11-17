// The playtest report against a small sample counted by hand. Each expected
// number below is worked out in the comments from the events listed.
import { describe, expect, it } from "vitest";
import { buildReport, formatReport, parseEvents, quartiles } from "../src/report.ts";
import type { PropValue, TrackedEvent } from "../src/telemetry.ts";

const DAY0 = Date.parse("2026-11-02T10:00:00Z");

function ev(anon: string, session: string, source: string | null, day: number, minute: number, event: string, props: Record<string, PropValue> = {}): TrackedEvent {
  return { ts: new Date(DAY0 + day * 86_400_000 + minute * 60_000).toISOString(), event, anon, session, source, room: "abc234", props };
}

function round(anon: string, session: string, source: string | null, day: number, minute: number, commit: string, profile: number): TrackedEvent {
  return ev(anon, session, source, day, minute, "round_join", { commit, profile, lane: profile, roundId: `x-${commit}` });
}

// A (crypto): first session on day 0 with the full guided round and two rounds;
//   the second round rugs while held. Back on day 1.
// B (general): saw the first tip and skipped it, played nothing; back on day 4 only.
// C (crypto): ten rounds on day 0, the last one sold below stake; back on day 2.
// D (dev): the developer, left out.
// E (no tag): one round on day 1 that has not ended.
const SAMPLE: TrackedEvent[] = [
  ev("A", "a1", "crypto", 0, 0, "session_start"),
  ev("A", "a1", "crypto", 0, 0, "tutorial_step", { step: 0, outcome: "shown" }),
  round("A", "a1", "crypto", 0, 1, "c1", 0),
  ev("A", "a1", "crypto", 0, 1, "buy", { commit: "c1", tick: 5 }),
  ev("A", "a1", "crypto", 0, 2, "sell", { commit: "c1", tick: 12 }),
  ev("A", "a1", "crypto", 0, 2, "tutorial_step", { step: 2, outcome: "done" }),
  ev("A", "a1", "crypto", 0, 3, "round_end", { commit: "c1", outcome: "settled", staked: 100, paid: 150 }),
  round("A", "a1", "crypto", 0, 4, "c2", 1),
  ev("A", "a1", "crypto", 0, 4, "buy", { commit: "c2", tick: 3 }),
  ev("A", "a1", "crypto", 0, 5, "rugged", { commit: "c2", tick: 9 }),
  ev("A", "a1", "crypto", 0, 5, "round_end", { commit: "c2", outcome: "rugged", staked: 100, paid: 0 }),
  ev("A", "a1", "crypto", 0, 10, "session_end", { duration_s: 600 }),
  ev("A", "a2", "crypto", 1, 0, "session_start"),
  round("A", "a2", "crypto", 1, 1, "c3", 2),

  ev("B", "b1", "general", 0, 30, "session_start"),
  ev("B", "b1", "general", 0, 30, "tutorial_step", { step: 0, outcome: "shown" }),
  ev("B", "b1", "general", 0, 30, "tutorial_step", { step: 0, outcome: "skipped" }),
  ev("B", "b1", "general", 0, 31, "session_end", { duration_s: 60 }),
  ev("B", "b2", "general", 4, 0, "session_start"),

  ev("C", "c1s", "crypto", 0, 60, "session_start"),
  ...Array.from({ length: 10 }, (_, i) => round("C", "c1s", "crypto", 0, 61 + i, `k${i}`, 0)),
  ev("C", "c1s", "crypto", 0, 75, "round_end", { commit: "k9", outcome: "settled", staked: 100, paid: 50 }),
  ev("C", "c1s", "crypto", 0, 80, "session_end", { duration_s: 1200 }),
  ev("C", "c2s", "crypto", 2, 0, "session_start"),

  ev("D", "d1", "dev", 0, 0, "session_start"),
  round("D", "d1", "dev", 0, 1, "c1", 0),

  ev("E", "e1", null, 1, 0, "session_start"),
  round("E", "e1", null, 1, 0.5, "c9", 1),
];

describe("playtest report", () => {
  it("matches a hand count on a small sample", () => {
    // Shuffled order must not matter.
    const r = buildReport([...SAMPLE].reverse());
    expect(r.excludedPlayers).toBe(1); // D
    const all = r.groups.find((g) => g.group === "ALL")!;
    expect(all.players).toBe(4); // A B C E
    expect([all.tutorialStarted, all.tutorialFinished, all.tutorialSkipped]).toEqual([2, 1, 1]); // A and B saw it; A finished; B skipped
    // First-session rounds: A 2, B 0, C 10, E 1 -> sorted 0 1 2 10.
    expect(all.firstSessionRounds).toEqual({ n: 4, q1: 0.75, median: 1.5, q3: 4 });
    expect(all.roundBuckets).toEqual({ "0": 1, "1": 1, "2-4": 1, "5-9": 0, "10-19": 1, "20+": 0 });
    expect(all.tenPlus).toBe(1); // C
    // Last event is day 4. Next day: all four eligible, only A came back on day+1.
    expect(all.nextDay).toEqual({ eligible: 4, returned: 1 });
    // Within 3 days: A B C eligible (first day 0), E is not (day 1 + 3 = 4 is not over). A and C came back.
    expect(all.within3Days).toEqual({ eligible: 3, returned: 2 });
    // Minutes: A 10, B 1, C 20, E 0.5 -> median 5.5.
    expect(all.firstSessionMinutes.median).toBeCloseTo(5.5);
    expect(all.lastRound).toEqual({ rugged: 1, won: 0, lost: 1, open: 1 }); // A rugged, C sold below stake, E open
    // Rounds by profile over all sessions: degen A c1 + C x10, mid A c2 + E, runner A c3.
    expect(all.profileRounds).toEqual([11, 2, 1]);
    // Holds: A c1 12-5 = 7, A c2 9-3 = 6.
    expect(all.holdTicks).toEqual({ n: 2, q1: 6.25, median: 6.5, q3: 6.75 });
  });

  it("keeps invite-link groups apart", () => {
    const r = buildReport(SAMPLE);
    expect(r.groups.map((g) => g.group)).toEqual(["ALL", "(none)", "crypto", "general"]);
    const crypto = r.groups.find((g) => g.group === "crypto")!;
    const general = r.groups.find((g) => g.group === "general")!;
    expect(crypto.players).toBe(2);
    expect(crypto.firstSessionRounds.median).toBe(6); // A 2, C 10
    expect(crypto.nextDay).toEqual({ eligible: 2, returned: 1 });
    expect(general.players).toBe(1);
    expect(general.firstSessionRounds.median).toBe(0);
    expect(general.tutorialSkipped).toBe(1);
    // A player keeps the group of their first visit even if a later link had another tag.
    const moved = buildReport([...SAMPLE, ev("B", "b3", "crypto", 4, 5, "session_start")]);
    expect(moved.groups.find((g) => g.group === "general")!.players).toBe(1);
    expect(moved.groups.find((g) => g.group === "crypto")!.players).toBe(2);
  });

  it("can leave out listed ids and read JSONL with junk lines", () => {
    const text = `${SAMPLE.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n{"x":1}\n`;
    const { events, bad } = parseEvents(text);
    expect(events.length).toBe(SAMPLE.length);
    expect(bad).toBe(2);
    const r = buildReport(events, { excludeAnons: ["A"], excludeSources: [] });
    expect(r.excludedPlayers).toBe(1);
    expect(r.groups[0]!.players).toBe(4); // B C D E
    expect(formatReport(r)).toContain("| Players | 4 |");
  });

  it("computes quartiles the usual way", () => {
    expect(quartiles([])).toEqual({ n: 0, q1: 0, median: 0, q3: 0 });
    expect(quartiles([5])).toEqual({ n: 1, q1: 5, median: 5, q3: 5 });
    expect(quartiles([1, 2, 3, 4, 5])).toEqual({ n: 5, q1: 2, median: 3, q3: 4 });
  });
});
