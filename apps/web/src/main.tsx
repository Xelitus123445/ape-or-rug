import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Error tracking is switched on by the server's settings; without a DSN the Sentry code is never loaded.
void fetch("/config.json")
  .then((r) => (r.ok ? (r.json() as Promise<{ sentryDsn?: string | null; sentryEnv?: string | null }>) : {}))
  .then(async (cfg: { sentryDsn?: string | null; sentryEnv?: string | null }) => {
    if (typeof cfg.sentryDsn !== "string" || cfg.sentryDsn === "") return;
    const Sentry = await import("@sentry/browser");
    Sentry.init({ dsn: cfg.sentryDsn, environment: cfg.sentryEnv ?? "playtest" });
  })
  .catch(() => undefined);
