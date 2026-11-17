// Entry point: `pnpm start` (or `node apps/server/src/main.ts`).
// Settings come from the environment (see .env.example); the built web app
// is served from apps/web/dist when it exists.
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";
import { JsonlSink, PostHogSink, Telemetry } from "./telemetry.ts";
import type { Sink } from "./telemetry.ts";

const env = (name: string): string | null => {
  const v = process.env[name]?.trim();
  return v === undefined || v === "" ? null : v;
};
const log = (line: string): void => console.log(line);

const port = Number(env("PORT") ?? 8787);
const host = env("HOST") ?? "127.0.0.1";
const staticDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

// Errors go to Sentry only when a DSN is set. Loaded lazily so a run without it needs nothing.
let onError: ((e: unknown) => void) | undefined;
const sentryDsn = env("SENTRY_DSN");
if (sentryDsn !== null) {
  const Sentry = await import("@sentry/node");
  Sentry.init({ dsn: sentryDsn, environment: env("SENTRY_ENV") ?? "playtest", release: env("RAILWAY_GIT_COMMIT_SHA") ?? undefined, tracesSampleRate: 0 });
  onError = (e) => Sentry.captureException(e);
  log("sentry: on");
}

// Every event goes to the JSONL file; PostHog gets a copy when a key is set.
const sinks: Sink[] = [];
const eventsFile = env("EVENTS_FILE") ?? fileURLToPath(new URL("../../../data/events.jsonl", import.meta.url));
if (eventsFile !== "off") {
  sinks.push(new JsonlSink(eventsFile, log));
  log(`events: ${eventsFile}`);
}
const posthogKey = env("POSTHOG_KEY");
if (posthogKey !== null) {
  sinks.push(new PostHogSink({ key: posthogKey, host: env("POSTHOG_HOST") ?? "https://eu.i.posthog.com", log }));
  log("posthog: on");
}
const telemetry = new Telemetry(sinks, log);

const server = await startServer({
  port,
  host,
  staticDir,
  log,
  track: telemetry.enabled ? telemetry.emit : undefined,
  onError,
  // Only a DSN meant for the browser is published; the server's own stays private.
  clientConfig: { sentryDsn: env("SENTRY_DSN_WEB"), sentryEnv: env("SENTRY_ENV") ?? "playtest" },
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    // Sessions still open are ended, and every event is written before the process goes.
    void server
      .close()
      .then(() => telemetry.close())
      .finally(() => process.exit(0));
  });
}
