// Playtest telemetry. Every event is appended to a local JSONL file (the
// record the report reads) and, when a key is set, sent to PostHog in
// batches. Only random ids, the invite-link tag and game facts are recorded:
// no nicknames, no addresses, nothing a player typed.

import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";
import { PRICE_SCALE } from "@ape/engine";
import type { RoomEvent } from "@ape/game";

export type PropValue = string | number | boolean | null;

export interface TrackedEvent {
  /** ISO time the server saw it. */
  readonly ts: string;
  readonly event: string;
  readonly anon: string;
  readonly session: string;
  readonly source: string | null;
  readonly room: string;
  readonly props: Readonly<Record<string, PropValue>>;
}

export interface Sink {
  write(e: TrackedEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A room event as report-friendly numbers: money in USDK (two decimals),
 * prices as multipliers, basis points as they are.
 */
export function eventProps(ev: RoomEvent): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (k === "name") continue;
    if (typeof v === "bigint") out[k] = k === "price" ? Number(v) / Number(PRICE_SCALE) : k === "bps" ? Number(v) : Number(v) / 100;
    else out[k] = v as PropValue;
  }
  return out;
}

/** Appends one JSON line per event. A file that cannot be written is logged once and the game goes on. */
export class JsonlSink implements Sink {
  readonly #stream: WriteStream | null = null;
  #failed = false;

  constructor(path: string, log: (line: string) => void) {
    const fail = (e: unknown): void => {
      if (!this.#failed) log(`events file ${path}: ${e instanceof Error ? e.message : String(e)}`);
      this.#failed = true;
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.#stream = createWriteStream(path, { flags: "a" });
      this.#stream.on("error", fail);
    } catch (e) {
      fail(e);
    }
  }

  write(e: TrackedEvent): void {
    if (!this.#failed) this.#stream?.write(`${JSON.stringify(e)}\n`);
  }

  flush(): Promise<void> {
    return new Promise((done) => {
      if (this.#failed || this.#stream === null) done();
      else this.#stream.write("", () => done());
    });
  }

  close(): Promise<void> {
    return new Promise((done) => {
      if (this.#stream === null || this.#stream.destroyed) done();
      else this.#stream.end(() => done());
    });
  }
}

export interface PostHogOptions {
  readonly key: string;
  readonly host: string;
  readonly fetch?: typeof fetch;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  /** Events kept while PostHog is unreachable; the oldest go first. The JSONL file keeps everything anyway. */
  readonly maxQueue?: number;
  readonly log: (line: string) => void;
}

export class PostHogSink implements Sink {
  readonly #o: Required<Omit<PostHogOptions, "fetch">> & { fetch: typeof fetch };
  #queue: TrackedEvent[] = [];
  #sending: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval>;
  #warned = false;

  constructor(o: PostHogOptions) {
    this.#o = { batchSize: 50, intervalMs: 5000, maxQueue: 10_000, fetch: globalThis.fetch, ...o, host: o.host.replace(/\/+$/, "") };
    this.#timer = setInterval(() => void this.flush(), this.#o.intervalMs);
    this.#timer.unref();
  }

  write(e: TrackedEvent): void {
    this.#queue.push(e);
    if (this.#queue.length > this.#o.maxQueue) this.#queue.splice(0, this.#queue.length - this.#o.maxQueue);
    if (this.#queue.length >= this.#o.batchSize) void this.flush();
  }

  /** Sends everything queued; one send at a time. */
  flush(): Promise<void> {
    if (this.#sending !== null) return this.#sending.then(() => (this.#queue.length > 0 ? this.flush() : undefined));
    if (this.#queue.length === 0) return Promise.resolve();
    this.#sending = this.send().finally(() => {
      this.#sending = null;
    });
    return this.#sending;
  }

  private async send(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.slice(0, this.#o.batchSize);
      const body = {
        api_key: this.#o.key,
        batch: batch.map((e) => ({
          event: e.event,
          distinct_id: e.anon,
          timestamp: e.ts,
          properties: { ...e.props, source: e.source, room: e.room, $session_id: e.session, $geoip_disable: true, $lib: "ape-or-rug-server" },
        })),
      };
      try {
        const res = await this.#o.fetch(`${this.#o.host}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.#queue.splice(0, batch.length);
        this.#warned = false;
      } catch (e) {
        // Kept for the next try; one log line per outage.
        if (!this.#warned) this.#o.log(`posthog: ${e instanceof Error ? e.message : String(e)}`);
        this.#warned = true;
        return;
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.flush();
  }
}

/** Fans one event out to every sink; a broken sink never reaches the game. */
export class Telemetry {
  readonly #sinks: readonly Sink[];
  readonly #log: (line: string) => void;

  constructor(sinks: readonly Sink[], log: (line: string) => void) {
    this.#sinks = sinks;
    this.#log = log;
  }

  get enabled(): boolean {
    return this.#sinks.length > 0;
  }

  emit = (e: TrackedEvent): void => {
    for (const s of this.#sinks) {
      try {
        s.write(e);
      } catch (err) {
        this.#log(`telemetry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  async flush(): Promise<void> {
    await Promise.all(this.#sinks.map((s) => s.flush().catch(() => undefined)));
  }

  async close(): Promise<void> {
    await Promise.all(this.#sinks.map((s) => s.close().catch(() => undefined)));
  }
}
