"use client";

import * as React from "react";

import type { RobotState } from "@/lib/agents/office-types";

/**
 * One robot (0130), drawn parametrically so every agent can be tinted and
 * every state is a class flip rather than an image swap. Local coordinates:
 * feet at (0, 0), about 60px tall at scale 1.
 *
 * The visor tells the state at a glance — grey idle, the agent's colour
 * working, amber pulsing when thinking, sweeping when searching, red when
 * blocked, green when done. Shading is plain fills and one shared gradient
 * per robot (no SVG filters), so a dozen robots cost nothing to paint.
 */

export const ROBOT_HEIGHT = 60;

function visorFill(state: RobotState, color: string): string {
  switch (state) {
    case "idle":
    case "walking":
      return "#b9c4d4";
    case "thinking":
      return "#f59e0b";
    case "blocked":
      return "#ef4444";
    case "done":
      return "#10b981";
    default:
      return color;
  }
}

function shade(hex: string, factor: number): string {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const num = parseInt(n, 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `#${((1 << 24) + (ch((num >> 16) & 255) << 16) + (ch((num >> 8) & 255) << 8) + ch(num & 255)).toString(16).slice(1)}`;
}

let gradientSeq = 0;

export const Robot = React.memo(function Robot({
  color,
  state,
  scale = 1,
  facing = 1,
  label,
  muted = false,
}: {
  color: string;
  state: RobotState;
  scale?: number;
  /** 1 faces right, -1 faces left. */
  facing?: 1 | -1;
  label?: string;
  /** Filler robots: no label, greyer. */
  muted?: boolean;
}) {
  // One gradient id per mounted robot so tints never collide across the floor.
  const gid = React.useMemo(() => `robot-${(gradientSeq += 1).toString(36)}`, []);
  const visor = visorFill(state, color);
  const body = muted ? "#9aa5b5" : color;
  const bodyClass =
    state === "walking" ? "robot-walk" : state === "idle" || state === "talking" || state === "done" ? "robot-bob" : undefined;
  const armClass = state === "working" ? "robot-type" : undefined;
  const visorClass = state === "thinking" ? "robot-think" : state === "idle" ? "robot-blink" : undefined;
  const glow = state === "working" || state === "searching" || state === "talking";

  return (
    <g transform={`scale(${scale})`} aria-label={label}>
      <defs>
        <linearGradient id={`${gid}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={shade(body, 1.18)} />
          <stop offset="0.55" stopColor={body} />
          <stop offset="1" stopColor={shade(body, 0.78)} />
        </linearGradient>
        <radialGradient id={`${gid}-shadow`}>
          <stop offset="0" stopColor="#0f172a" stopOpacity="0.22" />
          <stop offset="1" stopColor="#0f172a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${gid}-glow`}>
          <stop offset="0" stopColor={visor} stopOpacity="0.55" />
          <stop offset="1" stopColor={visor} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx={0} cy={3} rx={18} ry={7} fill={`url(#${gid}-shadow)`} />
      <g className={bodyClass} style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}>
        <g transform={`scale(${facing}, 1)`}>
          {/* feet */}
          <rect x={-10} y={-8} width={8} height={8} rx={3} fill="#1e293b" />
          <rect x={2} y={-8} width={8} height={8} rx={3} fill="#1e293b" />
          <rect x={-10} y={-8} width={8} height={3} rx={1.5} fill="#475569" />
          <rect x={2} y={-8} width={8} height={3} rx={1.5} fill="#475569" />
          {/* legs */}
          <rect x={-7.5} y={-13} width={4} height={6} rx={1.5} fill="#64748b" />
          <rect x={3.5} y={-13} width={4} height={6} rx={1.5} fill="#64748b" />
          {/* body */}
          <rect x={-13} y={-34} width={26} height={22} rx={8} fill={`url(#${gid}-body)`} />
          <rect x={-11} y={-32} width={22} height={7} rx={4} fill="rgba(255,255,255,0.22)" />
          {/* chest plate + light */}
          <rect x={-6} y={-27} width={12} height={9} rx={3} fill="rgba(15,23,42,0.18)" />
          <circle cx={0} cy={-22.5} r={2.2} fill={visor} className={state === "working" ? "robot-think" : undefined} />
          {/* arms */}
          <g className={armClass} style={{ transformBox: "fill-box", transformOrigin: "center" }}>
            <rect x={-19.5} y={-31} width={6.5} height={14} rx={3.2} fill={shade(body, 0.9)} />
            <rect x={13} y={-31} width={6.5} height={14} rx={3.2} fill={shade(body, 0.9)} />
            <circle cx={-16.2} cy={-17} r={3} fill="#cbd5e1" />
            <circle cx={16.2} cy={-17} r={3} fill="#cbd5e1" />
          </g>
          {/* neck */}
          <rect x={-3.5} y={-38} width={7} height={5} rx={2} fill="#64748b" />
          {/* head */}
          <rect x={-12} y={-56} width={24} height={19} rx={8} fill={muted ? "#e2e8f0" : "#f8fafc"} stroke="#cbd5e1" strokeWidth={1} />
          <rect x={-10} y={-55} width={20} height={6} rx={3} fill="rgba(255,255,255,0.7)" />
          {/* ear pods */}
          <rect x={-14.5} y={-50} width={3} height={7} rx={1.5} fill="#94a3b8" />
          <rect x={11.5} y={-50} width={3} height={7} rx={1.5} fill="#94a3b8" />
          {/* visor */}
          {glow && <ellipse cx={0} cy={-47} rx={16} ry={9} fill={`url(#${gid}-glow)`} />}
          <g className={visorClass} style={{ transformBox: "fill-box", transformOrigin: "center" }}>
            <rect x={-9} y={-50.5} width={18} height={8} rx={4} fill={visor} />
            <rect x={-7} y={-49.5} width={8} height={2.2} rx={1.1} fill="rgba(255,255,255,0.55)" />
            {state === "searching" && (
              <rect className="robot-scan" x={-4.5} y={-50} width={3.5} height={7} rx={1.7} fill="rgba(255,255,255,0.9)" />
            )}
          </g>
          {/* antenna */}
          <line x1={0} y1={-56} x2={0} y2={-63} stroke="#94a3b8" strokeWidth={1.6} />
          <circle cx={0} cy={-65.5} r={2.8} fill={visor} className={state === "thinking" ? "robot-think" : undefined} />
          {state === "talking" && (
            <g transform="translate(15, -70)">
              <rect x={0} y={0} width={24} height={14} rx={7} fill="#ffffff" stroke="#e2e8f0" />
              <circle cx={7} cy={7} r={1.7} fill="#94a3b8" />
              <circle cx={12} cy={7} r={1.7} fill="#94a3b8" />
              <circle cx={17} cy={7} r={1.7} fill="#94a3b8" />
            </g>
          )}
          {state === "done" && (
            <g transform="translate(13, -72)">
              <circle cx={0} cy={0} r={7} fill="#10b981" />
              <path d="M-3.2 0 L-1 2.4 L3.4 -2.6" stroke="#ffffff" strokeWidth={1.7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          )}
        </g>
      </g>
      {label && !muted && (
        <text x={0} y={17} textAnchor="middle" fontSize={11} fontWeight={700} fill="#334155" style={{ paintOrder: "stroke", stroke: "rgba(255,255,255,0.9)", strokeWidth: 3 }}>
          {label}
        </text>
      )}
    </g>
  );
});
