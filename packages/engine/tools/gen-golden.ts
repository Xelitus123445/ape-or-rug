// Prints golden round hashes for test/golden.ts. Only run this when a spec
// change deliberately alters rounds; otherwise a changed hash is a bug.
// Run: node packages/engine/tools/gen-golden.ts

import { writeFileSync } from "node:fs";
import { createEngine, generateRound, roundHash } from "../src/engine.ts";
import { sha256, toHex } from "../src/sha256.ts";

const engine = createEngine();
const rows: string[] = [];
for (let i = 0; i < 12; i++) {
  const seed = sha256(new Uint8Array([i, 0xa9, 0xe0, 0x52]));
  const roundId = `golden-${i}`;
  const hash = roundHash(generateRound(engine, seed, roundId));
  rows.push(`  { seed: "${toHex(seed)}", roundId: "${roundId}", hash: "${hash}" },`);
}
writeFileSync(
  new URL("../test/golden.ts", import.meta.url),
  `// Golden rounds: fixed seeds with the SHA-256 of their full tick series.\n// The browser determinism check uses the same list.\n// Regenerate with tools/gen-golden.ts only after a deliberate spec change.\nexport const GOLDEN_ROUNDS: readonly { seed: string; roundId: string; hash: string }[] = [\n${rows.join("\n")}\n];\n`,
);
console.log(rows.join("\n"));
