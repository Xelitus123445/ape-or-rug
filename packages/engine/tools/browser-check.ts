// Determinism in a real browser (math spec 10.5 #4): bundles the engine,
// serves it on localhost, opens it in headless Edge or Chrome and compares the
// golden round hashes the browser computed with the ones Node expects.
// Run: pnpm test:browser

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { GOLDEN_ROUNDS } from "../test/golden.ts";

interface BrowserResult {
  ok: boolean;
  agent?: string;
  error?: string;
  rows?: { roundId: string; expected: string; actual: string }[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const bundle = await build({
  entryPoints: [join(root, "packages/engine/test/browser-entry.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  write: false,
});
const script = bundle.outputFiles[0]!.text;
const html = `<!doctype html><meta charset="utf-8"><title>engine browser check</title><body><script src="/engine.js"></script><script>fetch("/result",{method:"POST",body:document.getElementById("result").textContent})</script></body>`;

const candidates = [
  process.env.BROWSER_PATH ?? "",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p) => p !== "" && existsSync(p));
if (candidates.length === 0) {
  console.error("No browser found. Set BROWSER_PATH to an Edge or Chrome executable.");
  process.exit(2);
}

const result = await new Promise<BrowserResult | null>((done) => {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        res.end("ok");
        finish(JSON.parse(body) as BrowserResult);
      });
    } else if (req.url === "/engine.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end(script);
    } else {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    }
  });
  let browser: ReturnType<typeof spawn> | null = null;
  // --manual: do not launch a browser; print the address and wait for any
  // browser to open it (for machines where headless launch is blocked).
  const manual = process.argv.includes("--manual");
  const timer = setTimeout(() => finish(null), manual ? 600_000 : 90_000);
  function finish(value: BrowserResult | null): void {
    clearTimeout(timer);
    browser?.kill();
    server.close();
    done(value);
  }
  server.listen(manual ? 47831 : 0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    if (manual) {
      console.log(`open http://127.0.0.1:${port}/ in a browser (waiting up to 10 minutes)`);
      return;
    }
    const profile = join(root, "dist", "browser-profile");
    mkdirSync(profile, { recursive: true });
    browser = spawn(candidates[0]!, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`], { stdio: "ignore" });
  });
});

if (result === null) {
  console.error("Browser did not report a result in time. If headless launch is blocked here, run with --manual and open the printed address.");
  process.exit(1);
}
console.log(`browser: ${result.agent ?? "unknown"}`);
if (result.error !== undefined) console.error(result.error);
for (const r of result.rows ?? []) console.log(`${r.actual === r.expected ? "ok  " : "DIFF"} ${r.roundId} ${r.actual}`);
const complete = (result.rows?.length ?? 0) === GOLDEN_ROUNDS.length;
console.log(result.ok && complete ? `RESULT: PASS (${GOLDEN_ROUNDS.length} rounds bit-identical in Node and the browser)` : "RESULT: FAIL");
process.exit(result.ok && complete ? 0 : 1);
