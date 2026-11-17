// An in-process room behind the client's Dial interface, for UI tests. The
// room runs on the page's timers (fake timers in tests) at its own pace, and
// every message crosses an async boundary, as it would over a socket.
import { Room } from "@ape/game";
import type { RoomEvent } from "@ape/game";
import { sha256, toHex } from "@ape/engine";
import type { Dial } from "../src/net/connection.ts";

export function loopback(tag = 1): { dial: Dial; room: () => Room | null; hellos: Record<string, unknown>[]; events: RoomEvent[] } {
  let room: Room | null = null;
  const hellos: Record<string, unknown>[] = [];
  const events: RoomEvent[] = [];
  let n = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const sockets = new Map<string, (text: string) => void>();
  const arm = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => room!.clock(), 1000 / room!.ticksPerSecond);
  };
  const dial: Dial = (h) => {
    let pid: string | null = null;
    let open = true;
    const deliver = (text: string): void => {
      queueMicrotask(() => {
        if (open) h.message(text);
      });
    };
    queueMicrotask(() => h.open());
    return {
      send: (text) => {
        queueMicrotask(() => {
          if (!open) return;
          if (pid !== null) {
            room!.handle(pid, text);
            return;
          }
          const hello = JSON.parse(text) as { room: string | null; nick: string; token: string | null };
          hellos.push(hello);
          if (room === null) {
            room = new Room(hello.room ?? "loop42", {
              newSeed: () => sha256(new Uint8Array([tag, n & 255, (n++ >>> 8) & 255, 0x11])),
              newToken: () => toHex(sha256(new Uint8Array([tag, n++ & 255, 0x22]))).slice(0, 32),
              now: () => Date.now(),
              send: (to, frame) => sockets.get(to)?.(frame),
              onPace: () => arm(),
              track: (_pid, ev) => events.push(ev),
            });
            arm();
          }
          const r = room.join(hello.nick, hello.token);
          if (!r.ok) {
            deliver(JSON.stringify([{ t: "error", error: r.error }]));
            return;
          }
          pid = r.pid;
          sockets.set(pid, deliver);
          room.flush();
        });
      },
      close: () => {
        open = false;
        if (pid !== null && room !== null) {
          sockets.delete(pid);
          room.leave(pid);
        }
        queueMicrotask(() => h.close());
      },
    };
  };
  return { dial, room: () => room, hellos, events };
}
