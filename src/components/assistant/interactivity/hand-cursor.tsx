"use client";

/**
 * The reticle and its instruments — everything interactivity mode DRAWS.
 *
 * All layers are pointer-events-none, driven by one rAF loop reading a
 * shared mutable `HandVisual` the interaction layer writes into. No React
 * state changes per frame — the same discipline as `voice-visualizer.tsx`.
 *
 * The trick that makes the cursor feel native: detection runs at ~30Hz but
 * the reticle renders at DISPLAY rate. Each rAF frame extrapolates the last
 * sample forward along its velocity (capped, so a stale sample cannot fling
 * the cursor) and eases the displayed position toward that prediction —
 * 120Hz-smooth motion from 30Hz data, with no added perceptible lag.
 *
 *  - the RETICLE: ring + dot moved by `translate3d`; look switches on a
 *    data attribute (idle / hover / pinch / drag / pose), CSS does the rest.
 *  - the DWELL RING: a canvas arc that fills while a pose is held — the
 *    countdown to crush / menu / approve, so a held fist is a visible
 *    decision, not a surprise.
 *  - the LABEL: one word under the reticle naming the recognised gesture.
 *  - the BRACKETS: JARVIS corner marks around the hovered target.
 *  - the SKELETON chip: the 21 landmarks as a wireframe — tracking proof
 *    without ever showing the camera. Toggleable in settings.
 */

import * as React from "react";

import type { Landmark } from "@/components/assistant/interactivity/gesture-engine";

export type HandVisualMode =
  | "idle"
  | "hover"
  | "pinch"
  | "drag"
  | "pose"
  | "scroll";

/** Written by the interaction layer at ~30Hz; read here at display rate. */
export type HandVisual = {
  /** Last engine sample: position, velocity, and when it landed. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  sampleAt: number;
  visible: boolean;
  mode: HandVisualMode;
  /** Viewport rect of the hovered/held target, for the brackets. */
  target: { left: number; top: number; width: number; height: number } | null;
  landmarks: Landmark[] | null;
  /** One-word gesture label under the reticle; empty hides it. */
  label: string;
  /** Pose dwell progress 0..1 — the filling ring. */
  dwell: number;
};

export function createHandVisual(): HandVisual {
  return {
    x: -100,
    y: -100,
    vx: 0,
    vy: 0,
    sampleAt: 0,
    visible: false,
    mode: "idle",
    target: null,
    landmarks: null,
    label: "",
    dwell: 0,
  };
}

/** MediaPipe's hand skeleton, as landmark index pairs. */
const BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const MODE_COLOR: Record<HandVisualMode, string> = {
  idle: "rgba(251,146,60,0.75)",
  hover: "rgba(251,146,60,1)",
  pinch: "rgba(52,211,153,1)",
  drag: "rgba(52,211,153,1)",
  pose: "rgba(96,165,250,1)",
  scroll: "rgba(96,165,250,1)",
};

/** Extrapolation cap: a sample older than this stops predicting (ms). */
const PREDICT_CAP_MS = 90;

/** Skeleton chip geometry: a small box anchored bottom-left. */
const CHIP = { size: 64, margin: 16 };

export function HandCursor({
  visual,
  skeleton = true,
}: {
  visual: HandVisual;
  /** Show the wireframe chip (a settings choice). */
  skeleton?: boolean;
}) {
  const reticleRef = React.useRef<HTMLDivElement | null>(null);
  const labelRef = React.useRef<HTMLSpanElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const reticle = reticleRef.current;
    const labelEl = labelRef.current;
    if (!canvas || !reticle || !labelEl) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    const measure = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
    };
    measure();
    window.addEventListener("resize", measure);

    // The displayed cursor — chases the extrapolated sample.
    let dx = -100;
    let dy = -100;
    let lastLabel = "";
    let last = performance.now();
    let raf = 0;
    let wasClean = false;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) {
        last = now;
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      // --- extrapolate + chase: 30Hz samples, display-rate motion ---
      const age = Math.min(now - visual.sampleAt, PREDICT_CAP_MS) / 1000;
      const px = visual.x + visual.vx * age;
      const py = visual.y + visual.vy * age;
      const chase = 1 - Math.exp(-dt * 26);
      dx += (px - dx) * chase;
      dy += (py - dy) * chase;

      reticle.style.transform = `translate3d(${dx - 18}px, ${dy - 18}px, 0)`;
      reticle.style.opacity = visual.visible ? "1" : "0";
      if (reticle.dataset.mode !== visual.mode) reticle.dataset.mode = visual.mode;
      if (lastLabel !== visual.label) {
        lastLabel = visual.label;
        labelEl.textContent = visual.label;
      }

      // --- canvas: dwell ring + brackets + skeleton ---
      const idle =
        !visual.visible ||
        (!visual.target && !visual.landmarks && visual.dwell === 0);
      if (idle && wasClean) return;
      ctx.clearRect(0, 0, w, h);
      wasClean = idle;
      if (idle) return;

      const color = MODE_COLOR[visual.mode];

      if (visual.dwell > 0 && visual.dwell < 1) {
        // The countdown: a ring that fills clockwise while the pose holds.
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(
          dx,
          dy,
          26,
          -Math.PI / 2,
          -Math.PI / 2 + visual.dwell * Math.PI * 2,
        );
        ctx.stroke();
      }

      if (visual.target) {
        const { left, top, width, height } = visual.target;
        const pad = 5;
        const l = left - pad;
        const t = top - pad;
        const r = left + width + pad;
        const b = top + height + pad;
        const arm = Math.min(14, Math.max(8, Math.min(width, height) * 0.25));
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(l, t + arm); ctx.lineTo(l, t); ctx.lineTo(l + arm, t);
        ctx.moveTo(r - arm, t); ctx.lineTo(r, t); ctx.lineTo(r, t + arm);
        ctx.moveTo(r, b - arm); ctx.lineTo(r, b); ctx.lineTo(r - arm, b);
        ctx.moveTo(l + arm, b); ctx.lineTo(l, b); ctx.lineTo(l, b - arm);
        ctx.stroke();
      }

      if (visual.landmarks && skeleton) {
        const s = CHIP.size;
        const ox = CHIP.margin;
        const oy = h - CHIP.margin - s;
        ctx.strokeStyle = "rgba(251,146,60,0.28)";
        ctx.lineWidth = 1;
        ctx.strokeRect(ox - 6, oy - 6, s + 12, s + 12);
        ctx.strokeStyle = "rgba(251,146,60,0.85)";
        ctx.beginPath();
        for (const [a, b] of BONES) {
          const la = visual.landmarks[a];
          const lb = visual.landmarks[b];
          ctx.moveTo(ox + (1 - la.x) * s, oy + la.y * s);
          ctx.lineTo(ox + (1 - lb.x) * s, oy + lb.y * s);
        }
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [visual, skeleton]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[120]">
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div
        ref={reticleRef}
        data-mode="idle"
        className="hand-reticle absolute left-0 top-0 h-9 w-9"
        style={{ opacity: 0 }}
      >
        <span className="hand-reticle-ring" />
        <span className="hand-reticle-dot" />
        <span ref={labelRef} className="hand-reticle-label" />
      </div>
    </div>
  );
}
