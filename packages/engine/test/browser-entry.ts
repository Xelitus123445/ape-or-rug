// Runs inside a real browser (see tools/browser-check.ts): recomputes the
// golden rounds with the browser build of the engine and prints the hashes.
import { createEngine, generateRound, roundHash } from "../src/engine.ts";
import { fromHex } from "../src/sha256.ts";
import { GOLDEN_ROUNDS } from "./golden.ts";

const out = document.createElement("pre");
out.id = "result";
try {
  const engine = createEngine();
  const rows = GOLDEN_ROUNDS.map((g) => ({
    roundId: g.roundId,
    expected: g.hash,
    actual: roundHash(generateRound(engine, fromHex(g.seed), g.roundId)),
  }));
  out.textContent = JSON.stringify({ ok: rows.every((r) => r.actual === r.expected), agent: navigator.userAgent, rows });
} catch (e) {
  out.textContent = JSON.stringify({ ok: false, error: String(e) });
}
document.body.appendChild(out);
