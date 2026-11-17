// Bug-hunt M4: playtest telemetry and report. Each test states the expected
// behaviour; a failing test is a finding.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RoomMirror, STAKES, encode } from "@ape/game";
import type { HelloTags } from "@ape/game";
import { startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";
import type { PropValue, TrackedEvent } from "../src/telemetry.ts";
import { buildReport } from "../src/report.ts";

let server: RunningServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

const hex = (n: number): string => n.toString(16).padStart(32, "0");

function connect(port: number, room: string | null, nick: string, tags: HelloTags | null, token: string | null = null): Promise<{ ws: WebSocket; mirror: RoomMirror; closed: Promise<void> }> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const mirror = new RoomMirror((text) => ws.send(text));
    const closed = new Promise<void>((c) => ws.on("close", () => c()));
    ws.on("open", () => ws.send(encode({ t: "hello", room, nick, token, ...(tags ?? {}) })));
    ws.on("message", (data) => {
      mirror.receive(data.toString());
      if (mirror.ready || mirror.fatal !== null) done({ ws, mirror, closed });
    });
    ws.on("error", fail);
  });
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("bug-hunt M4: telemetry poisoning", () => {
  it("one seat reconnecting with fresh random ids is still one player in the report", async () => {
    const events: TrackedEvent[] = [];
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, log: () => {}, track: (e) => events.push(e) });
    const first = await connect(server.port, null, "Ana", { anon: hex(1), session: hex(1), source: "general" });
    const code = first.mirror.code;
    const token = first.mirror.you!.token;
    // The same client (same seat token) reconnects 8 times, each time claiming a new anonymous id.
    for (let i = 2; i <= 9; i++) {
      const c = await connect(server.port, code, "Ana", { anon: hex(i), session: hex(i), source: "general" }, token);
      c.ws.close();
      await c.closed;
    }
    const r = buildReport(events);
    // Expected: one real person at one seat counts once. Actual: 9 "players", all with 0 rounds.
    expect(r.groups[0]!.players).toBe(1);
  });

  it("a repeated tutorial message is recorded once, not once per message", async () => {
    const events: TrackedEvent[] = [];
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, log: () => {}, track: (e) => events.push(e) });
    const a = await connect(server.port, null, "Ana", { anon: hex(1), session: hex(1), source: "general" });
    for (let i = 0; i < 30; i++) a.mirror.trackTutorial(0, "shown");
    await until(() => events.filter((e) => e.event === "tutorial_step").length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    // Expected 1 (step 0 shown once). Actual 30: every message is written to the file and PostHog.
    expect(events.filter((e) => e.event === "tutorial_step").length).toBe(1);
  });
});

describe("bug-hunt M4: report", () => {
  const DAY0 = Date.parse("2026-11-02T10:00:00Z");
  const ev = (anon: string, session: string, source: string | null, ms: number, event: string, props: Record<string, PropValue> = {}): TrackedEvent => ({
    ts: new Date(DAY0 + ms).toISOString(),
    event,
    anon,
    session,
    source,
    room: "abc234",
    props,
  });

  it("survives one very long first session (≈130k events, e.g. flooded tutorial messages)", () => {
    const flood = Array.from({ length: 130_000 }, (_, i) => ev("X", "x1", "general", i, "tutorial_step", { step: 0, outcome: "shown" }));
    const honest = [ev("A", "a1", "general", 0, "session_start")];
    // Expected: a report. Actual: RangeError (Math.max(...array) in report.ts:169), so no report at all.
    expect(() => buildReport([...honest, ...flood])).not.toThrow();
  });

  it("a player whose link says src=all is not reported as a second 'all' column", () => {
    const r = buildReport([ev("A", "a1", "all", 0, "session_start"), ev("B", "b1", "crypto", 1, "session_start")]);
    const names = r.groups.map((g) => g.group);
    // Expected distinct column names. Actual: ["all", "all", "crypto"]; the second "all" holds every player.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("bug-hunt M4: session bookkeeping", () => {
  it("a tab left open and played again the next day does not stretch the first session over two days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T20:00:00Z"));
    const events: TrackedEvent[] = [];
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, log: () => {}, track: (e) => events.push(e) });
    const tags = { anon: hex(7), session: hex(7), source: "general" };
    const a = await connect(server.port, null, "Ana", tags);
    const code = a.mirror.code;
    const token = a.mirror.you!.token;
    for (let i = 0; i < 3; i++) a.mirror.skipWait(i);
    await until(() => a.mirror.lanes.every((l) => l.phase === "live"));
    a.mirror.buy(0, STAKES[0]!);
    await until(() => events.some((e) => e.event === "round_join"));
    // Laptop sleeps: the socket drops and the server logs session_end.
    a.ws.close();
    await a.closed;
    await until(() => events.some((e) => e.event === "session_end"));

    // Next morning the same tab wakes up and reconnects: same sessionStorage id.
    vi.setSystemTime(new Date("2026-11-03T09:00:00Z"));
    const b = await connect(server.port, code, "Ana", tags, token);
    for (let i = 0; i < 3; i++) b.mirror.skipWait(i);
    await until(() => b.mirror.lanes.every((l) => l.phase === "live"));
    b.mirror.buy(1, STAKES[0]!);
    await until(() => events.filter((e) => e.event === "round_join").length >= 2);
    b.ws.close();
    await b.closed;
    await until(() => events.filter((e) => e.event === "session_end").length >= 2);

    const r = buildReport(events).groups[0]!;
    // Expected first-session rounds 1 and a first session of minutes. Actual 2 rounds and ~780 minutes.
    expect(r.firstSessionRounds.median).toBe(1);
    expect(r.firstSessionMinutes.median).toBeLessThan(60);
  });
});
