"use client";

/**
 * The interface's voice for the hand — tiny synthesised ticks, no samples.
 *
 * Each cue is an oscillator with a fast envelope, quiet enough to register
 * as texture rather than notification. WebAudio needs a REAL user gesture
 * before it may start; a hand pinch is not one, as far as the browser is
 * concerned. `ensureAudio()` is therefore called from the actual clicks
 * that surround the feature — arming the mode, opening settings — so the
 * context is awake by the time the first gesture wants a sound.
 */

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
}

export function ensureAudio(): void {
  if (typeof window === "undefined") return;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

function blip(
  freq: number,
  ms: number,
  gainPeak: number,
  type: OscillatorType = "sine",
  glideTo?: number,
): void {
  if (!enabled || !ctx || ctx.state !== "running") return;
  try {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + ms / 1000);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(gainPeak, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  } catch {
    /* a denied or torn-down context — silence is fine */
  }
}

let lastHoverAt = 0;

export const handSound = {
  /** New target under the reticle. Throttled — sweeps cross many targets. */
  hover(): void {
    const now = performance.now();
    if (now - lastHoverAt < 90) return;
    lastHoverAt = now;
    blip(1500, 30, 0.025);
  },
  click(): void {
    blip(1150, 45, 0.06);
    blip(1730, 70, 0.045);
  },
  grab(): void {
    blip(340, 80, 0.06, "triangle");
  },
  drop(): void {
    blip(520, 90, 0.05, "triangle", 340);
  },
  /** A pose action landed (crush, palm, thumbs, flick). */
  pose(): void {
    blip(880, 60, 0.05);
    blip(1320, 110, 0.04);
  },
};
