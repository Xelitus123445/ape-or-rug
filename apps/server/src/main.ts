// Entry point: `pnpm start` (or `node apps/server/src/main.ts`).
// PORT and HOST come from the environment; the built web app is served from
// apps/web/dist when it exists.
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const staticDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

const server = await startServer({ port, host, staticDir });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
