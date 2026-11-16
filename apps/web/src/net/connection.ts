// Keeps one seat in one room connected: says hello, reconnects with the
// seat's token after a drop, and remembers the token per room so a reload
// gets the same seat and bags back.

import { RoomMirror, encode } from "@ape/game";

export interface Socket {
  send(text: string): void;
  close(): void;
}

export interface SocketHandlers {
  open(): void;
  message(text: string): void;
  close(): void;
}

/** Opens a connection to the room server. Swapped for an in-process room in tests. */
export type Dial = (handlers: SocketHandlers) => Socket;

export function browserDial(): Dial {
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  return (h) => {
    const ws = new WebSocket(url);
    ws.onopen = () => h.open();
    ws.onmessage = (e) => h.message(String(e.data));
    ws.onclose = () => h.close();
    return {
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: () => ws.close(),
    };
  };
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: a reload then takes a new seat.
  }
}

// Seat tokens live per tab: a reload keeps the seat, a second tab is a second player.
function readSeat(code: string): string | null {
  try {
    return sessionStorage.getItem(`aor.seat.${code}`);
  } catch {
    return null;
  }
}

function writeSeat(code: string, token: string): void {
  try {
    sessionStorage.setItem(`aor.seat.${code}`, token);
  } catch {
    // Private mode: a reload then takes a new seat.
  }
}

export class Connection {
  readonly mirror: RoomMirror;
  readonly #dial: Dial;
  readonly #nick: string;
  #code: string | null;
  #socket: Socket | null = null;
  #attempt = 0;
  #stopped = false;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #gen = 0;
  /** Called once the room code is known, so the page can show it in the address bar. */
  onRoom: ((code: string) => void) | null = null;

  constructor(dial: Dial, code: string | null, nick: string) {
    this.#dial = dial;
    this.#code = code;
    this.#nick = nick;
    this.mirror = new RoomMirror((text) => this.#socket?.send(text));
  }

  start(): void {
    this.#stopped = false;
    this.open();
  }

  stop(): void {
    this.#stopped = true;
    this.#gen++;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    const s = this.#socket;
    this.#socket = null;
    s?.close();
  }

  /** Try again now, e.g. after the player pressed "Reconnect". */
  retry(): void {
    this.stop();
    this.mirror.fatal = null;
    this.#attempt = 0;
    this.start();
  }

  private open(): void {
    this.mirror.setStatus("connecting");
    // Handlers of a socket that has since been replaced or stopped do nothing.
    const gen = ++this.#gen;
    const socket: Socket = this.#dial({
      open: () => {
        if (gen !== this.#gen) return;
        const token = this.#code === null ? null : readSeat(this.#code);
        socket.send(encode({ t: "hello", room: this.#code, nick: this.#nick, token }));
      },
      message: (text) => {
        if (gen !== this.#gen) return;
        const wasReady = this.mirror.you !== null && this.mirror.status === "open";
        this.mirror.receive(text);
        if (!wasReady && this.mirror.status === "open" && this.mirror.you !== null) {
          this.#attempt = 0;
          this.#code = this.mirror.code;
          writeSeat(this.mirror.code, this.mirror.you.token);
          this.onRoom?.(this.mirror.code);
        }
      },
      close: () => {
        if (gen !== this.#gen) return;
        this.#socket = null;
        // A refused seat (full room, bad nickname, opened elsewhere) is not retried by itself.
        if (this.#stopped || this.mirror.fatal !== null) {
          this.mirror.setStatus("closed");
          return;
        }
        this.mirror.setStatus("connecting");
        const wait = Math.min(5000, 500 * 2 ** this.#attempt++);
        this.#retry = setTimeout(() => {
          this.#retry = null;
          if (!this.#stopped) this.open();
        }, wait);
      },
    });
    this.#socket = socket;
  }
}

export { readKey, writeKey };
