"use client";

import * as React from "react";

import type { Status } from "@/components/assistant/use-voice-chat";

/**
 * The "living" backdrop for the mobile voice screen — a full-screen canvas that
 * makes it feel like you're talking to something alive.
 *
 * It reacts to two inputs from the voice engine:
 *  - `level`  : real microphone amplitude (RMS) while you're talking.
 *  - `status` : drives the mood when there's no live audio (Arc thinking /
 *               speaking / idle), via a synthetic amplitude envelope.
 *
 * Everything runs in a single requestAnimationFrame loop reading refs, so the
 * animation never depends on React re-renders.
 */

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  hue: number;
  life: number;
  max: number;
};

type Ripple = { r: number; alpha: number; hue: number };

export function VoiceVisualizer({
  status,
  level,
  targetRef,
}: {
  status: Status;
  level: number;
  /** The orb element — the animation is drawn around its live centre. */
  targetRef?: React.RefObject<HTMLElement | null>;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  // Live inputs, mirrored into refs so the rAF loop sees fresh values without
  // re-subscribing every render.
  const levelRef = React.useRef(level);
  const statusRef = React.useRef<Status>(status);
  React.useEffect(() => {
    levelRef.current = level;
    statusRef.current = status;
  }, [level, status]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // Seed particles.
    const particleCount = reduced ? 0 : 46;
    const particles: Particle[] = [];
    const spawn = (): Particle => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -0.15 - Math.random() * 0.4,
      size: 0.8 + Math.random() * 2.4,
      hue: 18 + Math.random() * 28,
      life: 0,
      max: 4 + Math.random() * 6,
    });
    for (let i = 0; i < particleCount; i++) {
      const p = spawn();
      p.life = Math.random() * p.max;
      particles.push(p);
    }

    const ripples: Ripple[] = [];

    let smoothed = 0; // eased amplitude 0..1
    let t = 0;
    let last = performance.now();
    let rippleClock = 0;
    let raf = 0;

    // Smooth, deterministic per-bar variation (no real FFT needed).
    const wobble = (i: number, time: number) =>
      0.5 +
      0.5 *
        Math.sin(i * 0.9 + time * 2.3) *
        Math.cos(i * 0.5 - time * 1.7);

    const targetAmp = (s: Status, lvl: number, time: number): number => {
      switch (s) {
        case "listening":
          return Math.min(lvl * 3.6, 1);
        case "speaking":
          return (
            0.42 +
            0.34 * Math.abs(Math.sin(time * 7.5)) +
            0.14 * Math.sin(time * 12.3)
          );
        case "thinking":
          return 0.26 + 0.1 * Math.sin(time * 3.1);
        default:
          return 0.12 + 0.06 * Math.sin(time * 1.2);
      }
    };

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      t += dt;

      const s = statusRef.current;
      const target = targetAmp(s, levelRef.current, t);
      smoothed += (target - smoothed) * (reduced ? 0.06 : 0.16);
      const amp = smoothed;

      // Read the orb's live position every frame so the ring stays perfectly
      // centred on it regardless of layout shifts, the address bar, etc.
      let cx = w / 2;
      let cy = h * 0.34;
      const el = targetRef?.current;
      if (el) {
        const r = el.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
      }
      const haloBase = Math.min(w, h) * 0.17;

      // ---- base wash --------------------------------------------------
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#07060b";
      ctx.fillRect(0, 0, w, h);

      const wash = ctx.createRadialGradient(
        cx,
        cy,
        0,
        cx,
        cy,
        Math.max(w, h) * 0.85,
      );
      wash.addColorStop(0, `rgba(249,115,22,${0.1 + amp * 0.2})`);
      wash.addColorStop(0.45, `rgba(120,40,12,${0.06 + amp * 0.05})`);
      wash.addColorStop(1, "rgba(7,6,11,0)");
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);

      // Everything below glows additively.
      ctx.globalCompositeOperation = "lighter";

      // ---- drifting aurora blobs -------------------------------------
      const blobs = [
        { hue: 22, ox: 0.26, oy: 0.3, sp: 0.6, rad: 0.5 },
        { hue: 348, ox: 0.74, oy: 0.66, sp: 0.45, rad: 0.55 },
        { hue: 178, ox: 0.5, oy: 0.82, sp: 0.8, rad: 0.42 },
      ];
      for (const b of blobs) {
        const bx =
          w * b.ox + Math.sin(t * b.sp + b.hue) * w * 0.12;
        const by =
          h * b.oy + Math.cos(t * b.sp * 0.8 + b.hue) * h * 0.08;
        const br = Math.max(w, h) * b.rad;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(
          0,
          `hsla(${b.hue}, 95%, 58%, ${0.12 + amp * 0.14})`,
        );
        g.addColorStop(1, "hsla(0,0%,0%,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      // ---- particles --------------------------------------------------
      for (const p of particles) {
        p.life += dt;
        p.x += p.vx * (1 + amp * 4);
        p.y += p.vy * (1 + amp * 4);
        if (
          p.life > p.max ||
          p.y < -20 ||
          p.x < -20 ||
          p.x > w + 20
        ) {
          Object.assign(p, spawn(), { y: h + 10 });
        }
        const fade =
          Math.sin((p.life / p.max) * Math.PI) * (0.5 + amp * 0.5);
        const r = p.size * (1 + amp);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
        g.addColorStop(0, `hsla(${p.hue}, 100%, 65%, ${fade})`);
        g.addColorStop(1, "hsla(0,0%,0%,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- central halo glow -----------------------------------------
      const halo = ctx.createRadialGradient(
        cx,
        cy,
        0,
        cx,
        cy,
        haloBase * (2.4 + amp * 1.2),
      );
      halo.addColorStop(0, `rgba(251,146,60,${0.22 + amp * 0.3})`);
      halo.addColorStop(0.4, `rgba(249,115,22,${0.1 + amp * 0.16})`);
      halo.addColorStop(1, "rgba(7,6,11,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloBase * (2.4 + amp * 1.2), 0, Math.PI * 2);
      ctx.fill();

      // ---- concentric reactive rings ---------------------------------
      ctx.lineWidth = 1.5;
      for (let k = 1; k <= 4; k++) {
        const r = haloBase + k * 16 + amp * 14 * k;
        ctx.strokeStyle = `hsla(${24 + k * 4}, 95%, 60%, ${
          (0.16 / k) * (0.5 + amp)
        })`;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ---- radial equalizer ------------------------------------------
      const bars = reduced ? 0 : 60;
      const inner = haloBase * 1.24;
      const rot = t * 0.25;
      ctx.lineCap = "round";
      for (let i = 0; i < bars; i++) {
        const ang = (i / bars) * Math.PI * 2 + rot;
        const n = wobble(i, t);
        const len = 6 + amp * (haloBase * 0.9) * (0.35 + 0.65 * n);
        const x1 = cx + Math.cos(ang) * inner;
        const y1 = cy + Math.sin(ang) * inner;
        const x2 = cx + Math.cos(ang) * (inner + len);
        const y2 = cy + Math.sin(ang) * (inner + len);
        const hue = i % 11 === 0 ? 176 : 18 + 16 * Math.sin(i * 0.3 + t);
        ctx.strokeStyle = `hsla(${hue}, 100%, ${58 + amp * 12}%, ${
          0.35 + amp * 0.5
        })`;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // ---- ripples (emanate while speaking / on loud peaks) ----------
      if (!reduced) {
        rippleClock += dt;
        const cadence = s === "speaking" ? 0.5 : 1.4;
        const peak = s === "listening" && amp > 0.55;
        if ((s === "speaking" && rippleClock > cadence) || peak) {
          if (ripples.length < 6) {
            ripples.push({
              r: haloBase,
              alpha: 0.4,
              hue: s === "speaking" ? 28 : 350,
            });
          }
          rippleClock = 0;
        }
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.r += dt * 130;
        rp.alpha -= dt * 0.32;
        if (rp.alpha <= 0) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = `hsla(${rp.hue}, 95%, 62%, ${rp.alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [targetRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
