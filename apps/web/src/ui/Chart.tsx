import { useEffect, useRef } from "react";

interface Props {
  history: readonly number[];
  marks?: readonly { tick: number; kind: "buy" | "sell" }[];
  rugged: boolean;
  /** Changes every tick so the canvas redraws. */
  version: number;
  /** Small line chart for a coin card; otherwise candles. */
  compact?: boolean;
}

const CANDLE_SIZES = [3, 6, 12, 24, 48, 96];
const MAX_CANDLES = 64;

/** Ticks per candle: the smallest size that keeps the chart under MAX_CANDLES candles. */
export function candleSize(ticks: number): number {
  for (const size of CANDLE_SIZES) if (ticks / size <= MAX_CANDLES) return size;
  return CANDLE_SIZES[CANDLE_SIZES.length - 1]!;
}

function niceStep(range: number): number {
  const rough = range / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

/**
 * Price chart on a canvas. The main chart draws candles (open, high, low,
 * close over a few ticks each); the compact one draws a line. The y range
 * follows the data and a dashed line marks 1.00x.
 */
export function Chart({ history, marks = [], rugged, version, compact = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 120;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(canvas);
    const up = css.getPropertyValue("--up").trim() || "#3ddc84";
    const down = css.getPropertyValue("--down").trim() || "#ff5c5c";
    const grid = css.getPropertyValue("--line").trim() || "#2a3142";
    const text = css.getPropertyValue("--muted").trim() || "#8b93a7";
    const gold = css.getPropertyValue("--gold").trim() || "#ffd166";

    const n = history.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of history) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    lo = Math.min(lo, 1);
    hi = Math.max(hi, 1);
    const spread = Math.max(hi - lo, 0.08);
    lo = Math.max(0, lo - spread * 0.12);
    hi = hi + spread * 0.12;
    if (rugged) lo = 0;
    const last = history[n - 1] ?? 1;

    if (compact) {
      const pad = 2;
      const span = Math.max(n - 1, 30);
      const x = (i: number): number => pad + ((w - pad * 2) * i) / span;
      const y = (v: number): number => h - pad - ((h - pad * 2) * (v - lo)) / (hi - lo);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pad, y(1));
      ctx.lineTo(w - pad, y(1));
      ctx.stroke();
      ctx.setLineDash([]);
      const color = rugged ? down : last >= 1 ? up : down;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (i === 0) ctx.moveTo(x(i), y(history[i]!));
        else ctx.lineTo(x(i), y(history[i]!));
      }
      ctx.stroke();
      return;
    }

    // ----- candles -----
    const axis = 44;
    const top = 8;
    const bottom = 8;
    const left = 4;
    const plotW = w - axis - left;
    const y = (v: number): number => h - bottom - ((h - top - bottom) * (v - lo)) / (hi - lo);

    // Horizontal grid with price labels on the right.
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const step = niceStep(hi - lo);
    ctx.lineWidth = 1;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ctx.strokeStyle = grid;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(y(v)) + 0.5);
      ctx.lineTo(left + plotW, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = text;
      ctx.fillText(`${v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}x`, left + plotW + 6, y(v));
    }
    // Launch price.
    ctx.strokeStyle = text;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(left, Math.round(y(1)) + 0.5);
    ctx.lineTo(left + plotW, Math.round(y(1)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const size = candleSize(n - 1);
    const count = Math.max(1, Math.ceil((n - 1) / size));
    const slots = Math.max(count, 24);
    const slot = plotW / slots;
    const body = Math.max(2, Math.min(14, slot * 0.68));
    const cx = (k: number): number => left + slot * (k + 0.5);

    for (let k = 0; k < count; k++) {
      const from = k * size;
      const to = Math.min(n - 1, from + size);
      const open = history[from]!;
      const close = history[to]!;
      let high = open;
      let low = open;
      for (let i = from; i <= to; i++) {
        const v = history[i]!;
        if (v > high) high = v;
        if (v < low) low = v;
      }
      const color = close >= open ? up : down;
      const xk = Math.round(cx(k)) + 0.5;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xk, y(high));
      ctx.lineTo(xk, y(low));
      ctx.stroke();
      const yTop = y(Math.max(open, close));
      const yBottom = y(Math.min(open, close));
      ctx.fillRect(xk - body / 2, yTop, body, Math.max(1.5, yBottom - yTop));
    }

    // Buys and sells: small triangles under and over the candle they fall in.
    for (const m of marks) {
      if (m.tick >= n) continue;
      const k = Math.min(count - 1, Math.max(0, Math.ceil(m.tick / size) - 1));
      const px = cx(m.tick === 0 ? 0 : k);
      const py = y(history[m.tick]!);
      ctx.fillStyle = m.kind === "buy" ? "#ffffff" : gold;
      ctx.beginPath();
      if (m.kind === "buy") {
        ctx.moveTo(px, py + 5);
        ctx.lineTo(px - 5, py + 13);
        ctx.lineTo(px + 5, py + 13);
      } else {
        ctx.moveTo(px, py - 5);
        ctx.lineTo(px - 5, py - 13);
        ctx.lineTo(px + 5, py - 13);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Current price: a line across and a tag on the axis.
    if (!rugged && n > 0) {
      const color = last >= 1 ? up : down;
      const py = Math.round(y(last)) + 0.5;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(left + plotW, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillRect(left + plotW + 2, py - 9, axis - 4, 18);
      ctx.fillStyle = "#0a0a12";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillText(`${last >= 100 ? last.toFixed(0) : last >= 10 ? last.toFixed(1) : last.toFixed(2)}x`, left + plotW + 6, py);
    }
  }, [history, marks, rugged, version, compact]);

  return <canvas ref={ref} className={compact ? "chart chart-compact" : "chart"} aria-hidden="true" />;
}
