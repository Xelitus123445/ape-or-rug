import { useEffect, useRef } from "react";

interface Props {
  history: readonly number[];
  marks?: readonly { tick: number; kind: "buy" | "sell" }[];
  rugged: boolean;
  /** Changes every tick so the canvas redraws. */
  version: number;
  compact?: boolean;
}

/** Price line on a canvas. The y range follows the data; a dashed line marks 1.00x. */
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

    const n = history.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of history) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    lo = Math.min(lo, 1) * 0.92;
    hi = Math.max(hi, 1) * 1.08;
    if (rugged) lo = 0;
    const pad = compact ? 2 : 6;
    const span = Math.max(n - 1, compact ? 30 : 60);
    const x = (i: number): number => pad + ((w - pad * 2) * i) / span;
    const y = (v: number): number => h - pad - ((h - pad * 2) * (v - lo)) / (hi - lo);

    const css = getComputedStyle(canvas);
    const up = css.getPropertyValue("--up").trim() || "#3ddc84";
    const down = css.getPropertyValue("--down").trim() || "#ff5c5c";
    const grid = css.getPropertyValue("--line").trim() || "#2a3142";
    const text = css.getPropertyValue("--muted").trim() || "#8b93a7";

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, y(1));
    ctx.lineTo(w - pad, y(1));
    ctx.stroke();
    ctx.setLineDash([]);
    if (!compact) {
      ctx.fillStyle = text;
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText("1.00x", pad + 2, y(1) - 4);
      ctx.fillText(`${hi.toFixed(2)}x`, pad + 2, 12);
    }

    const last = history[n - 1] ?? 1;
    const color = rugged ? down : last >= 1 ? up : down;
    ctx.strokeStyle = color;
    ctx.lineWidth = compact ? 1.5 : 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0) ctx.moveTo(x(i), y(history[i]!));
      else ctx.lineTo(x(i), y(history[i]!));
    }
    ctx.stroke();

    if (!compact) {
      ctx.lineTo(x(n - 1), h - pad);
      ctx.lineTo(x(0), h - pad);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      for (const m of marks) {
        if (m.tick >= n) continue;
        ctx.beginPath();
        ctx.arc(x(m.tick), y(history[m.tick]!), 4, 0, Math.PI * 2);
        ctx.fillStyle = m.kind === "buy" ? up : "#ffd166";
        ctx.fill();
        ctx.strokeStyle = "#0b0e14";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    if (n > 0 && !rugged) {
      ctx.beginPath();
      ctx.arc(x(n - 1), y(last), compact ? 2 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }, [history, marks, rugged, version, compact]);

  return <canvas ref={ref} className={compact ? "chart chart-compact" : "chart"} aria-hidden="true" />;
}
