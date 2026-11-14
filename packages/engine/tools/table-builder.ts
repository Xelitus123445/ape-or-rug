// Offline growth-table construction (math spec 10.3). Floating point is allowed
// here and only here: the output is a list of integers that gets committed and
// checksummed. The engine never runs this code.

import { PRICE_SCALE, TABLE_SIZE, TWO_32 } from "../src/config.ts";

/** Inverse standard normal CDF (Acklam's rational approximation, rel. error ~1e-9). */
export function inverseNormalCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const tail = (q: number): number =>
    (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p < pLow) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - pLow) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** Largest table sum that does not favour the player: floor(2^32 * K * SCALE / (2^32 - H)). */
export function targetSum(H: bigint): bigint {
  return (TWO_32 * BigInt(TABLE_SIZE) * PRICE_SCALE) / (TWO_32 - H);
}

/**
 * Builds the K-entry integer growth table for rug threshold H and per-tick
 * volatility sigma. Shape: lognormal quantiles at (i + 0.5) / K, rescaled so the
 * variance matches the lognormal, then shifted so the sum is exactly targetSum(H).
 */
export function buildTable(H: bigint, sigma: number): bigint[] {
  if (H <= 0n || H >= TWO_32 / 2n) throw new Error("buildTable: hazard out of range");
  if (!(sigma > 0 && sigma < 0.5)) throw new Error("buildTable: sigma out of range");
  const K = TABLE_SIZE;
  const h = Number(H) / 4294967296;
  const mean = 1 / (1 - h);
  const variance = (Math.exp(sigma * sigma) - 1) * mean * mean;

  const z: number[] = [];
  for (let i = 0; i < K; i++) z.push(inverseNormalCdf((i + 0.5) / K));

  // Midpoint quantiles lose a little variance in the tails; widen z until the
  // table variance matches the lognormal it stands for.
  let widen = 1;
  let g: number[] = [];
  for (let iter = 0; iter < 40; iter++) {
    g = z.map((zi) => Math.exp(sigma * widen * zi));
    const m = g.reduce((s, x) => s + x, 0) / K;
    g = g.map((x) => (x * mean) / m);
    const v = g.reduce((s, x) => s + (x - mean) * (x - mean), 0) / K;
    widen *= Math.sqrt(variance / v);
  }

  const raw = g.map((x) => BigInt(Math.floor(x * 1e9)));
  const rawSum = raw.reduce((s, x) => s + x, 0n);
  const target = targetSum(H);
  const table = raw.map((x) => (x * target) / rawSum);
  const sum = table.reduce((s, x) => s + x, 0n);
  let rest = target - sum;
  if (rest < 0n || rest >= BigInt(K)) throw new Error("buildTable: remainder out of range");
  // Hand the leftover units to the largest entries; order stays ascending.
  for (let i = K - 1; rest > 0n; i--, rest--) table[i] = table[i]! + 1n;
  return table;
}

/** Canonical text of one table; the checksum is SHA-256 over these lines joined by "\n". */
export function tableLine(index: number, H: bigint, sigmaPpb: bigint, table: readonly bigint[]): string {
  return `${index}:${H}:${sigmaPpb}:${table.join(",")}`;
}
