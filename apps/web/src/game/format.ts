// Display formatting. Floats are fine here: this is rendering, not accounting.
import { PRICE_SCALE } from "@ape/engine";
import { CURRENCY } from "../strings.ts";

/** Minor units (1/100) to "1,234.56". */
export function money(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${cents}`;
}

export function usdk(minor: bigint): string {
  return `${money(minor)} ${CURRENCY}`;
}

export function signedUsdk(minor: bigint): string {
  return `${minor > 0n ? "+" : ""}${money(minor)} ${CURRENCY}`;
}

/** Whole play coins without cents, for stake chips. */
export function chip(minor: bigint): string {
  return (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function multOf(price: bigint): number {
  return Number(price) / Number(PRICE_SCALE);
}

export function mult(price: bigint): string {
  const m = multOf(price);
  return `${m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)}x`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
