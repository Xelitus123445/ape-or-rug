// Tiny synthesised sound effects. No audio files; silent where Web Audio is
// missing or blocked.

export type Sound = "buy" | "win" | "loss" | "rug" | "graduate" | "event" | "tick" | "go";

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, at: number, freq: number, length: number, type: OscillatorType, volume: number, slideTo?: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

export function play(sound: Sound, muted: boolean): void {
  if (muted) return;
  const ctx = context();
  if (ctx === null) return;
  const t = ctx.currentTime;
  switch (sound) {
    case "buy":
      tone(ctx, t, 520, 0.09, "triangle", 0.12);
      tone(ctx, t + 0.07, 780, 0.12, "triangle", 0.12);
      break;
    case "win":
      [660, 880, 1100, 1320].forEach((f, i) => tone(ctx, t + i * 0.07, f, 0.16, "triangle", 0.13));
      break;
    case "loss":
      tone(ctx, t, 300, 0.22, "sine", 0.1, 180);
      break;
    case "rug":
      tone(ctx, t, 420, 0.45, "sawtooth", 0.12, 55);
      tone(ctx, t + 0.02, 210, 0.45, "square", 0.06, 40);
      break;
    case "graduate":
      [784, 988, 1175, 1568].forEach((f, i) => tone(ctx, t + i * 0.09, f, 0.22, "sine", 0.1));
      break;
    case "event":
      tone(ctx, t, 880, 0.07, "square", 0.05);
      tone(ctx, t + 0.1, 880, 0.07, "square", 0.05);
      break;
    case "tick":
      tone(ctx, t, 440, 0.06, "sine", 0.07);
      break;
    case "go":
      tone(ctx, t, 880, 0.25, "triangle", 0.12);
      break;
  }
}
