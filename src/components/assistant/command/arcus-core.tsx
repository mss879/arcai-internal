"use client";

/**
 * The core — the reactor at the heart of the HUD.
 *
 * Styled after the arc-reactor instrument in the reference art: concentric
 * segmented rings with tick marks, a luminous centre, a slow mechanical
 * sweep. The segmentation and ticks are `repeating-conic-gradient` rings —
 * pure CSS, rotated on the compositor — so the whole instrument costs no
 * script time at all.
 *
 * This is the ONLY component on the stage that receives `level`, and that is
 * a deliberate architectural line: the meter updates ~60 times a second, and
 * anything holding it re-renders at that rate. The core is a handful of divs
 * with no children — the proven mic-button pattern — while the stage, HUD,
 * rail and dock all sit behind `React.memo` with `level` absent from their
 * props. Since 0104 the meter carries BOTH voices (mic while listening, the
 * metered reply player while speaking), so the reactive ring follows whoever
 * is actually talking.
 */

import * as React from "react";

import type { Status } from "@/components/assistant/use-voice-chat";
import { cn } from "@/lib/utils";

/**
 * How far the reactive ring is allowed to swell. The raw meter is noisy and
 * tops out well below 1, so it is scaled and then clamped — past this the
 * ring collides with the outer ticks and reads as a glitch, not a voice.
 */
const MAX_SWELL = 0.3;

const LABEL: Record<Status, string> = {
  idle: "Tap to speak",
  listening: "Listening",
  thinking: "Working",
  speaking: "Speaking",
};

/** A ring of radial tick marks, drawn with one repeating conic gradient. */
function TickRing({
  inset,
  ticks,
  thickness,
  alpha,
  className,
}: {
  inset: string;
  ticks: number;
  /** Fraction of each segment that is lit, 0..1. */
  thickness: number;
  alpha: number;
  className?: string;
}) {
  const seg = 360 / ticks;
  const lit = seg * thickness;
  return (
    <span
      aria-hidden
      className={cn("absolute rounded-full", className)}
      style={{
        inset,
        background: `repeating-conic-gradient(rgb(251 146 60 / ${alpha}) 0 ${lit}deg, transparent ${lit}deg ${seg}deg)`,
        // Punch out the middle so only a thin annulus remains.
        WebkitMask:
          "radial-gradient(closest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
        mask: "radial-gradient(closest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))",
      }}
    />
  );
}

export function ArcusCore({
  status,
  level,
  onTap,
  size = 148,
  className,
}: {
  status: Status;
  /** Raw audio amplitude, 0–1ish — mic OR the metered reply. */
  level: number;
  onTap: () => void;
  size?: number;
  className?: string;
}) {
  const talking = status === "listening" || status === "speaking";
  const swell = talking ? Math.min(level * 4, 1) * MAX_SWELL : 0;

  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={LABEL[status]}
      className={cn(
        "group relative grid shrink-0 place-items-center rounded-full outline-none transition-transform duration-200",
        "focus-visible:ring-2 focus-visible:ring-primary-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--stage-bg)]",
        "active:scale-95",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* Ambient glow — the reactor's presence in the room. */}
      <span
        aria-hidden
        className={cn(
          "absolute -inset-4 rounded-full blur-xl transition-opacity duration-500",
          status === "idle" ? "opacity-40" : "opacity-75",
        )}
        style={{
          background:
            "radial-gradient(circle, rgb(249 115 22 / 0.5), transparent 66%)",
        }}
      />

      {/* Outer instrument ring: fine ticks, slow sweep. */}
      <TickRing
        inset="0"
        ticks={60}
        thickness={0.28}
        alpha={0.5}
        className="hud-sweep"
      />
      {/* Second ring: coarse segments, counter-rotating. */}
      <TickRing
        inset="9%"
        ticks={12}
        thickness={0.62}
        alpha={0.3}
        className="hud-sweep--reverse"
      />

      {/* Reactive ring — the one element the meter drives. */}
      <span
        aria-hidden
        className="absolute inset-[6%] rounded-full border border-primary-400/50"
        style={{
          transform: `scale(${1 + swell})`,
          opacity: talking ? 0.4 + swell * 1.6 : 0,
          boxShadow: `0 0 ${10 + swell * 60}px rgb(249 115 22 / ${0.25 + swell})`,
          // No transition: the value already arrives smoothed; easing it again
          // would make the ring lag the voice by a visible beat.
        }}
      />

      {/* Thinking: a single orbiting comet on the inner track. */}
      {status === "thinking" && (
        <span
          aria-hidden
          className="arc-core-spin absolute inset-[16%] rounded-full border-2 border-transparent"
          style={{
            borderTopColor: "rgb(249 115 22 / 0.9)",
            borderRightColor: "rgb(249 115 22 / 0.2)",
          }}
        />
      )}

      {/* The luminous heart. Breathes only when idle — once a voice is in the
          room, the reactive ring carries the motion. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-[24%] rounded-full",
          status === "idle" && "arc-core-breathe",
        )}
        style={{
          background:
            "radial-gradient(circle at 36% 32%, rgb(255 245 235 / 0.98), rgb(253 186 116 / 0.95) 30%, rgb(249 115 22 / 0.95) 58%, rgb(124 45 18 / 0.98) 100%)",
          boxShadow:
            "0 0 34px rgb(249 115 22 / 0.55), inset 0 0 18px rgb(255 255 255 / 0.35)",
        }}
      />

      {/* Specular pass — what stops the heart reading as a flat disc. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-[24%] rounded-full opacity-70"
        style={{
          background:
            "radial-gradient(circle at 33% 27%, rgb(255 255 255 / 0.8), transparent 40%)",
        }}
      />
    </button>
  );
}
