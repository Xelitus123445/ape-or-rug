// Telemetry over real sockets, the JSONL file and the PostHog batcher.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RoomMirror, STAKES, encode } from "@ape/game";
import type { HelloTags } from "@ape/game";
import { startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";
import { JsonlSink, PostHogSink } from "../src/telemetry.ts";
import type { TrackedEvent } from "../src/telemetry.ts";
import { buildReport, parseEvents } from "../src/report.ts";

let server: RunningServer | null = null;
const sockets: WebSocket[] = [];
// Test files stay inside the repository (drive D), never in the system temp folder.
const scratch = fileURLToPath(new URL("../../../data/test-telemetry/", import.meta.url));

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
  rmSync(scratch, { recursive: true, force: true });
});

const ANON = "a".repeat(32);
const SESSION = "5".repeat(32);

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

describe("telemetry", () => {
  it("records a session, its rounds and its end under the anonymous id, and nothing for untagged clients", async () => {
    const events: TrackedEvent[] = [];
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, log: () => {}, track: (e) => events.push(e) });
    const tags = { anon: ANON, session: SESSION, source: "crypto" };
    const a = await connect(server.port, null, "Ana", tags);
    const code = a.mirror.code;
    // An untagged client plays in the same room but is not recorded.
    const b = await connect(server.port, code, "Bo", null);
    for (let i = 0; i < 3; i++) a.mirror.skipWait(i);
    await until(() => a.mirror.lanes.every((l) => l.phase === "live"));
    a.mirror.buy(2, STAKES[0]!);
    b.mirror.buy(2, STAKES[0]!);
    a.mirror.trackTutorial(0, "shown");
    await until(() => events.some((e) => e.event === "tutorial_step"));
    expect(events.every((e) => e.anon === ANON && e.session === SESSION && e.source === "crypto" && e.room === code)).toBe(true);
    expect(events.map((e) => e.event)).toEqual(["session_start", "round_join", "buy", "tutorial_step"]);
    expect(events[0]!.props).toEqual({ created: true, rejoined: false });
    expect(events[2]!.props).toMatchObject({ lane: 2, profile: 2, stake: Number(STAKES[0]!) / 100 });
    // Nothing a player typed and no address is in any event.
    expect(JSON.stringify(events)).not.toMatch(/Ana|Bo|127\.0\.0\.1/);

    // A reconnect in the same tab is the same session: no new start, and no end while the seat is back.
    const token = a.mirror.you!.token;
    a.ws.close();
    await a.closed;
    await until(() => events.some((e) => e.event === "session_end"));
    const back = await connect(server.port, code, "Ana", tags, token);
    expect(back.mirror.holding(2).stake).toBe(STAKES[0]!);
    expect(events.filter((e) => e.event === "session_start").length).toBe(1);
    // Shutting down ends the open session too.
    await server.close();
    server = null;
    expect(events.filter((e) => e.event === "session_end").length).toBe(2);
    expect(typeof events.at(-1)!.props.duration_s).toBe("number");
  });

  it("serves the public client settings", async () => {
    server = await startServer({ port: 0, staticDir: null, log: () => {}, clientConfig: { sentryDsn: null } });
    const res = await fetch(`http://127.0.0.1:${server.port}/config.json`);
    expect(await res.json()).toEqual({ sentryDsn: null });
  });

  it("appends events to a JSONL file the report can read", async () => {
    const path = `${scratch}events.jsonl`;
    const sink = new JsonlSink(path, () => {});
    const e: TrackedEvent = { ts: new Date().toISOString(), event: "session_start", anon: ANON, session: SESSION, source: null, room: "abc234", props: {} };
    sink.write(e);
    sink.write({ ...e, event: "round_join", props: { commit: "c", profile: 0 } });
    await sink.close();
    expect(existsSync(path)).toBe(true);
    const { events, bad } = parseEvents(readFileSync(path, "utf8"));
    expect(bad).toBe(0);
    expect(buildReport(events).groups[0]!.firstSessionRounds.median).toBe(1);
  });

  it("sends PostHog batches, keeps events through an outage and sends them later", async () => {
    const posts: { url: string; body: { api_key: string; batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] } }[] = [];
    let down = true;
    const logs: string[] = [];
    const fake = (async (url: string, init: { body: string }) => {
      if (down) throw new Error("offline");
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const sink = new PostHogSink({ key: "phc_test", host: "https://ph.example/", fetch: fake, batchSize: 2, intervalMs: 60_000, log: (l) => logs.push(l) });
    const e: TrackedEvent = { ts: new Date().toISOString(), event: "buy", anon: ANON, session: SESSION, source: "general", room: "abc234", props: { stake: 1 } };
    sink.write(e);
    sink.write(e);
    sink.write(e);
    await sink.flush();
    expect(posts.length).toBe(0);
    expect(logs.length).toBe(1);
    down = false;
    await sink.close();
    expect(posts.map((p) => p.body.batch.length)).toEqual([2, 1]);
    expect(posts[0]!.url).toBe("https://ph.example/batch/");
    expect(posts[0]!.body.api_key).toBe("phc_test");
    expect(posts[0]!.body.batch[0]).toMatchObject({ event: "buy", distinct_id: ANON, properties: { stake: 1, source: "general", $session_id: SESSION } });
  });
});
