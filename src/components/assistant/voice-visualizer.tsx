"use client";

import * as React from "react";

import type { Status } from "@/components/assistant/use-voice-chat";

/**
 * The reactive field around the Arcus core — a canvas that makes the surface
 * feel inhabited rather than rendered.
 *
 * It reacts to two live inputs:
 *  - `level`  : REAL audio amplitude. The microphone while you talk, and —
 *               since 0104 routed the reply player through an analyser — the
 *               actual waveform of Arcus's own voice while it talks. The old
 *               version faked the speaking state with a sine envelope, which
 *               pulsed on a timer and visibly ignored the voice; every motion
 *               here now follows the audio it claims to represent.
 *  - `status` : the mood when there is no audio (thinking / idle).
 *
 * Coordinate discipline, learned the hard way: this component began life on
 * the full-screen mobile overlay, where "the window" and "my canvas" are the
 * same rectangle. Inside the Studio panel they are not — the panel is inset
 * by margins — so both the canvas SIZE and the orb's centre are now taken
 * from measured rects and converted into canvas-local space. Sizing follows
 * the canvas's own parent via ResizeObserver, which serves both hosts.
 *
 * Everything runs in one requestAnimationFrame loop reading refs; the
 * animation never depends on React re-renders. It pauses entirely when the
 * document is hidden — painting a hidden tab is pure battery.
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

/** Per-bar eased amplitudes for the radial equalizer. */
const BAR_COUNT = 72;

export function VoiceVisualizer({
  status,
  level,
  targetRef,
}: {
  status: Status;
  level: number;
  /** The orb element — the field is drawn around its live centre. */
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
    // The canvas's own viewport rect — the offset that converts the orb's
    // viewport coordinates into canvas-local ones. Refreshed on resize and
    // cheaply re-read every second in case an ancestor moved without
    // resizing (the workspace panel animates in).
    let originX = 0;
    let originY = 0;

    const measure = () => {
      const host = canvas.parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      // 1.5, not the display's native 2-3: every shape here is a soft glow,
      // where the extra pixels are pure cost with no visible gain.
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      originX = rect.left;
      originY = rect.top;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    measure();

    const host = canvas.parentElement;
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (host && observer) observer.observe(host);
    window.addEventListener("resize", measure);

    // Seed drifting embers. Deliberately few and small — atmosphere, not
    // confetti; the audio-driven geometry is the show.
    const particleCount = reduced ? 0 : 34;
    const particles: Particle[] = [];
    const spawn = (): Particle => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.2,
      vy: -0.1 - Math.random() * 0.3,
      size: 0.6 + Math.random() * 1.6,
      hue: 18 + Math.random() * 26,
      life: 0,
      max: 5 + Math.random() * 7,
    });
    for (let i = 0; i < particleCount; i++) {
      const p = spawn();
      p.life = Math.random() * p.max;
      particles.push(p);
    }

    const ripples: Ripple[] = [];
    const bars = new Float32Array(BAR_COUNT);

    // One pre-rendered ember, stamped per particle. Building a radial
    // gradient per particle per frame was ~2,000 allocations a second —
    // the single biggest line item in this component's old frame cost.
    const SPRITE = 32;
    const sprite = document.createElement("canvas");
    sprite.width = SPRITE;
    sprite.height = SPRITE;
    {
      const sctx = sprite.getContext("2d");
      if (sctx) {
        const g = sctx.createRadialGradient(
          SPRITE / 2,
          SPRITE / 2,
          0,
          SPRITE / 2,
          SPRITE / 2,
          SPRITE / 2,
        );
        g.addColorStop(0, "hsla(26, 100%, 65%, 1)");
        g.addColorStop(1, "hsla(26, 100%, 65%, 0)");
        sctx.fillStyle = g;
        sctx.fillRect(0, 0, SPRITE, SPRITE);
      }
    }

    let frame = 0;

    let smoothed = 0; // eased amplitude 0..1
    let prevAmp = 0; // for onset (syllable) detection
    let t = 0;
    let last = performance.now();
    let originClock = 0;
    let raf = 0;

    // Smooth per-bar variation. Not an FFT, but seeded by the REAL amplitude
    // so the pattern surges and stills with the voice rather than free-running.
    const wobble = (i: number, time: number) =>
      0.5 +
      0.5 * Math.sin(i * 0.9 + time * 2.1) * Math.cos(i * 0.47 - time * 1.6);

    const targetAmp = (s: Status, lvl: number, time: number): number => {
      switch (s) {
        case "listening":
          return Math.min(lvl * 3.6, 1);
        case "speaking":
          // The real waveform, now that the player is metered. The tiny
          // synthetic floor only matters if metering failed — a barely
          // breathing orb beats a dead one, and beats the old full-volume
          // fake by more.
          return Math.max(
            Math.min(lvl * 4.2, 1),
            0.06 + 0.04 * Math.sin(time * 2.2),
          );
        case "thinking":
          return 0.2 + 0.08 * Math.sin(time * 2.6);
        default:
          return 0.09 + 0.05 * Math.sin(time * 1.1);
      }
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) {
        last = now;
        return;
      }
      frame++;
      const s = statusRef.current;
      // Idle earns half the frame rate: nothing on screen moves fast enough
      // to show the difference, and the tab stops costing a full 60fps
      // while nobody is talking.
      if (s === "idle" && frame % 2 === 1) return;

      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      t += dt;

      const target = targetAmp(s, levelRef.current, t);
      // Fast attack, slower release — how sound actually feels. A symmetric
      // ease smears syllables together; this keeps consonants visible.
      smoothed +=
        (target - smoothed) *
        (reduced ? 0.06 : target > smoothed ? 0.38 : 0.12);
      const amp = smoothed;

      // Onset detection: a sharp rise in real amplitude is a syllable — that,
      // not a timer, is when a ring should leave the core.
      const rising = amp - prevAmp;
      prevAmp = amp;

      // Re-measure the origin about once a second: ancestors can move without
      // resizing (panel entrance animation), and a stale origin re-creates
      // the exact offset bug this rewrite removes.
      originClock += dt;
      if (originClock > 1) {
        originClock = 0;
        const hostRect = canvas.parentElement?.getBoundingClientRect();
        if (hostRect) {
          originX = hostRect.left;
          originY = hostRect.top;
        }
      }

      // The orb's centre, in canvas-local space.
      let cx = w / 2;
      let cy = h * 0.4;
      let orbRadius = Math.min(w, h) * 0.12;
      const el = targetRef?.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          cx = r.left + r.width / 2 - originX;
          cy = r.top + r.height / 2 - originY;
          orbRadius = r.width / 2;
        }
      }
      const inner = orbRadius * 1.18;

      // ---- ground -----------------------------------------------------
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#07060b";
      ctx.fillRect(0, 0, w, h);

      const wash = ctx.createRadialGradient(
        cx,
        cy,
        0,
        cx,
        cy,
        Math.max(w, h) * 0.8,
      );
      wash.addColorStop(0, `rgba(249,115,22,${0.07 + amp * 0.12})`);
      wash.addColorStop(0.45, `rgba(120,40,12,${0.04 + amp * 0.04})`);
      wash.addColorStop(1, "rgba(7,6,11,0)");
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);

      // Everything below glows additively.
      ctx.globalCompositeOperation = "lighter";

      // ---- two slow aurora pools (atmosphere, active states only) -----
      const pools = s === "idle" ? [] : [
        { hue: 22, ox: 0.22, oy: 0.28, sp: 0.35, rad: 0.5 },
        { hue: 182, ox: 0.78, oy: 0.74, sp: 0.28, rad: 0.46 },
      ];
      for (const b of pools) {
        const bx = w * b.ox + Math.sin(t * b.sp + b.hue) * w * 0.08;
        const by = h * b.oy + Math.cos(t * b.sp * 0.8 + b.hue) * h * 0.06;
        const br = Math.max(w, h) * b.rad;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `hsla(${b.hue}, 90%, 56%, ${0.05 + amp * 0.05})`);
        g.addColorStop(1, "hsla(0,0%,0%,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      // ---- embers -----------------------------------------------------
      for (const p of particles) {
        p.life += dt;
        p.x += p.vx * (1 + amp * 3);
        p.y += p.vy * (1 + amp * 3);
        if (p.life > p.max || p.y < -20 || p.x < -20 || p.x > w + 20) {
          Object.assign(p, spawn(), { y: h + 10 });
        }
        const fade =
          Math.sin((p.life / p.max) * Math.PI) * (0.25 + amp * 0.35);
        const r = p.size * (1 + amp * 0.6) * 3;
        ctx.globalAlpha = fade;
        ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
      }

      ctx.globalAlpha = 1;

      // ---- core halo --------------------------------------------------
      const halo = ctx.createRadialGradient(
        cx,
        cy,
        orbRadius * 0.4,
        cx,
        cy,
        orbRadius * (2.6 + amp * 1.1),
      );
      halo.addColorStop(0, `rgba(251,146,60,${0.16 + amp * 0.26})`);
      halo.addColorStop(0.45, `rgba(249,115,22,${0.07 + amp * 0.12})`);
      halo.addColorStop(1, "rgba(7,6,11,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, orbRadius * (2.6 + amp * 1.1), 0, Math.PI * 2);
      ctx.fill();

      // ---- radial equalizer -------------------------------------------
      // Each bar eases toward its own target so the crown shimmers rather
      // than flickers; the target is the REAL amplitude shaped by the wobble.
      if (!reduced) {
        const rot = t * 0.18;
        ctx.lineCap = "round";
        for (let i = 0; i < BAR_COUNT; i++) {
          const n = wobble(i, t);
          const goal = amp * (0.3 + 0.7 * n);
          bars[i] += (goal - bars[i]) * 0.3;
          const len = 3 + bars[i] * orbRadius * 1.15;
          const ang = (i / BAR_COUNT) * Math.PI * 2 + rot;
          const x1 = cx + Math.cos(ang) * inner;
          const y1 = cy + Math.sin(ang) * inner;
          const x2 = cx + Math.cos(ang) * (inner + len);
          const y2 = cy + Math.sin(ang) * (inner + len);
          const hue = i % 12 === 0 ? 176 : 20 + 12 * Math.sin(i * 0.3 + t);
          ctx.strokeStyle = `hsla(${hue}, 100%, ${56 + bars[i] * 14}%, ${
            0.22 + bars[i] * 0.55
          })`;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }

      // ---- orbit rings ------------------------------------------------
      // Two thin dashed rings counter-rotating: the instrument-panel feel.
      // Radius breathes gently with the amplitude; opacity follows it too.
      if (!reduced) {
        for (const ring of [
          { r: inner + orbRadius * 0.55, dir: 1, dash: 26 },
          { r: inner + orbRadius * 0.95, dir: -1, dash: 44 },
        ]) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(t * 0.22 * ring.dir);
          ctx.setLineDash([ring.dash, ring.dash * 1.6]);
          ctx.strokeStyle = `hsla(26, 95%, 60%, ${0.1 + amp * 0.2})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(0, 0, ring.r * (1 + amp * 0.05), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        ctx.setLineDash([]);
      }

      // ---- ripples ----------------------------------------------------
      // Born from ONSETS in the real signal — a ring per syllable while
      // Arcus speaks, a ring when your own voice peaks. Never from a timer.
      if (!reduced && rising > 0.055 && amp > 0.3 && ripples.length < 5) {
        ripples.push({
          r: inner,
          alpha: 0.34,
          hue: s === "speaking" ? 28 : 350,
        });
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.r += dt * 140;
        rp.alpha -= dt * 0.3;
        if (rp.alpha <= 0) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = `hsla(${rp.hue}, 95%, 62%, ${rp.alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "source-over";
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
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
