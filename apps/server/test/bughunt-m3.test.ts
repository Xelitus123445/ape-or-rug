// Bug-hunter reproductions for M3 against the real server. Each test here
// failed when it was written; they are expected to fail until fixed.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RoomMirror, encode } from "@ape/game";
import { startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";

let server: RunningServer | null = null;
let child: ChildProcess | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
  child?.kill();
  child = null;
});

interface Client {
  readonly ws: WebSocket;
  readonly mirror: RoomMirror;
  closed: Promise<void>;
}

function connect(port: number, room: string | null, nick: string, token: string | null = null): Promise<Client> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const mirror = new RoomMirror((text) => ws.send(text));
    const closed = new Promise<void>((c) => ws.on("close", () => c()));
    ws.on("open", () => ws.send(encode({ t: "hello", room, nick, token })));
    ws.on("message", (data) => {
      mirror.receive(data.toString());
      if (mirror.ready || mirror.fatal !== null) done({ ws, mirror, closed });
    });
    ws.on("error", fail);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function get(port: number, path: string): Promise<number | "error"> {
  return new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 3000 }, (res) => {
      res.resume();
      res.on("end", () => done(res.statusCode ?? 0));
    });
    req.on("error", () => done("error"));
    req.on("timeout", () => {
      req.destroy();
      done("error");
    });
    req.end();
  });
}

/** Starts the real server in its own process, serving static files from this test folder. */
function spawnServer(): Promise<{ port: number; proc: ChildProcess; exited: Promise<number | null> }> {
  const serverUrl = new URL("../src/server.ts", import.meta.url).href;
  const staticDir = fileURLToPath(new URL(".", import.meta.url));
  const script = `
    const { startServer } = await import(${JSON.stringify(serverUrl)});
    const s = await startServer({ port: 0, staticDir: ${JSON.stringify(staticDir)}, log: () => {} });
    console.log("PORT " + s.port);
  `;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  child = proc;
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  return new Promise((done, fail) => {
    let out = "";
    proc.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /PORT (\d+)/.exec(out);
      if (m) done({ port: Number(m[1]), proc, exited });
    });
    proc.on("exit", () => fail(new Error(`server process exited before listening: ${out}`)));
  });
}

describe("bughunt M3 X1: one malformed URL takes the whole server down", () => {
  it("GET /% (bad percent-encoding) is answered and the server keeps serving", async () => {
    const { port, exited } = await spawnServer();
    expect(await get(port, "/health")).toBe(200);
    await get(port, "/%E0%A4%A");
    const gone = await Promise.race([exited.then(() => true), sleep(500).then(() => false)]);
    expect(gone).toBe(false);
    expect(await get(port, "/health")).toBe(200);
  }, 20_000);
});

describe("bughunt M3 D1: the host can freeze the room for everyone", () => {
  it("ticks keep coming while the host flips the pace within the rate limit", async () => {
    // Every pace gets the same 150 ms tick here; what matters is that a pace change re-arms the timer.
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 150, log: () => {} });
    const host = await connect(server.port, null, "Ana");
    const room = server.rooms.get(host.mirror.code)!;
    let clocks = 0;
    const real = room.clock.bind(room);
    room.clock = () => {
      clocks++;
      real();
    };
    await sleep(400);
    expect(clocks).toBeGreaterThan(0);
    clocks = 0;
    // 16 messages a second: below the server's limit of 20 per second.
    const paces = ["chill", "fast"];
    for (let i = 0; i < 32; i++) {
      host.mirror.setPace(paces[i % 2]!);
      await sleep(60);
    }
    // 1.9 s at 150 ms per tick should be about 12 clocks.
    expect(host.mirror.fatal).toBeNull();
    expect(clocks).toBeGreaterThanOrEqual(6);
  }, 20_000);
});

describe("bughunt M3 D2: refused hellos fill the room table", () => {
  it("a hello refused for a bad nickname does not leave a room open, so real players can still open rooms", async () => {
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, maxRooms: 3, log: () => {} });
    for (const code of ["aaaaaa", "bbbbbb", "cccccc"]) {
      const bad = await connect(server.port, code, "x"); // too short: bad_nick
      expect(bad.mirror.fatal).toBe("bad_nick");
      await bad.closed;
    }
    expect(server.rooms.size).toBe(0);
    const real = await connect(server.port, null, "Ana");
    expect(real.mirror.fatal).toBeNull();
  }, 20_000);
});
