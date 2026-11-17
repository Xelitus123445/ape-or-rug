// Bug-hunt M4 round 2: the seat session state machine (startPlay / endPlay).
// A failing test is a finding.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RoomMirror, encode } from "@ape/game";
import type { HelloTags } from "@ape/game";
import { startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";
import type { TrackedEvent } from "../src/telemetry.ts";

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
  let left = ms / 5;
  while (!check()) {
    if (--left < 0) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("bug-hunt M4 r2: session after a long drop", () => {
  it("the same tab back after 30+ minutes gets a new session id (<tab>.2), not the old one again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T20:00:00Z"));
    const events: TrackedEvent[] = [];
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 50, log: () => {}, track: (e) => events.push(e) });
    const tags = { anon: hex(7), session: hex(7), source: "general" };
    const a = await connect(server.port, null, "Ana", tags);
    const code = a.mirror.code;
    const token = a.mirror.you!.token;
    a.ws.close();
    await a.closed;
    await until(() => events.some((e) => e.event === "session_end"));

    // 31 minutes later. The room keeps ticking (and pruning held seats) meanwhile.
    vi.setSystemTime(new Date("2026-11-02T20:31:00Z"));
    await new Promise((r) => setTimeout(r, 300));
    const b = await connect(server.port, code, "Ana", tags, token);
    expect(b.mirror.ready).toBe(true);
    const starts = events.filter((e) => e.event === "session_start");
    expect(starts.length).toBe(2);
    // Expected (per the fix): `${tab}.2`. Actual: the tab id again, because the seat was pruned after the
    // 10-minute hold, so startPlay sees a brand-new seat and the ".2" branch can never run.
    expect(starts[1]!.session).toBe(`${hex(7)}.2`);
  });
});
