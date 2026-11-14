// Full-size uniformity test of the random stream (math spec 10.5 #3).
// Chi-square and serial correlation on the 10-bit growth index and the 32-bit
// rug integer, over at least 10^8 draws. Run: pnpm test:stream [draws]

import { CoinStream, RoundKey } from "../src/engine.ts";
import { sha256 } from "../src/sha256.ts";

const N = Number(process.argv[2] ?? "100000000");
const PER_STREAM = 1_000_000;
const LAGS = 10;

const idxCounts = new Float64Array(1024);
const rugHigh = new Float64Array(4096);
const rugLow = new Float64Array(4096);
// Serial correlation of consecutive ticks: sums of x_t * x_{t+k}
const series = [
  { name: "growth index (10 bits)", ring: new Float64Array(LAGS), sum: 0, sq: 0, cross: new Float64Array(LAGS + 1), pairs: new Float64Array(LAGS + 1) },
  { name: "rug integer (32 bits)", ring: new Float64Array(LAGS), sum: 0, sq: 0, cross: new Float64Array(LAGS + 1), pairs: new Float64Array(LAGS + 1) },
];

const w = new Int32Array(8);
let drawn = 0;
const started = Date.now();
for (let streamNo = 0; drawn < N; streamNo++) {
  const seed = sha256(new Uint8Array([streamNo & 255, (streamNo >>> 8) & 255, 0x51, 0x7e]));
  const stream = new CoinStream(new RoundKey(seed, `u${streamNo}`), streamNo % 3);
  for (const s of series) s.ring.fill(Number.NaN);
  for (let t = 1; t <= PER_STREAM && drawn < N; t++, drawn++) {
    stream.digest(t, 0, w);
    const idx = w[2]! >>> 22;
    const rug = w[1]! >>> 0;
    idxCounts[idx]!++;
    rugHigh[rug >>> 20]!++;
    rugLow[rug & 4095]!++;
    const values = [idx / 1024, rug / 4294967296];
    for (let k = 0; k < 2; k++) {
      const s = series[k]!;
      const x = values[k]! - 0.5;
      s.sum += x;
      s.sq += x * x;
      for (let lag = 1; lag <= LAGS; lag++) {
        const prev = s.ring[(t - lag + LAGS * 4) % LAGS]!;
        if (t > lag) {
          s.cross[lag]! += x * prev;
          s.pairs[lag]!++;
        }
      }
      s.ring[t % LAGS] = x;
    }
  }
}

let ok = true;
function chi(name: string, counts: Float64Array): void {
  const expected = drawn / counts.length;
  let stat = 0;
  for (const c of counts) stat += ((c - expected) * (c - expected)) / expected;
  const df = counts.length - 1;
  // Wilson-Hilferty: chi-square to a standard normal z
  const z = (Math.cbrt(stat / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  const pass = Math.abs(z) < 4;
  if (!pass) ok = false;
  console.log(`chi-square ${name}: ${stat.toFixed(1)} on ${df} df, z = ${z.toFixed(2)} ${pass ? "PASS" : "FAIL"}`);
}

console.log(`${drawn.toLocaleString("en-US")} draws, ${((Date.now() - started) / 1000).toFixed(0)} s`);
chi("growth index, 1024 bins", idxCounts);
chi("rug integer, top 12 bits", rugHigh);
chi("rug integer, low 12 bits", rugLow);
for (const s of series) {
  const variance = s.sq / drawn;
  const cells: string[] = [];
  for (let lag = 1; lag <= LAGS; lag++) {
    const r = s.cross[lag]! / s.pairs[lag]! / variance;
    const z = r * Math.sqrt(s.pairs[lag]!);
    if (Math.abs(z) >= 4) ok = false;
    cells.push(`${lag}: ${z.toFixed(2)}`);
  }
  console.log(`serial correlation z-scores, ${s.name}: ${cells.join(", ")} ${cells.length > 0 ? "" : ""}`);
}
console.log(ok ? "RESULT: PASS (all |z| < 4)" : "RESULT: FAIL");
process.exitCode = ok ? 0 : 1;
