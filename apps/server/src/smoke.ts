// pnpm smoke [base-url]   e.g. pnpm smoke https://ape-or-rug.up.railway.app
// Checks a running build end to end: the pages, the settings endpoint, and
// one tagged test player (source "dev", left out of reports) who opens a
// room, buys once and leaves.
import { WebSocket } from "ws";
import { RoomMirror, STAKES, encode } from "@ape/game";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const fail = (why: string): never => {
  console.error(`FAIL: ${why}`);
  process.exit(1);
};

for (const path of ["/health", "/config.json", "/", "/?room=abcdef&src=dev"]) {
  const r = await fetch(base + path);
  const body = await r.text();
  console.log(`${path} -> ${r.status} ${r.headers.get("content-type") ?? ""} ${body.slice(0, 50).replace(/\s+/g, " ")}`);
  if (!r.ok) fail(`${path} returned ${r.status}`);
}

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
const mirror = new RoomMirror((t) => ws.send(t));
const id = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
await new Promise<void>((done) => {
  const timer = setTimeout(() => fail("no welcome within 10 s"), 10_000);
  ws.on("open", () => ws.send(encode({ t: "hello", room: null, nick: "Smoke test", token: null, anon: id(), session: id(), source: "dev" })));
  ws.on("message", (d) => {
    mirror.receive(d.toString());
    if (mirror.fatal !== null) fail(`refused: ${mirror.fatal}`);
    if (mirror.ready) {
      clearTimeout(timer);
      done();
    }
  });
  ws.on("error", (e) => fail(e.message));
});
for (let i = 0; i < 3; i++) mirror.skipWait(i);
await new Promise((r) => setTimeout(r, 1500));
mirror.buy(0, STAKES[0]!);
mirror.trackTutorial(0, "shown");
await new Promise((r) => setTimeout(r, 800));
if (mirror.holding(0).stake !== STAKES[0]!) fail(`buy did not go through (${mirror.lastError?.error ?? "no answer"})`);
console.log(`room ${mirror.code}: bought ${STAKES[0]! / 100n} USDK, balance ${mirror.balance / 100n} USDK`);
ws.close();
await new Promise((r) => setTimeout(r, 300));
console.log("OK");
process.exit(0);
