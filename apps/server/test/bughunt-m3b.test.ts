// Bug-hunter round 2 for M3 (after d216f0a). Expected to fail until fixed.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RoomMirror, encode } from "@ape/game";
import { startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";

let server: RunningServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

function connect(port: number, nick: string, forwardedFor: string): Promise<RoomMirror> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { "x-forwarded-for": forwardedFor } });
    sockets.push(ws);
    const mirror = new RoomMirror((text) => ws.send(text));
    ws.on("open", () => ws.send(encode({ t: "hello", room: null, nick, token: null })));
    ws.on("message", (data) => {
      mirror.receive(data.toString());
      if (mirror.ready || mirror.fatal !== null) done(mirror);
    });
    ws.on("error", fail);
  });
}

describe("bughunt M3 P1: behind the host's proxy, the per-address room limit is one limit for everybody", () => {
  it("twelve different players arriving through one proxy can each open a room", async () => {
    // On Railway every socket comes from the edge proxy's address; the player's own
    // address is only in X-Forwarded-For. Default limits, as in production.
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, log: () => {} });
    const refused: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const m = await connect(server.port, `Player${i}`, `203.0.113.${i}`);
      if (m.fatal !== null) refused.push(`203.0.113.${i}: ${m.fatal}`);
    }
    expect(refused).toEqual([]);
  }, 20_000);
});
