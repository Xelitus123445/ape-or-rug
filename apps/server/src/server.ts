// HTTP + WebSocket server for rooms. Each room runs its own clock at its
// pace; the server only moves bytes between sockets and rooms, holds no
// game logic of its own and keeps everything in memory.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_CLIENT_MESSAGE, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, Room, encode, parseClient } from "@ape/game";
import type { ServerMsg } from "@ape/game";

export interface ServerOptions {
  readonly port: number;
  readonly host?: string;
  /** Built web app to serve, or null to serve only the socket. */
  readonly staticDir?: string | null;
  /** Milliseconds per tick for a given pace; tests shorten it. */
  readonly tickMs?: (ticksPerSecond: number) => number;
  readonly maxRooms?: number;
  /** How long an empty room is kept, in ms. */
  readonly emptyRoomMs?: number;
  readonly log?: (line: string) => void;
}

export interface RunningServer {
  readonly port: number;
  readonly rooms: ReadonlyMap<string, Room>;
  close(): Promise<void>;
}

interface Hosted {
  readonly room: Room;
  readonly sockets: Map<string, WebSocket>;
  timer: ReturnType<typeof setInterval> | null;
  emptySince: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Messages per second a client may send, with a short burst allowance. */
const RATE = 20;
const BURST = 40;
const HELLO_TIMEOUT_MS = 10_000;
/** A client that cannot keep up is dropped; it reconnects and gets a fresh welcome. */
const MAX_BUFFERED = 1 << 20;

function newCode(taken: ReadonlyMap<string, unknown>): string {
  for (;;) {
    const bytes = randomBytes(ROOM_CODE_LENGTH);
    let code = "";
    for (const b of bytes) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
    if (!taken.has(code)) return code;
  }
}

function frame(msg: ServerMsg): string {
  return encode([msg]);
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const tickMs = opts.tickMs ?? ((tps: number) => 1000 / tps);
  const maxRooms = opts.maxRooms ?? 200;
  const emptyRoomMs = opts.emptyRoomMs ?? 10 * 60_000;
  const hosted = new Map<string, Hosted>();
  const rooms = new Map<string, Room>();
  const staticDir = opts.staticDir != null && existsSync(opts.staticDir) ? resolve(opts.staticDir) : null;

  function arm(h: Hosted): void {
    if (h.timer !== null) clearInterval(h.timer);
    h.timer = setInterval(() => {
      try {
        h.room.clock();
      } catch (e) {
        log(`room ${h.room.code}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, tickMs(h.room.ticksPerSecond));
  }

  function openRoom(code: string): Hosted {
    const sockets = new Map<string, WebSocket>();
    let h: Hosted | null = null;
    const room = new Room(code, {
      newSeed: () => new Uint8Array(randomBytes(32)),
      newToken: () => randomBytes(16).toString("hex"),
      now: () => Date.now(),
      send: (pid, text) => {
        const ws = sockets.get(pid);
        if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED) {
          ws.terminate();
          return;
        }
        ws.send(text);
      },
      onPace: () => {
        if (h !== null) arm(h);
      },
    });
    h = { room, sockets, timer: null, emptySince: Date.now() };
    hosted.set(code, h);
    rooms.set(code, room);
    arm(h);
    log(`room ${code} opened (${hosted.size} open)`);
    return h;
  }

  function closeRoom(h: Hosted): void {
    if (h.timer !== null) clearInterval(h.timer);
    h.timer = null;
    hosted.delete(h.room.code);
    rooms.delete(h.room.code);
    log(`room ${h.room.code} closed (${hosted.size} open)`);
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const h of [...hosted.values()]) {
      if (h.room.online > 0) h.emptySince = now;
      else if (now - h.emptySince > emptyRoomMs) closeRoom(h);
    }
  }, 30_000);

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (staticDir === null || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    let path = resolve(join(staticDir, decodeURIComponent(url.pathname)));
    if (path !== staticDir && !path.startsWith(staticDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(staticDir, "index.html");
    if (!existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    const type = TYPES[extname(path)] ?? "application/octet-stream";
    const cache = path.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : readFileSync(path));
  }

  const http = createServer(serveStatic);
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: MAX_CLIENT_MESSAGE * 4 });

  wss.on("connection", (ws) => {
    let seat: { h: Hosted; pid: string } | null = null;
    let tokens = BURST;
    let last = Date.now();
    const helloTimer = setTimeout(() => {
      if (seat === null) ws.close(1008, "hello expected");
    }, HELLO_TIMEOUT_MS);

    const refuse = (error: Extract<ServerMsg, { t: "error" }>["error"]): void => {
      ws.send(frame({ t: "error", error }));
      ws.close(1008, error);
    };

    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(BURST, tokens + ((now - last) / 1000) * RATE);
      last = now;
      if (tokens < 1) {
        refuse("rate_limited");
        return;
      }
      tokens -= 1;
      if (isBinary) {
        refuse("bad_message");
        return;
      }
      const text = data.toString();
      if (seat !== null) {
        seat.h.room.handle(seat.pid, text);
        return;
      }
      const hello = parseClient(text);
      if (hello === null || hello.t !== "hello") {
        refuse("bad_message");
        return;
      }
      let h = hello.room === null ? undefined : hosted.get(hello.room);
      if (h === undefined) {
        if (hosted.size >= maxRooms) {
          refuse("bad_room");
          return;
        }
        // A link to a room that is gone (e.g. after a restart) opens a fresh room under the same code.
        h = openRoom(hello.room ?? newCode(hosted));
      }
      const r = h.room.join(hello.nick, hello.token);
      if (!r.ok) {
        refuse(r.error);
        return;
      }
      // One connection per seat: a reconnect replaces an older socket that is still open.
      const old = h.sockets.get(r.pid);
      if (old !== undefined && old !== ws) {
        old.send(frame({ t: "error", error: "replaced" }));
        old.close(1000, "replaced");
      }
      h.sockets.set(r.pid, ws);
      h.room.flush();
      clearTimeout(helloTimer);
      seat = { h, pid: r.pid };
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (seat === null) return;
      const { h, pid } = seat;
      if (h.sockets.get(pid) === ws) {
        h.sockets.delete(pid);
        h.room.leave(pid);
      }
    });
    ws.on("error", () => ws.terminate());
  });

  return new Promise((done) => {
    http.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      log(`ape-or-rug server on http://${opts.host ?? "127.0.0.1"}:${port}${staticDir !== null ? ` serving ${staticDir}` : ""}`);
      done({
        port,
        rooms,
        close: () =>
          new Promise<void>((closed) => {
            clearInterval(sweeper);
            for (const h of [...hosted.values()]) closeRoom(h);
            for (const c of wss.clients) c.terminate();
            wss.close();
            http.close(() => closed());
          }),
      });
    });
  });
}
