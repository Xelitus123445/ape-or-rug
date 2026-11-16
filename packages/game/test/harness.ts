// A room wired to in-process clients through the real wire format: every
// message is encoded and decoded exactly as it would be over a socket.
import { sha256, toHex } from "@ape/engine";
import { Room, RoomMirror, decodeServer } from "../src/index.ts";
import type { ServerMsg } from "../src/index.ts";

export interface Frame {
  readonly pid: string;
  readonly text: string;
  readonly msgs: ServerMsg[];
  /** Each lane's round id and last played tick at the moment the frame left the room. */
  readonly played: ReadonlyMap<string, number>;
}

export interface Harness {
  readonly room: Room;
  readonly frames: Frame[];
  readonly mirrors: Map<string, RoomMirror>;
  /** Wall clock for seat holding, in ms. */
  now: number;
  /** Seats a player with a fresh mirror; returns its id and mirror. */
  join(nick: string, token?: string | null): { pid: string; mirror: RoomMirror } | { error: string };
  /** Messages a client tried to send while `hold` is on, not yet delivered. */
  readonly held: { pid: string; text: string }[];
  hold: boolean;
  deliverHeld(): void;
  acks(pid: string): Extract<ServerMsg, { t: "ack" }>[];
}

export function seedSource(tag: number): { next: () => Uint8Array; all: Uint8Array[] } {
  const all: Uint8Array[] = [];
  let i = 0;
  return {
    all,
    next: () => {
      const s = sha256(new Uint8Array([tag & 255, (tag >>> 8) & 255, i & 255, (i >>> 8) & 255, (i >>> 16) & 255, 0x3c]));
      i++;
      all.push(s);
      return s;
    },
  };
}

export function harness(tag: number, newSeed?: () => Uint8Array): Harness {
  const seeds = seedSource(tag);
  let tokens = 0;
  const frames: Frame[] = [];
  const mirrors = new Map<string, RoomMirror>();
  const h: Harness = {
    room: null as unknown as Room,
    frames,
    mirrors,
    now: 0,
    held: [],
    hold: false,
    join(nick, token = null) {
      const mirror = new RoomMirror(() => {
        throw new Error("mirror sent before it had a seat");
      });
      const r = h.room.join(nick, token);
      if (!r.ok) return { error: r.error };
      const pid = r.pid;
      // A rejoin replaces the old client, as a new socket would.
      mirrors.set(pid, mirror);
      h.room.flush();
      mirror.setSender((text) => {
        if (h.hold) h.held.push({ pid, text });
        else h.room.handle(pid, text);
      });
      return { pid, mirror };
    },
    deliverHeld() {
      const all = h.held.splice(0);
      for (const m of all) h.room.handle(m.pid, m.text);
    },
    acks(pid) {
      const out: Extract<ServerMsg, { t: "ack" }>[] = [];
      for (const f of frames) if (f.pid === pid) for (const m of f.msgs) if (m.t === "ack") out.push(m);
      return out;
    },
  };
  (h as { room: Room }).room = new Room("abc234", {
    newSeed: newSeed ?? seeds.next,
    newToken: () => toHex(sha256(new Uint8Array([tag & 255, tokens++ & 255, 0x7d]))).slice(0, 32),
    now: () => h.now,
    send: (pid, text) => {
      const played = new Map<string, number>();
      for (const l of h.room.lanes) played.set(l.roundId, l.state.tick);
      frames.push({ pid, text, msgs: decodeServer(text), played });
      mirrors.get(pid)?.receive(text);
    },
  });
  return h;
}

/** Runs the room until `count` more coins have ended. */
export function playCoins(room: Room, count: number, onTick?: () => void): void {
  const target = room.coinsPlayed + count;
  let guard = 0;
  while (room.coinsPlayed < target) {
    room.clock();
    onTick?.();
    if (++guard > 40 * room.engine.config.maxTicks) throw new Error("coins did not end");
  }
}

/** Launches every waiting coin through the host. */
export function skipAll(mirror: RoomMirror): void {
  for (let i = 0; i < 3; i++) mirror.skipWait(i);
}
