// Writes golden round hashes to test/golden.ts. Only run this when a spec
// change deliberately alters rounds; otherwise a changed hash is a bug.
// Run: node packages/engine/tools/gen-golden.ts

import { writeFileSync } from "node:fs";
import { STATUS_SETTLED } from "../src/config.ts";
import { createEngine, generateRound, roundHash } from "../src/engine.ts";
import { sha256, toHex } from "../src/sha256.ts";

const engine = createEngine();
const rows: string[] = [];
const PLAIN = 12;
const WITH_SETTLEMENT = 3;
let settledFound = 0;
// The first twelve seeds are taken as they come. After that, keep only rounds
// in which a coin survives to the maximum length, so settlement is covered too.
for (let i = 0; i < 256 && settledFound < WITH_SETTLEMENT; i++) {
  const seed = sha256(new Uint8Array([i, 0xa9, 0xe0, 0x52]));
  const roundId = `golden-${i}`;
  const round = generateRound(engine, seed, roundId);
  const settled = round.coins.some((c) => c.ticks[c.ticks.length - 1]!.status === STATUS_SETTLED);
  if (i >= PLAIN) {
    if (!settled) continue;
    settledFound++;
  }
  const graduated = round.coins.filter((c) => c.ticks[c.ticks.length - 1]!.graduated).length;
  rows.push(`  { seed: "${toHex(seed)}", roundId: "${roundId}", hash: "${roundHash(round)}" }, // ${settled ? "has a settled coin" : "all rugged"}, ${graduated} graduated`);
}
if (settledFound < WITH_SETTLEMENT) throw new Error("not enough rounds with a settled coin");
writeFileSync(
  new URL("../test/golden.ts", import.meta.url),
  `// Golden rounds: fixed seeds with the SHA-256 of their full tick series.\n// The browser determinism check uses the same list.\n// Regenerate with tools/gen-golden.ts only after a deliberate spec change.\nexport const GOLDEN_ROUNDS: readonly { seed: string; roundId: string; hash: string }[] = [\n${rows.join("\n")}\n];\n`,
);
console.log(rows.join("\n"));
