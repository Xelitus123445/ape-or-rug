// End-to-end over real sockets: the server, the wire format and the client
// mirror together. Ticks are sped up to a few milliseconds.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MAX_PLAYERS, RoomMirror, STAKES, START_BALANCE, encode } from "@ape/game";
import type { IncomingMessage } from "node:http";
import { clientAddress, startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";

let server: RunningServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
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

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("server", () => {
  it("creates a room by link, seats five players, refuses a sixth, and keeps them in sync over real sockets", async () => {
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 2, log: () => {} });
    const first = await connect(server.port, null, "Ana");
    const code = first.mirror.code;
    expect(code).toMatch(/^[a-z0-9]{6}$/);
    const others = await Promise.all(["Bo", "Cy", "Dee", "Eli"].map((n) => connect(server!.port, code, n)));
    const all = [first, ...others];
    expect(server.rooms.get(code)!.players.size).toBe(MAX_PLAYERS);
    const sixth = await connect(server.port, code, "Fay");
    expect(sixth.mirror.fatal).toBe("room_full");
    await sixth.closed;

    first.mirror.buy(0, STAKES[2]!);
    await until(() => all.every((c) => c.mirror.feed.some((f) => f.kind === "buy" && f.nick === "Ana")));
    expect(first.mirror.balance).toBe(START_BALANCE - STAKES[2]!);

    // Let a good number of coins end, then compare what every client saw.
    await until(() => all.every((c) => c.mirror.coinsPlayed >= 4), 60_000);
    const view = (m: RoomMirror): string => m.history.slice(1, 4).map((f) => `${f.roundId}:${f.seed}:${f.ticks}`).join("|");
    await until(() => new Set(all.map((c) => view(c.mirror))).size === 1, 60_000);
    for (const f of first.mirror.history.slice(0, 4)) {
      const v = first.mirror.verify(f);
      expect(v.commitOk && v.roundOk).toBe(true);
    }
  });

  it("gives a returning player their seat, bags and action numbers back, and drops the older socket", async () => {
    // Slow ticks so the coin is still alive after the reconnect.
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, log: () => {} });
    const a = await connect(server.port, null, "Ana");
    const code = a.mirror.code;
    const token = a.mirror.you!.token;
    a.mirror.buy(2, STAKES[3]!);
    a.mirror.buy(1, STAKES[0]!);
    await until(() => a.mirror.holding(2).stake === STAKES[3]! && a.mirror.holding(1).stake === STAKES[0]!);
    // Same seat from a second socket while the first is still open: the first is replaced.
    const again = await connect(server.port, code, "ignored", token);
    await a.closed;
    expect(a.mirror.fatal).toBe("replaced");
    expect(again.mirror.you!.id).toBe(a.mirror.you!.id);
    expect(again.mirror.holding(2).stake).toBe(STAKES[3]!);
    expect(again.mirror.balance).toBe(START_BALANCE - STAKES[3]! - STAKES[0]!);
    again.mirror.sellAll(1);
    await until(() => again.mirror.holding(1).value === 0n);
    expect(again.mirror.lastError).toBeNull();
    // A plain disconnect holds the seat.
    again.ws.close();
    await again.closed;
    await until(() => server!.rooms.get(code)!.online === 0);
    const back = await connect(server.port, code, "x", token);
    expect(back.mirror.holding(2).stake).toBe(STAKES[3]!);
  });

  it("lets one address open only so many rooms, but join any number", async () => {
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, roomsPerAddress: 2, log: () => {} });
    const a = await connect(server.port, null, "Ana");
    await connect(server.port, null, "Bo");
    const third = await connect(server.port, null, "Cy");
    expect(third.mirror.fatal).toBe("bad_room");
    const joiner = await connect(server.port, a.mirror.code, "Dee");
    expect(joiner.mirror.fatal).toBeNull();
    expect(server.rooms.size).toBe(2);
  });

  it("believes X-Forwarded-For only from a private proxy, and only its right-most public entry", () => {
    const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } }) as unknown as IncomingMessage;
    expect(clientAddress(req("203.0.113.9", "1.2.3.4"))).toBe("203.0.113.9");
    expect(clientAddress(req("10.0.0.5", "1.2.3.4, 198.51.100.7"))).toBe("198.51.100.7");
    expect(clientAddress(req("::ffff:127.0.0.1", "198.51.100.7, 10.1.1.1"))).toBe("198.51.100.7");
    expect(clientAddress(req("127.0.0.1"))).toBe("127.0.0.1");
    expect(clientAddress(req("10.0.0.5", "5.6.7.8:4431"))).toBe("5.6.7.8");
    expect(clientAddress(req("10.0.0.5", "[2001:db8::1]:443"))).toBe("2001:db8::1");
  });

  it("closes connections that do not say hello properly or flood the server", async () => {
    server = await startServer({ port: 0, staticDir: null, tickMs: () => 1000, log: () => {} });
    const bad = await connect(server.port, null, "a"); // nickname too short
    expect(bad.mirror.fatal).toBe("bad_nick");
    await bad.closed;

    const flood = await connect(server.port, null, "Ana");
    for (let i = 0; i < 200; i++) flood.ws.send(encode({ t: "refill", seq: i + 1 }));
    await flood.closed;
    expect(flood.mirror.fatal).toBe("rate_limited");

    const garbage = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(garbage);
    const closed = new Promise<number>((c) => garbage.on("close", (code) => c(code)));
    garbage.on("open", () => garbage.send("not json"));
    expect(await closed).toBe(1008);
  });
});
