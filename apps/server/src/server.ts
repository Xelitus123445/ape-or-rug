// HTTP + WebSocket server for rooms. Each room runs its own clock at its
// pace; the server only moves bytes between sockets and rooms, holds no
// game logic of its own and keeps everything in memory. Nothing a client
// sends may take the process, or another player's room, down.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_CLIENT_MESSAGE, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, Room, cleanNick, encode, parseClient } from "@ape/game";
import type { ServerMsg } from "@ape/game";
import { eventProps } from "./telemetry.ts";
import type { PropValue, TrackedEvent } from "./telemetry.ts";

export interface ServerOptions {
  readonly port: number;
  readonly host?: string;
  /** Built web app to serve, or null to serve only the socket. */
  readonly staticDir?: string | null;
  /** Milliseconds per tick for a given pace; tests shorten it. */
  readonly tickMs?: (ticksPerSecond: number) => number;
  readonly maxRooms?: number;
  /** Rooms one address may open within ROOM_WINDOW_MS. */
  readonly roomsPerAddress?: number;
  /** How long an empty room is kept, in ms. */
  readonly emptyRoomMs?: number;
  readonly log?: (line: string) => void;
  /** New anonymous ids one address may bring per hour before it is no longer recorded. */
  readonly anonsPerAddress?: number;
  /** Playtest events; nothing is recorded when absent. */
  readonly track?: (e: TrackedEvent) => void;
  /** Error reporting (Sentry) for anything caught on the server. */
  readonly onError?: (e: unknown) => void;
  /** Public settings the web app reads at start from /config.json (e.g. its Sentry DSN). */
  readonly clientConfig?: Readonly<Record<string, string | null>>;
}

interface SeatTags {
  readonly anon: string;
  /** The session as recorded: the tab's id, with ".2", ".3"... after each long break. */
  readonly session: string;
  readonly source: string | null;
}

/** A seat's playtest identity. It belongs to the seat, so reconnecting cannot make one player look like many. */
interface SeatPlay {
  tags: SeatTags;
  /** The id the tab sent. */
  client: string;
  /** Sessions this seat has had for that tab id. */
  n: number;
  startedAt: number;
  /** When the seat's connection went away, or null while connected. */
  endedAt: number | null;
}

/** A drop shorter than this is the same session; a longer one starts a new session. */
const SESSION_GAP_MS = 30 * 60_000;
/** New anonymous ids one address may bring per hour; more are played but not recorded. */
const ANONS_PER_ADDRESS = 20;

export interface RunningServer {
  readonly port: number;
  readonly rooms: ReadonlyMap<string, Room>;
  close(): Promise<void>;
}

interface Hosted {
  readonly room: Room;
  readonly sockets: Map<string, WebSocket>;
  /** Playtest identity of each seat. */
  readonly play: Map<string, SeatPlay>;
  timer: ReturnType<typeof setTimeout> | null;
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
const MAX_BUFFERED = 4 << 20;
const ROOM_WINDOW_MS = 10 * 60_000;

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

/** Loopback and private-network addresses: where a hosting proxy sits, never a player on the internet. */
export function isPrivateAddress(raw: string): boolean {
  const a = raw.trim().toLowerCase().replace(/^::ffff:/, "");
  if (a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80:")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (m === null) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254);
}

/**
 * The player's own address. Behind a hosting proxy every socket comes from
 * the proxy, and the player is in X-Forwarded-For. The header is only
 * believed when the socket itself comes from a private address (a proxy),
 * and then the right-most entry that is not another private hop is taken:
 * entries further left were written by the client and can be anything.
 */
export function clientAddress(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "?";
  if (!isPrivateAddress(direct)) return direct;
  const header = req.headers["x-forwarded-for"];
  // A port after an IPv4 entry ("5.6.7.8:4431") is dropped, so it cannot make one player look like many.
  const hops = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((s) => s.trim().replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1").replace(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/, "$1"))
    .filter((s) => s !== "");
  for (let i = hops.length - 1; i >= 0; i--) if (!isPrivateAddress(hops[i]!)) return hops[i]!;
  return direct;
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const tickMs = opts.tickMs ?? ((tps: number) => 1000 / tps);
  const maxRooms = opts.maxRooms ?? 200;
  const roomsPerAddress = opts.roomsPerAddress ?? 10;
  const emptyRoomMs = opts.emptyRoomMs ?? 10 * 60_000;
  const hosted = new Map<string, Hosted>();
  const rooms = new Map<string, Room>();
  /** When each address opened its recent rooms. */
  const opened = new Map<string, number[]>();
  const staticDir = opts.staticDir != null && existsSync(opts.staticDir) ? resolve(opts.staticDir) : null;
  const report = (where: string, e: unknown): void => {
    log(`${where}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    try {
      opts.onError?.(e);
    } catch {
      // ignored
    }
  };
  /** Anonymous ids recently brought by each address, with when. */
  const anonsSeen = new Map<string, Map<string, number>>();
  /** Addresses that hit the cap and have been logged once. */
  const capLogged = new Set<string>();
  /**
   * The last session of each tab, across seats: a tab back after a long
   * break gets "<tab>.2" even when its old seat has been freed meanwhile.
   */
  const tabSessions = new Map<string, { n: number; endedAt: number | null }>();

  /** Whether this address may bring this anonymous id; records it if so. */
  function mayTrack(address: string, anon: string): boolean {
    const now = Date.now();
    const seen = anonsSeen.get(address) ?? new Map<string, number>();
    anonsSeen.set(address, seen);
    for (const [a, t] of seen) if (now - t > 3600_000) seen.delete(a);
    if (!seen.has(anon) && seen.size >= (opts.anonsPerAddress ?? ANONS_PER_ADDRESS)) {
      // Said once per address, so a proxy that hides every player behind one address shows up in the logs.
      if (!capLogged.has(address)) log(`telemetry: new-player cap reached for one address (${seen.size} ids this hour); more players from it are not recorded`);
      capLogged.add(address);
      return false;
    }
    seen.set(anon, now);
    return true;
  }

  /** The seat's connection is gone (or the server stops): its session ends, once. */
  function endPlay(h: Hosted, pid: string): void {
    const p = h.play.get(pid);
    if (p === undefined || p.endedAt !== null) return;
    p.endedAt = Date.now();
    tabSessions.set(`${p.tags.anon}:${p.client}`, { n: p.n, endedAt: p.endedAt });
    emit(p.tags, h.room.code, "session_end", { duration_s: Math.round((p.endedAt - p.startedAt) / 1000) });
  }

  /** Session number for a tab starting on a new seat: the same one after a short break, the next after a long one. */
  function tabSession(anon: string, client: string, now: number): number {
    const last = tabSessions.get(`${anon}:${client}`);
    const n = last === undefined ? 1 : last.endedAt !== null && now - last.endedAt >= SESSION_GAP_MS ? last.n + 1 : last.n;
    tabSessions.set(`${anon}:${client}`, { n, endedAt: null });
    return n;
  }

  const sessionId = (client: string, n: number): string => (n === 1 ? client : `${client}.${n}`);

  /** A connection took the seat: carry on its session, or start one. */
  function startPlay(h: Hosted, pid: string, hello: { anon: string | null; session: string | null; source: string | null }, address: string, created: boolean, rejoined: boolean): void {
    const now = Date.now();
    const prev = h.play.get(pid);
    const client = hello.session ?? prev?.client ?? null;
    if (client === null) return;
    if (prev === undefined) {
      if (hello.anon === null || !mayTrack(address, hello.anon)) return;
      const n = tabSession(hello.anon, client, now);
      h.play.set(pid, { tags: { anon: hello.anon, session: sessionId(client, n), source: hello.source }, client, n, startedAt: now, endedAt: null });
      emit(h.play.get(pid)!.tags, h.room.code, "session_start", { created, rejoined });
      return;
    }
    // Same tab back after a short drop, or a new socket while the old one is still open: same session.
    if (client === prev.client && (prev.endedAt === null || now - prev.endedAt < SESSION_GAP_MS)) {
      prev.endedAt = null;
      tabSessions.set(`${prev.tags.anon}:${prev.client}`, { n: prev.n, endedAt: null });
      return;
    }
    endPlay(h, pid);
    const n = tabSession(prev.tags.anon, client, now);
    // The seat keeps its anonymous id and group whatever the new hello claims.
    prev.tags = { anon: prev.tags.anon, session: sessionId(client, n), source: prev.tags.source };
    prev.client = client;
    prev.n = n;
    prev.startedAt = now;
    prev.endedAt = null;
    emit(prev.tags, h.room.code, "session_start", { created, rejoined });
  }

  function emit(t: SeatTags, room: string, event: string, props: Record<string, PropValue>): void {
    if (opts.track === undefined) return;
    try {
      opts.track({ ts: new Date().toISOString(), event, anon: t.anon, session: t.session, source: t.source, room, props });
    } catch (e) {
      report("telemetry", e);
    }
  }

  /**
   * Each tick schedules the next one at the room's current pace. A pace
   * change takes effect from the next tick and never restarts the wait, so
   * flipping the pace cannot hold the clock back.
   */
  function arm(h: Hosted): void {
    // Ticks are due on a fixed schedule, so the time a tick takes does not slow the pace down.
    let due = Date.now() + tickMs(h.room.ticksPerSecond);
    const tick = (): void => {
      if (hosted.get(h.room.code) !== h) return;
      try {
        h.room.clock();
      } catch (e) {
        report(`room ${h.room.code}`, e);
      }
      const now = Date.now();
      due += tickMs(h.room.ticksPerSecond);
      // After a long stall (a paused laptop), carry on from now instead of catching up in a burst.
      if (due < now - 1000) due = now;
      h.timer = setTimeout(tick, Math.max(0, due - now));
    };
    h.timer = setTimeout(tick, Math.max(0, due - Date.now()));
  }

  function openRoom(code: string): Hosted {
    const sockets = new Map<string, WebSocket>();
    const play = new Map<string, SeatPlay>();
    const room = new Room(code, {
      track: (pid, ev) => {
        const p = play.get(pid);
        if (p !== undefined) emit(p.tags, code, ev.name, eventProps(ev));
      },
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
    });
    const h: Hosted = { room, sockets, play, timer: null, emptySince: Date.now() };
    hosted.set(code, h);
    rooms.set(code, room);
    arm(h);
    log(`room ${code} opened (${hosted.size} open)`);
    return h;
  }

  function closeRoom(h: Hosted): void {
    if (h.timer !== null) clearTimeout(h.timer);
    h.timer = null;
    hosted.delete(h.room.code);
    rooms.delete(h.room.code);
    log(`room ${h.room.code} closed (${hosted.size} open)`);
  }

  /** Whether this address may open another room now; records it if so. */
  function mayOpen(address: string): boolean {
    const now = Date.now();
    const recent = (opened.get(address) ?? []).filter((t) => now - t < ROOM_WINDOW_MS);
    if (recent.length >= roomsPerAddress) {
      opened.set(address, recent);
      return false;
    }
    recent.push(now);
    opened.set(address, recent);
    return true;
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const h of [...hosted.values()]) {
      if (h.room.online > 0) h.emptySince = now;
      else if (now - h.emptySince > emptyRoomMs) closeRoom(h);
    }
    for (const [address, times] of opened) if (times.every((t) => now - t >= ROOM_WINDOW_MS)) opened.delete(address);
    for (const h of hosted.values()) for (const pid of [...h.play.keys()]) if (!h.room.players.has(pid)) h.play.delete(pid);
    for (const [address, seen] of anonsSeen) {
      for (const [a, t] of seen) if (now - t > 3600_000) seen.delete(a);
      if (seen.size === 0) {
        anonsSeen.delete(address);
        capLogged.delete(address);
      }
    }
    for (const [k, s] of tabSessions) if (s.endedAt !== null && now - s.endedAt > 24 * 3600_000) tabSessions.delete(k);
  }, 30_000);

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname === "/config.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" }).end(JSON.stringify(opts.clientConfig ?? {}));
      return;
    }
    if (staticDir === null || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let path = resolve(join(staticDir, decoded));
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

  const http = createServer((req, res) => {
    try {
      serveStatic(req, res);
    } catch (e) {
      report("http", e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: MAX_CLIENT_MESSAGE * 4 });

  wss.on("connection", (ws, req) => {
    const address = clientAddress(req);
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

    const onMessage = (text: string): void => {
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
      const created = h === undefined;
      if (h === undefined) {
        // Only a hello that would be seated opens a room, and one address can only open so many.
        if (cleanNick(hello.nick) === null) {
          refuse("bad_nick");
          return;
        }
        if (hosted.size >= maxRooms || !mayOpen(address)) {
          refuse("bad_room");
          return;
        }
        // A link to a room that is gone (e.g. after a restart) opens a fresh room under the same code.
        h = openRoom(hello.room ?? newCode(hosted));
      }
      const r = h.room.join(hello.nick, hello.token);
      if (!r.ok) {
        if (h.room.players.size === 0) closeRoom(h);
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
      clearTimeout(helloTimer);
      seat = { h, pid: r.pid };
      startPlay(h, r.pid, hello, address, created, r.rejoined);
      h.room.flush();
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
      try {
        onMessage(data.toString());
      } catch (e) {
        report("message", e);
        ws.close(1011, "server error");
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (seat === null) return;
      const { h, pid } = seat;
      // A socket replaced by a newer one for the same seat does not end the session.
      if (h.sockets.get(pid) === ws) {
        h.sockets.delete(pid);
        endPlay(h, pid);
        try {
          h.room.leave(pid);
        } catch (e) {
          report("leave", e);
        }
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
            for (const h of hosted.values()) for (const pid of h.sockets.keys()) endPlay(h, pid);
            for (const h of [...hosted.values()]) closeRoom(h);
            for (const c of wss.clients) c.terminate();
            wss.close();
            http.close(() => closed());
          }),
      });
    });
  });
}
