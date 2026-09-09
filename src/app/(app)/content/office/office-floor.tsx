"use client";

import * as React from "react";
import { motion } from "motion/react";
import { LocateFixed, RotateCcw, RotateCw } from "lucide-react";

import { useElementWidth } from "@/hooks/use-element-width";
import type { OfficeAgentView, OfficeZoneKey } from "@/lib/agents/office-types";
import { cn } from "@/lib/utils";

import {
  COLS,
  FURNITURE,
  ROWS,
  SLAB,
  SPAWN,
  VIEW_H,
  VIEW_W,
  ZONES,
  buildBlocked,
  deskChair,
  depthOf,
  project,
  projectRel,
  rotateRect,
  seatPoint,
  type Furniture,
  type Point,
  type Rect,
  type Rotation,
  type Tile,
} from "./office-layout";
import { RECEPTIONIST_ID, type RobotView } from "./office-sim";
import { PlayerAvatar, PlayerLabel, usePlayerController } from "./player";
import { ProximityCard } from "./proximity-card";
import { Robot } from "./robot";

/**
 * The floor (0130): one isometric level, viewable from four sides, with a
 * visitor you steer from the entrance. Everything is depth-sorted by the
 * rotated `c + r` so a robot in front of a desk draws in front of it, at any
 * rotation.
 *
 * Realism comes from cheap things: soft shadow ellipses under every object,
 * a warm wash and lamp pools on the floor, windows along the back edges,
 * glass with frames and a highlight, desks with screens that light up while
 * the agent works, rugs with a pattern. No SVG filters anywhere — they are
 * the one thing that makes a scene like this stutter. Furniture pieces are
 * memoised on (rotation, active), so the once-a-second clock tick re-renders
 * robots and bubbles only.
 */

const WALK_MS = 1_300;
const SPRING = { type: "spring", stiffness: 58, damping: 17, mass: 0.9 } as const;
/** Agents draw a touch larger than the 60px base so names read at full width. */
const AGENT_SCALE = 1.12;
const BUBBLE_Y = -100;
const BUBBLE_H = 20;

// ---- Colour helpers -----------------------------------------------------------------

function shade(hex: string, factor: number): string {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const num = parseInt(n, 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `#${((1 << 24) + (ch((num >> 16) & 255) << 16) + (ch((num >> 8) & 255) << 8) + ch(num & 255)).toString(16).slice(1)}`;
}

const pts = (points: Point[]) => points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

function rectCentre(rect: Rect): Tile {
  return { c: rect.c + rect.w / 2, r: rect.r + rect.d / 2 };
}

// ---- Primitives ---------------------------------------------------------------------

/** A soft shadow on the floor under something of this footprint. */
function Shadow({ rect, rot, strength = 1 }: { rect: Rect; rot: Rotation; strength?: number }) {
  const rr = rotateRect(rect, rot);
  const p = projectRel(rr.c + rr.w / 2, rr.r + rr.d / 2);
  const rx = Math.max(20, (rr.w + rr.d) * 19);
  return <ellipse cx={p.x} cy={p.y + 2} rx={rx} ry={rx * 0.5} fill="url(#shadowGrad)" opacity={strength} />;
}

/** An extruded box: `rect` in world tiles, `h` pixels tall, drawn at `rot`. */
function Box({
  rect,
  h,
  fill,
  rot,
  glass = false,
  stroke,
  lift = 0,
  opacity = 1,
  topFill,
}: {
  rect: Rect;
  h: number;
  fill: string;
  rot: Rotation;
  glass?: boolean;
  stroke?: string;
  lift?: number;
  opacity?: number;
  /** Override for the top face (a gradient url, say). */
  topFill?: string;
}) {
  const rr = rotateRect(rect, rot);
  const p00 = projectRel(rr.c, rr.r);
  const p10 = projectRel(rr.c + rr.w, rr.r);
  const p11 = projectRel(rr.c + rr.w, rr.r + rr.d);
  const p01 = projectRel(rr.c, rr.r + rr.d);
  const up = (p: Point): Point => ({ x: p.x, y: p.y - h });
  const left = glass ? "rgba(186,200,224,0.22)" : shade(fill, 0.84);
  const right = glass ? "rgba(160,178,206,0.28)" : shade(fill, 0.72);
  const top = glass ? "rgba(203,213,225,0.5)" : topFill ?? fill;
  const edge = glass ? "rgba(148,163,184,0.6)" : stroke ?? "rgba(15,23,42,0.07)";
  return (
    <g opacity={opacity} transform={lift ? `translate(0 ${-lift})` : undefined}>
      <polygon points={pts([p01, p11, up(p11), up(p01)])} fill={left} stroke={edge} />
      <polygon points={pts([p11, p10, up(p10), up(p11)])} fill={right} stroke={edge} />
      <polygon points={pts([up(p00), up(p10), up(p11), up(p01)])} fill={top} stroke={edge} />
    </g>
  );
}

/** A glass wall: translucent faces, frame posts at the ends, a highlight. */
function GlassWall({ rect, h, rot, variant = "glass" }: { rect: Rect; h: number; rot: Rotation; variant?: "glass" | "window" }) {
  const rr = rotateRect(rect, rot);
  const along = rr.w >= rr.d; // which axis the wall runs along, in the rotated frame
  const a = along ? projectRel(rr.c, rr.r + rr.d / 2) : projectRel(rr.c + rr.w / 2, rr.r);
  const b = along ? projectRel(rr.c + rr.w, rr.r + rr.d / 2) : projectRel(rr.c + rr.w / 2, rr.r + rr.d);
  const up = (p: Point, dy = h): Point => ({ x: p.x, y: p.y - dy });
  const pane = variant === "window" ? "url(#skyGrad)" : "rgba(186,200,224,0.2)";
  const frame = variant === "window" ? "#94a3b8" : "rgba(100,116,139,0.55)";
  const mullions: React.ReactNode[] = [];
  const n = variant === "window" ? Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 70)) : 0;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    mullions.push(<line key={i} x1={p.x} y1={p.y} x2={p.x} y2={p.y - h} stroke={frame} strokeWidth={1.2} />);
  }
  return (
    <g>
      <polygon points={pts([a, b, up(b), up(a)])} fill={pane} stroke={frame} strokeWidth={1} />
      {variant === "glass" && (
        <polygon
          points={pts([
            { x: a.x + (b.x - a.x) * 0.15, y: a.y + (b.y - a.y) * 0.15 },
            { x: a.x + (b.x - a.x) * 0.32, y: a.y + (b.y - a.y) * 0.32 },
            up({ x: a.x + (b.x - a.x) * 0.32, y: a.y + (b.y - a.y) * 0.32 }),
            up({ x: a.x + (b.x - a.x) * 0.15, y: a.y + (b.y - a.y) * 0.15 }),
          ])}
          fill="rgba(255,255,255,0.28)"
        />
      )}
      {mullions}
      <line x1={a.x} y1={a.y - h} x2={b.x} y2={b.y - h} stroke={frame} strokeWidth={2.2} />
      <line x1={a.x} y1={a.y} x2={a.x} y2={a.y - h} stroke={frame} strokeWidth={2.2} />
      <line x1={b.x} y1={b.y} x2={b.x} y2={b.y - h} stroke={frame} strokeWidth={2.2} />
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={frame} strokeWidth={1.4} />
    </g>
  );
}

/** A flat shape on the floor. */
function FloorRect({ rect, rot, fill, stroke, strokeWidth }: { rect: Rect; rot: Rotation; fill: string; stroke?: string; strokeWidth?: number }) {
  const rr = rotateRect(rect, rot);
  return (
    <polygon
      points={pts([projectRel(rr.c, rr.r), projectRel(rr.c + rr.w, rr.r), projectRel(rr.c + rr.w, rr.r + rr.d), projectRel(rr.c, rr.r + rr.d)])}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  );
}

function Plant({ at, rot, size = 1 }: { at: Tile; rot: Rotation; size?: number }) {
  const p = project(at.c, at.r, rot);
  return (
    <g>
      <ellipse cx={p.x} cy={p.y + 2} rx={16 * size} ry={7 * size} fill="url(#shadowGrad)" />
      <Box rect={{ c: at.c - 0.24, r: at.r - 0.24, w: 0.48, d: 0.48 }} h={13} fill="#d6d3d1" rot={rot} />
      <Box rect={{ c: at.c - 0.27, r: at.r - 0.27, w: 0.54, d: 0.54 }} h={4} fill="#c8c2bb" rot={rot} lift={13} />
      <circle cx={p.x - 10 * size} cy={p.y - 22 * size} r={11 * size} fill="#3fb268" />
      <circle cx={p.x + 10 * size} cy={p.y - 24 * size} r={12 * size} fill="#5ecf85" />
      <circle cx={p.x} cy={p.y - 32 * size} r={14 * size} fill="#86efac" />
      <circle cx={p.x - 4 * size} cy={p.y - 36 * size} r={5 * size} fill="rgba(255,255,255,0.35)" />
    </g>
  );
}

function Lamp({ at, rot }: { at: Tile; rot: Rotation }) {
  const p = project(at.c, at.r, rot);
  return (
    <g>
      <ellipse cx={p.x} cy={p.y + 4} rx={70} ry={35} fill="url(#floorPool)" />
      <ellipse cx={p.x} cy={p.y + 1} rx={9} ry={4} fill="#94a3b8" />
      <line x1={p.x} y1={p.y} x2={p.x} y2={p.y - 64} stroke="#94a3b8" strokeWidth={1.8} />
      <circle cx={p.x} cy={p.y - 80} r={48} fill="url(#lampGlow)" />
      <polygon points={pts([{ x: p.x - 11, y: p.y - 64 }, { x: p.x + 11, y: p.y - 64 }, { x: p.x + 7, y: p.y - 88 }, { x: p.x - 7, y: p.y - 88 }])} fill="#fff7ed" stroke="#fdba74" />
      <ellipse cx={p.x} cy={p.y - 64} rx={11} ry={3} fill="#fde68a" opacity={0.7} />
    </g>
  );
}

/** A picture hung on a thin board, always facing the viewer. */
function Panel({ centre, h, variant }: { centre: Point; h: number; variant: "white" | "mood" | "screen" | "easel" }) {
  const x = centre.x;
  const y = centre.y - h + 8;
  if (variant === "easel") {
    return (
      <g>
        <rect x={x - 13} y={y - 12} width={26} height={32} rx={2} fill="#fce7f3" stroke="#f9a8d4" />
        <rect x={x - 8} y={y - 6} width={16} height={12} rx={1} fill="#f9a8d4" opacity={0.7} />
      </g>
    );
  }
  if (variant === "screen") {
    return (
      <g>
        <rect x={x - 36} y={y - 13} width={72} height={42} rx={3} fill="#0f172a" />
        <rect x={x - 33} y={y - 10} width={66} height={36} rx={2} fill="#111c33" />
        {Array.from({ length: 12 }, (_, i) => (
          <rect key={i} x={x - 30 + (i % 4) * 15.5} y={y - 7 + Math.floor(i / 4) * 10} width={12} height={7} rx={1} fill={i % 5 === 0 ? "#f97316" : "#334155"} />
        ))}
        <ellipse cx={x} cy={y + 30} rx={40} ry={8} fill="url(#screenGlow)" />
      </g>
    );
  }
  if (variant === "mood") {
    return (
      <g>
        <rect x={x - 36} y={y - 13} width={72} height={42} rx={3} fill="#ffffff" stroke="#e2e8f0" />
        {["#f97316", "#fdba74", "#0f172a", "#f59e0b", "#ffedd5", "#64748b"].map((col, i) => (
          <rect key={i} x={x - 31 + (i % 3) * 22} y={y - 8 + Math.floor(i / 3) * 17} width={18} height={13} rx={2} fill={col} />
        ))}
      </g>
    );
  }
  return (
    <g>
      <rect x={x - 36} y={y - 13} width={72} height={42} rx={3} fill="#ffffff" stroke="#cbd5e1" />
      {[0, 1, 2].map((i) => (
        <line key={i} x1={x - 28} y1={y - 3 + i * 9} x2={x + (i === 1 ? 22 : 12 + i * 6)} y2={y - 3 + i * 9} stroke={i === 1 ? "#f97316" : "#94a3b8"} strokeWidth={2} strokeLinecap="round" opacity={0.85} />
      ))}
      <rect x={x - 30} y={y + 24} width={60} height={3} rx={1.5} fill="#cbd5e1" />
    </g>
  );
}

// ---- Furniture from data --------------------------------------------------------------

function Desk({ rect, accent, top, rot, active }: { rect: Rect; accent: string; top?: string; rot: Rotation; active: boolean }) {
  const monitor = { c: rect.c + 0.55, r: rect.r + 0.08, w: 0.7, d: 0.08 };
  const screenCentre = project(monitor.c + monitor.w / 2, monitor.r, rot);
  return (
    <g>
      <Shadow rect={rect} rot={rot} />
      <Box rect={rect} h={22} fill={top ?? "#f1f5f9"} rot={rot} topFill={top ? undefined : "url(#deskTop)"} />
      {/* screen */}
      {active && <ellipse cx={screenCentre.x} cy={screenCentre.y - 30} rx={30} ry={16} fill={`${accent}33`} />}
      <Box rect={monitor} h={27} fill="#1e293b" rot={rot} lift={22} />
      <Box rect={{ c: monitor.c + 0.06, r: monitor.r, w: 0.58, d: 0.04 }} h={21} fill={active ? shade(accent, 1.15) : accent} rot={rot} lift={25} opacity={active ? 1 : 0.85} />
      {/* keyboard, papers, mug */}
      <Box rect={{ c: rect.c + 0.6, r: rect.r + 0.5, w: 0.6, d: 0.22 }} h={2.5} fill="#e2e8f0" rot={rot} lift={22} />
      <Box rect={{ c: rect.c + 0.12, r: rect.r + 0.45, w: 0.42, d: 0.3 }} h={1.5} fill="#ffffff" rot={rot} lift={22} />
      <Box rect={{ c: rect.c + 1.45, r: rect.r + 0.5, w: 0.16, d: 0.16 }} h={9} fill={accent} rot={rot} lift={22} />
      {/* chair: seat + back */}
      {(() => {
        const chair = deskChair(rect);
        return (
          <g>
            <Box rect={chair} h={14} fill="#bfc8d6" rot={rot} />
            <Box rect={{ c: chair.c + 0.05, r: chair.r + chair.d - 0.12, w: chair.w - 0.1, d: 0.12 }} h={30} fill="#aab5c6" rot={rot} />
          </g>
        );
      })()}
    </g>
  );
}

function furnitureNode(f: Furniture, rot: Rotation, active: boolean): React.ReactNode {
  switch (f.kind) {
    case "desk":
      return <Desk rect={f.rect} accent={f.accent} top={f.top} rot={rot} active={active} />;
    case "roundTable": {
      const p = project(f.at.c, f.at.r, rot);
      const rx = 45.25 * f.radius;
      const ry = 22.6 * f.radius;
      return (
        <g>
          <ellipse cx={p.x} cy={p.y + 2} rx={rx * 1.05} ry={ry * 1.05} fill="url(#shadowGrad)" />
          <ellipse cx={p.x} cy={p.y - 4} rx={rx * 0.97} ry={ry * 0.97} fill="#cbd5e1" />
          <rect x={p.x - 6} y={p.y - 26} width={12} height={22} fill="#94a3b8" />
          <ellipse cx={p.x} cy={p.y - 26} rx={rx} ry={ry} fill="url(#deskTop)" stroke="rgba(15,23,42,0.08)" />
          <circle cx={p.x} cy={p.y - 36} r={7} fill="#86efac" />
          <circle cx={p.x - 5} cy={p.y - 33} r={5} fill="#4ade80" />
        </g>
      );
    }
    case "table":
      return (
        <g>
          <Shadow rect={f.rect} rot={rot} />
          <Box rect={f.rect} h={22} fill="#f8fafc" rot={rot} topFill="url(#deskTop)" />
          <Box rect={{ c: f.rect.c + 0.35, r: f.rect.r + 0.3, w: 0.4, d: 0.28 }} h={2} fill="#e2e8f0" rot={rot} lift={22} />
          <Box rect={{ c: f.rect.c + f.rect.w - 0.8, r: f.rect.r + f.rect.d - 0.6, w: 0.4, d: 0.28 }} h={2} fill="#e2e8f0" rot={rot} lift={22} />
        </g>
      );
    case "shelf":
      return (
        <g>
          <Shadow rect={f.rect} rot={rot} strength={0.8} />
          <Box rect={f.rect} h={40} fill="#e2e8f0" rot={rot} />
          {["#f97316", "#0ea5e9", "#8b5cf6", "#10b981"].map((col, i) => (
            <Box key={i} rect={{ c: f.rect.c + 0.1 + i * 0.27, r: f.rect.r + 0.1, w: 0.2, d: 0.3 }} h={15} fill={col} rot={rot} lift={40} />
          ))}
          <Box rect={{ c: f.rect.c - 0.03, r: f.rect.r - 0.03, w: f.rect.w + 0.06, d: f.rect.d + 0.06 }} h={2} fill="#cbd5e1" rot={rot} lift={56} />
        </g>
      );
    case "board": {
      const centre = rectCentre(f.rect);
      return (
        <g>
          <Box rect={f.rect} h={f.h} fill={f.variant === "screen" ? "#1e293b" : "#ffffff"} rot={rot} stroke="#cbd5e1" />
          <Panel centre={project(centre.c, centre.r, rot)} h={f.h} variant={f.variant} />
        </g>
      );
    }
    case "wall":
      if (f.variant === "post") {
        return (
          <g>
            <Box rect={f.rect} h={f.h} fill="#475569" rot={rot} />
            <Box rect={{ c: f.rect.c - 0.03, r: f.rect.r - 0.03, w: f.rect.w + 0.06, d: f.rect.d + 0.06 }} h={4} fill="#f59e0b" rot={rot} lift={f.h} />
          </g>
        );
      }
      return <GlassWall rect={f.rect} h={f.h} rot={rot} variant={f.variant === "window" ? "window" : "glass"} />;
    case "rug":
      return <FloorRect rect={f.rect} rot={rot} fill={f.pattern === "dots" ? "url(#rugDots)" : "url(#rugStripes)"} stroke="rgba(148,163,184,0.35)" strokeWidth={1.5} />;
    case "plant":
      return <Plant at={f.at} rot={rot} size={f.size} />;
    case "lamp":
      return <Lamp at={f.at} rot={rot} />;
    case "sofa":
      return (
        <g>
          <Shadow rect={f.rect} rot={rot} />
          <Box rect={f.rect} h={16} fill="#fdba74" rot={rot} />
          <Box rect={{ c: f.rect.c + 0.08, r: f.rect.r + 0.25, w: f.rect.w / 2 - 0.12, d: f.rect.d - 0.35 }} h={5} fill="#fed7aa" rot={rot} lift={16} />
          <Box rect={{ c: f.rect.c + f.rect.w / 2 + 0.04, r: f.rect.r + 0.25, w: f.rect.w / 2 - 0.12, d: f.rect.d - 0.35 }} h={5} fill="#fed7aa" rot={rot} lift={16} />
          <Box rect={{ c: f.rect.c, r: f.rect.r, w: f.rect.w, d: 0.25 }} h={32} fill="#fb923c" rot={rot} />
          <Box rect={{ c: f.rect.c, r: f.rect.r, w: 0.18, d: f.rect.d }} h={24} fill="#fb923c" rot={rot} />
          <Box rect={{ c: f.rect.c + f.rect.w - 0.18, r: f.rect.r, w: 0.18, d: f.rect.d }} h={24} fill="#fb923c" rot={rot} />
        </g>
      );
    case "coffee":
      return (
        <g>
          <Shadow rect={f.rect} rot={rot} strength={0.7} />
          <Box rect={f.rect} h={34} fill="#334155" rot={rot} />
          <Box rect={{ c: f.rect.c + 0.12, r: f.rect.r + 0.12, w: 0.36, d: 0.36 }} h={4} fill="#f97316" rot={rot} lift={34} />
          <Box rect={{ c: f.rect.c + 0.2, r: f.rect.r + f.rect.d - 0.05, w: 0.18, d: 0.18 }} h={7} fill="#f8fafc" rot={rot} lift={14} />
        </g>
      );
    case "counter": {
      const centre = project(f.rect.c + f.rect.w / 2, f.rect.r + f.rect.d / 2, rot);
      return (
        <g>
          <Shadow rect={f.rect} rot={rot} />
          <Box rect={f.rect} h={28} fill="#ffffff" rot={rot} stroke="#e2e8f0" topFill="url(#deskTop)" />
          <Box rect={{ c: f.rect.c + f.rect.w - 0.75, r: f.rect.r + 0.12, w: 0.45, d: 0.06 }} h={18} fill="#1e293b" rot={rot} lift={28} />
          <Box rect={{ c: f.rect.c + 0.25, r: f.rect.r + 0.15, w: 0.3, d: 0.3 }} h={10} fill="#d6d3d1" rot={rot} lift={28} />
          <circle cx={project(f.rect.c + 0.4, f.rect.r + 0.3, rot).x} cy={project(f.rect.c + 0.4, f.rect.r + 0.3, rot).y - 46} r={8} fill="#86efac" />
          <rect x={centre.x - 24} y={centre.y - 16} width={48} height={12} rx={6} fill="#f97316" />
          <text x={centre.x} y={centre.y - 7.5} fontSize={7.5} fontWeight={800} fill="#ffffff" textAnchor="middle" letterSpacing={1.2}>
            ARC AI
          </text>
        </g>
      );
    }
    case "printer":
      return (
        <g>
          <Shadow rect={f.rect} rot={rot} strength={0.7} />
          <Box rect={f.rect} h={20} fill="#e2e8f0" rot={rot} />
          <Box rect={{ c: f.rect.c + 0.15, r: f.rect.r + f.rect.d - 0.15, w: f.rect.w - 0.3, d: 0.3 }} h={1.5} fill="#ffffff" rot={rot} lift={10} />
        </g>
      );
    case "chair":
      return (
        <g>
          <Box rect={f.rect} h={14} fill="#bfc8d6" rot={rot} />
          <Box rect={{ c: f.rect.c + 0.05, r: f.rect.r, w: f.rect.w - 0.1, d: 0.1 }} h={28} fill="#aab5c6" rot={rot} />
        </g>
      );
    case "mat":
      return <FloorRect rect={f.rect} rot={rot} fill="#e2e8f0" stroke="#cbd5e1" />;
  }
}

function furnitureAnchor(f: Furniture): Tile {
  if (f.kind === "plant" || f.kind === "lamp" || f.kind === "roundTable") return f.at;
  return rectCentre(f.rect);
}

/** Memoised: a piece only re-renders when the view turns or its desk lights up. */
const FurniturePiece = React.memo(function FurniturePiece({ f, rot, active }: { f: Furniture; rot: Rotation; active: boolean }) {
  return <>{furnitureNode(f, rot, active)}</>;
});

/** Which desk lights up when which agent works. */
const DESK_FOR_SEAT: Partial<Record<OfficeZoneKey, string[]>> = {
  library: ["library-desk"],
  managerOffice: ["office-desk"],
  writingDesk: ["writing-desk"],
  designStudio: ["design-desk"],
  brandCorner: ["brand-desk"],
  qaDesk: ["qa-desk"],
  dispatchDesk: ["dispatch-desk"],
  opsStudio: ["ops-desk-a", "ops-desk-b"],
};

// ---- Floor slab, tints, decals ---------------------------------------------------------

const Slab = React.memo(function Slab({ rot, caption }: { rot: Rotation; caption: string }) {
  const rr = rotateRect({ c: 0, r: 0, w: COLS, d: ROWS }, rot);
  const top = projectRel(rr.c, rr.r);
  const right = projectRel(rr.c + rr.w, rr.r);
  const bottom = projectRel(rr.c + rr.w, rr.r + rr.d);
  const left = projectRel(rr.c, rr.r + rr.d);
  const down = (p: Point): Point => ({ x: p.x, y: p.y + SLAB });
  const lines: React.ReactNode[] = [];
  for (let c = 1; c < rr.w; c++) {
    lines.push(<line key={`c${c}`} {...lineProps(projectRel(rr.c + c, rr.r), projectRel(rr.c + c, rr.r + rr.d))} />);
  }
  for (let r = 1; r < rr.d; r++) {
    lines.push(<line key={`r${r}`} {...lineProps(projectRel(rr.c, rr.r + r), projectRel(rr.c + rr.w, rr.r + r))} />);
  }
  const leftMid = { x: (left.x + bottom.x) / 2, y: (left.y + bottom.y) / 2 };
  const rightMid = { x: (right.x + bottom.x) / 2, y: (right.y + bottom.y) / 2 };
  return (
    <g>
      <polygon points={pts([down(left), down(bottom), down(right), right, bottom, left])} fill="rgba(15,23,42,0.1)" transform="translate(0, 14)" />
      <polygon points={pts([left, bottom, down(bottom), down(left)])} fill="#d7deea" />
      <polygon points={pts([bottom, right, down(right), down(bottom)])} fill="#c7d0df" />
      <polygon points={pts([top, right, bottom, left])} fill="url(#floorGrad)" stroke="#dfe5ee" />
      {lines}
      {/* Skylight: one soft band of daylight across the floor. */}
      <FloorRect rect={{ c: 9.5, r: -0.2, w: 5.5, d: ROWS + 0.4 }} rot={rot} fill="rgba(255,255,255,0.28)" />
      <text transform={`translate(${leftMid.x - 4}, ${leftMid.y + 16}) rotate(26.57)`} fontSize={12} fontStyle="italic" fontWeight={600} fill="#64748b" textAnchor="middle">
        Content Office
      </text>
      <text transform={`translate(${rightMid.x + 4}, ${rightMid.y + 16}) rotate(-26.57)`} fontSize={11} fontStyle="italic" fill="#64748b" textAnchor="middle">
        {caption}
      </text>
    </g>
  );
});

function lineProps(a: Point, b: Point) {
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#e6eaf1", strokeWidth: 1 };
}

const ZoneTints = React.memo(function ZoneTints({ rot, colours }: { rot: Rotation; colours: Map<OfficeZoneKey, string> }) {
  return (
    <g>
      <FloorRect rect={{ c: 0, r: 16.2, w: COLS, d: ROWS - 16.2 }} rot={rot} fill="rgba(255, 237, 213, 0.45)" />
      {(Object.keys(ZONES) as OfficeZoneKey[])
        .filter((k) => k !== "corridor" && k !== "reception" && k !== "breakout")
        .map((k) => (
          <FloorRect key={k} rect={ZONES[k].rect} rot={rot} fill={`${colours.get(k) ?? "#94a3b8"}12`} />
        ))}
    </g>
  );
});

const Decals = React.memo(function Decals({ rot }: { rot: Rotation }) {
  return (
    <g>
      {(Object.keys(ZONES) as OfficeZoneKey[])
        .filter((k) => k !== "corridor")
        .map((k) => {
          const z = ZONES[k];
          const p = project(z.decal.c, z.decal.r, rot);
          return (
            <text key={k} transform={`translate(${p.x} ${p.y}) rotate(26.57)`} fontSize={11} fontWeight={700} fill="#94a3b8" letterSpacing={1.6} opacity={0.6}>
              {z.label.toUpperCase()}
            </text>
          );
        })}
      {(() => {
        const p = project(SPAWN.c, ROWS - 0.15, rot);
        return (
          <text transform={`translate(${p.x} ${p.y}) rotate(26.57)`} fontSize={9} fontWeight={700} fill="#f97316" letterSpacing={1.4} textAnchor="middle">
            ENTRANCE
          </text>
        );
      })()}
    </g>
  );
});

// ---- Signs and bubbles -------------------------------------------------------------------

type Box2 = { x: number; y: number; w: number; h: number };
type Bubble = { id: string; x: number; y: number; w: number; text: string };

const overlaps = (a: Box2, b: Box2) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 6 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 4;

/** Lay bubbles out so none overlaps another bubble or a sign: sort by y, push up until clear. */
function layoutBubbles(items: Bubble[], obstacles: Box2[]): Bubble[] {
  const placed: Box2[] = [...obstacles];
  const out: Bubble[] = [];
  for (const b of [...items].sort((a, b2) => a.y - b2.y)) {
    let y = b.y;
    for (let guard = 0; guard < 10; guard++) {
      const hit = placed.find((p) => overlaps(p, { x: b.x, y, w: b.w, h: BUBBLE_H }));
      if (!hit) break;
      y = hit.y - hit.h / 2 - BUBBLE_H / 2 - 6;
    }
    placed.push({ x: b.x, y, w: b.w, h: BUBBLE_H });
    out.push({ ...b, y });
  }
  return out;
}

type Sign = { key: string; x: number; y: number; w: number; text: string; color: string };

/**
 * One floating sign per room, above its back wall at the current rotation,
 * naming the room and who sits there. Drawn in the top layer so a desk or a
 * robot never hides what a room is for.
 */
function roomSigns(rot: Rotation, agents: readonly OfficeAgentView[]): Sign[] {
  const byZone = new Map<OfficeZoneKey, OfficeAgentView[]>();
  for (const a of agents) byZone.set(a.zone, [...(byZone.get(a.zone) ?? []), a]);
  return (Object.keys(ZONES) as OfficeZoneKey[])
    .filter((k) => k !== "corridor")
    .map((k) => {
      const z = ZONES[k];
      const corners: Tile[] = [
        { c: z.rect.c, r: z.rect.r },
        { c: z.rect.c + z.rect.w, r: z.rect.r },
        { c: z.rect.c, r: z.rect.r + z.rect.d },
        { c: z.rect.c + z.rect.w, r: z.rect.r + z.rect.d },
      ].sort((a, b) => depthOf(a.c, a.r, rot) - depthOf(b.c, b.r, rot));
      const mid = { c: (corners[0].c + corners[1].c) / 2, r: (corners[0].r + corners[1].r) / 2 };
      const p = project(mid.c, mid.r, rot);
      const here = byZone.get(k) ?? [];
      const who = k === "reception" ? "Dot" : here.map((a) => a.name).join(" & ") || null;
      const text = who ? `${z.label} · ${who}` : z.label;
      return { key: k, x: p.x, y: p.y - 104, w: text.length * 6.4 + 28, text, color: here[0]?.color ?? (k === "reception" ? "#f97316" : "#94a3b8") };
    });
}

// ---- The floor ------------------------------------------------------------------------

type Motion = { c: number; r: number; movedAt: number; facing: 1 | -1 };
type Placed = RobotView & { x: number; y: number; depth: number; facing: 1 | -1; world: Tile };

export function OfficeFloor({
  robots,
  agents,
  nowMs,
  rotation,
  onRotate,
  playerName,
  enabled,
  selectedId,
  nearId,
  onNearChange,
  onRobotClick,
  onDetails,
  onOpenMission,
  workingCount,
}: {
  robots: RobotView[];
  agents: OfficeAgentView[];
  nowMs: number;
  rotation: Rotation;
  onRotate: (dir: 1 | -1) => void;
  playerName: string;
  /** False when another tab is showing: keys and the loop stop. */
  enabled: boolean;
  selectedId: string | null;
  nearId: string | null;
  onNearChange: (id: string | null) => void;
  onRobotClick: (robot: RobotView) => void;
  onDetails: (robot: RobotView) => void;
  onOpenMission: (missionId: string) => void;
  workingCount: number;
}) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const scale = width ? width / VIEW_W : 0;
  const height = width ? (width * VIEW_H) / VIEW_W : 0;
  const blocked = React.useMemo(() => buildBlocked(), []);
  const colours = React.useMemo(() => new Map<OfficeZoneKey, string>(agents.map((a) => [a.zone, a.color])), [agents]);
  const [playerTile, setPlayerTile] = React.useState<Tile>(SPAWN);
  const [hasMoved, setHasMoved] = React.useState(false);

  // Robots' world seats, for the player's proximity check. Refs are written
  // after render (an effect), never during it.
  const targetsRef = React.useRef<{ id: string; c: number; r: number }[]>([]);
  const robotsRef = React.useRef(robots);
  const nearRef = React.useRef(nearId);
  React.useEffect(() => {
    targetsRef.current = robots
      .filter((r) => r.kind === "agent" || r.id === RECEPTIONIST_ID)
      .map((r) => {
        const s = seatPoint(r.zone, r.seat);
        return { id: r.id, c: s.c, r: s.r };
      });
    robotsRef.current = robots;
    nearRef.current = nearId;
  }, [robots, nearId]);

  const { gRef, faceRef, animRef, setPad, reset } = usePlayerController({
    enabled,
    rotation,
    blocked,
    targets: targetsRef,
    onDepthChange: setPlayerTile,
    onNear: onNearChange,
    onFirstMove: () => setHasMoved(true),
    onRotate,
    onInteract: () => {
      const robot = robotsRef.current.find((r) => r.id === nearRef.current);
      if (robot && robot.kind === "agent") onDetails(robot);
    },
  });

  // Where each robot was last seen, so a move shows as a walk and sets facing.
  const [motionMap, setMotionMap] = React.useState<{ sig: string; map: Map<string, Motion> }>({ sig: "", map: new Map() });
  const sig = robots.map((r) => `${r.id}@${r.zone}#${r.seat}`).join("|");
  if (sig !== motionMap.sig) {
    const map = new Map(motionMap.map);
    for (const r of robots) {
      const s = seatPoint(r.zone, r.seat);
      const prev = map.get(r.id);
      if (!prev) map.set(r.id, { c: s.c, r: s.r, movedAt: 0, facing: 1 });
      else if (Math.abs(prev.c - s.c) > 0.01 || Math.abs(prev.r - s.r) > 0.01) {
        const from = project(prev.c, prev.r, rotation);
        const to = project(s.c, s.r, rotation);
        map.set(r.id, { c: s.c, r: s.r, movedAt: nowMs, facing: to.x < from.x ? -1 : 1 });
      }
    }
    setMotionMap({ sig, map });
  }

  const placed: Placed[] = robots.map((r) => {
    const s = seatPoint(r.zone, r.seat);
    const p = project(s.c, s.r, rotation);
    const m = motionMap.map.get(r.id);
    const walking = Boolean(m && m.movedAt > 0 && nowMs - m.movedAt < WALK_MS);
    return { ...r, state: walking ? "walking" : r.state, x: p.x, y: p.y, depth: depthOf(s.c, s.r, rotation) + 0.4, facing: m?.facing ?? 1, world: s };
  });

  // Desks light up while their agent works at them.
  const activeDesks = new Set<string>();
  for (const r of placed) {
    if (r.kind !== "agent" || !r.agentKey) continue;
    if (!["working", "thinking", "searching"].includes(r.state)) continue;
    const agent = agents.find((a) => a.key === r.agentKey);
    if (!agent || agent.zone !== r.zone) continue;
    const keys = DESK_FOR_SEAT[r.zone];
    const key = keys?.[Math.min(r.seat, (keys?.length ?? 1) - 1)];
    if (key) activeDesks.add(key);
  }

  const playerPoint = project(playerTile.c, playerTile.r, rotation);
  const rugs = FURNITURE.filter((f) => f.kind === "rug");
  const drawables: { key: string; depth: number; node: React.ReactNode }[] = [
    ...FURNITURE.filter((f) => f.kind !== "rug").map((f) => {
      const a = furnitureAnchor(f);
      return { key: f.key, depth: depthOf(a.c, a.r, rotation), node: <FurniturePiece key={f.key} f={f} rot={rotation} active={activeDesks.has(f.key)} /> };
    }),
    ...placed.map((r) => ({
      key: r.id,
      depth: r.depth,
      node: (
        <RobotOnFloor key={r.id} robot={r} selected={selectedId === r.id || nearId === r.id} onClick={onRobotClick} greeting={r.id === RECEPTIONIST_ID && nearId === RECEPTIONIST_ID} />
      ),
    })),
    {
      key: "player",
      depth: depthOf(playerTile.c, playerTile.r, rotation) + 0.4,
      node: (
        <g key="player" ref={gRef} transform={`translate(${playerPoint.x.toFixed(1)} ${playerPoint.y.toFixed(1)})`}>
          <ellipse cx={0} cy={2} rx={15} ry={6} fill="url(#shadowGrad)" />
          <g ref={faceRef}>
            <g ref={animRef} className="robot-bob" style={{ transformBox: "fill-box", transformOrigin: "center bottom" }}>
              <PlayerAvatar />
            </g>
          </g>
          <PlayerLabel name={playerName} />
        </g>
      ),
    },
  ].sort((a, b) => a.depth - b.depth);

  const signs = roomSigns(rotation, agents);
  const bubbles = layoutBubbles(
    placed
      .filter((r) => r.kind === "agent" && r.id !== nearId && !["idle", "walking"].includes(r.state) && r.label)
      .map((r) => {
        const text = r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label;
        return { id: r.id, x: r.x, y: r.y + BUBBLE_Y, w: Math.max(40, text.length * 6 + 18), text };
      }),
    signs.map((sg) => ({ x: sg.x, y: sg.y, w: sg.w, h: 22 })),
  );

  const nearRobot = nearId ? placed.find((r) => r.id === nearId && r.kind === "agent") ?? null : null;
  const nearAgent = nearRobot?.agentKey ? agents.find((a) => a.key === nearRobot.agentKey) ?? null : null;

  return (
    <div ref={wrapRef} className="relative">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="block h-auto w-full select-none" role="img" aria-label="The content office floor">
        <defs>
          <linearGradient id="floorGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fbfcfe" />
            <stop offset="1" stopColor="#edf0f6" />
          </linearGradient>
          <linearGradient id="deskTop" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fbf8f3" />
            <stop offset="1" stopColor="#efe8dd" />
          </linearGradient>
          <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#dbeafe" stopOpacity="0.9" />
            <stop offset="1" stopColor="#f8fafc" stopOpacity="0.85" />
          </linearGradient>
          <radialGradient id="lampGlow">
            <stop offset="0" stopColor="#fdba74" stopOpacity="0.5" />
            <stop offset="1" stopColor="#fdba74" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="floorPool">
            <stop offset="0" stopColor="#fed7aa" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fed7aa" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="shadowGrad">
            <stop offset="0" stopColor="#0f172a" stopOpacity="0.2" />
            <stop offset="1" stopColor="#0f172a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="screenGlow">
            <stop offset="0" stopColor="#f97316" stopOpacity="0.28" />
            <stop offset="1" stopColor="#f97316" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="roomWash">
            <stop offset="0" stopColor="#fff7ed" stopOpacity="0.9" />
            <stop offset="1" stopColor="#fff7ed" stopOpacity="0" />
          </radialGradient>
          <pattern id="rugDots" width="10" height="10" patternUnits="userSpaceOnUse">
            <rect width="10" height="10" fill="rgba(148,163,184,0.16)" />
            <circle cx="5" cy="5" r="1.2" fill="rgba(100,116,139,0.35)" />
          </pattern>
          <pattern id="rugStripes" width="9" height="9" patternUnits="userSpaceOnUse">
            <rect width="9" height="9" fill="rgba(253,186,116,0.22)" />
            <line x1="0" y1="9" x2="9" y2="0" stroke="rgba(249,115,22,0.35)" strokeWidth="1.2" />
          </pattern>
        </defs>
        <ellipse cx={VIEW_W * 0.5} cy={VIEW_H * 0.42} rx={720} ry={320} fill="url(#roomWash)" />
        <Slab rot={rotation} caption={`${workingCount} of ${robots.filter((r) => r.kind === "agent").length} agents working`} />
        <ZoneTints rot={rotation} colours={colours} />
        {rugs.map((f) => (
          <FurniturePiece key={f.key} f={f} rot={rotation} active={false} />
        ))}
        <Decals rot={rotation} />
        {drawables.map((d) => (
          <React.Fragment key={d.key}>{d.node}</React.Fragment>
        ))}
        {/* Signs over each room's back wall, then bubbles pushed clear of them — both
            in the top layer so what a room is, and what a robot is doing, always reads. */}
        {signs.map((sg) => (
          <g key={sg.key} transform={`translate(${sg.x.toFixed(1)} ${sg.y.toFixed(1)})`}>
            <rect x={-sg.w / 2} y={-11} width={sg.w} height={22} rx={11} fill="rgba(255,255,255,0.94)" stroke="#e2e8f0" />
            <circle cx={-sg.w / 2 + 12} cy={0} r={3.5} fill={sg.color} />
            <text x={6} y={4} textAnchor="middle" fontSize={11} fontWeight={600} fill="#334155">
              {sg.text}
            </text>
          </g>
        ))}
        {bubbles.map((b) => (
          <g key={b.id} transform={`translate(${b.x.toFixed(1)} ${b.y.toFixed(1)})`}>
            <rect x={-b.w / 2} y={-14} width={b.w} height={BUBBLE_H} rx={10} fill="#0f172a" opacity={0.88} />
            <polygon points="-4,6 4,6 0,11" fill="#0f172a" opacity={0.88} />
            <text x={0} y={0} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#ffffff">
              {b.text}
            </text>
          </g>
        ))}
      </svg>

      {scale > 0 && (
        <ProximityCard
          robot={nearRobot}
          agent={nearAgent}
          point={nearRobot ? { x: nearRobot.x, y: nearRobot.y } : null}
          scale={scale}
          bounds={{ width, height }}
          nowMs={nowMs}
          onDetails={() => nearRobot && onDetails(nearRobot)}
          onOpenMission={onOpenMission}
        />
      )}

      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 font-medium text-slate-700 ring-1 ring-slate-200">
            <span className={cn("h-2 w-2 rounded-full", workingCount ? "bg-emerald-500 animate-pulse" : "bg-slate-300")} />
            {workingCount ? `${workingCount} working` : "All quiet"}
          </span>
        </div>
        <div className="pointer-events-auto flex items-center gap-1">
          <IconButton label="Rotate left (Q)" onClick={() => onRotate(-1)}>
            <RotateCcw className="h-4 w-4" />
          </IconButton>
          <IconButton label="Rotate right (E)" onClick={() => onRotate(1)}>
            <RotateCw className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="Back to the entrance"
            onClick={() => {
              reset();
              setPlayerTile(SPAWN);
              onNearChange(null);
            }}
          >
            <LocateFixed className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      {!hasMoved && enabled && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
          <div className="rounded-full bg-slate-900/90 px-4 py-2 text-xs font-medium text-white shadow-lg">
            You&apos;re at the entrance. Walk with <kbd className="rounded bg-white/15 px-1">↑↓←→</kbd> or <kbd className="rounded bg-white/15 px-1">WASD</kbd> · rotate with <kbd className="rounded bg-white/15 px-1">Q</kbd>/<kbd className="rounded bg-white/15 px-1">E</kbd> · walk up to a robot to see its work
          </div>
        </div>
      )}

      <DPad onPad={setPad} />
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-8 w-8 place-items-center rounded-full bg-white/90 text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-white hover:text-slate-900"
    >
      {children}
    </button>
  );
}

/** Hold-to-walk pad for touch screens (and mice). */
function DPad({ onPad }: { onPad: (dx: number, dy: number) => void }) {
  const hold = (dx: number, dy: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      onPad(dx, dy);
    },
    onPointerUp: () => onPad(0, 0),
    onPointerCancel: () => onPad(0, 0),
    onPointerLeave: () => onPad(0, 0),
  });
  const cls = "grid h-9 w-9 place-items-center rounded-lg bg-white/90 text-slate-700 ring-1 ring-slate-200 active:bg-primary-50 active:text-primary-700 select-none touch-none";
  return (
    <div className="absolute bottom-3 right-3 grid grid-cols-3 gap-1 opacity-80 hover:opacity-100" aria-label="Walk">
      <span />
      <button type="button" className={cls} aria-label="Walk up" {...hold(0, -1)}>
        ↑
      </button>
      <span />
      <button type="button" className={cls} aria-label="Walk left" {...hold(-1, 0)}>
        ←
      </button>
      <button type="button" className={cls} aria-label="Walk down" {...hold(0, 1)}>
        ↓
      </button>
      <button type="button" className={cls} aria-label="Walk right" {...hold(1, 0)}>
        →
      </button>
    </div>
  );
}

function RobotOnFloor({
  robot,
  selected,
  greeting,
  onClick,
}: {
  robot: Placed;
  selected: boolean;
  greeting: boolean;
  onClick: (robot: RobotView) => void;
}) {
  const clickable = robot.kind === "agent";
  return (
    <motion.g
      initial={false}
      animate={{ x: robot.x, y: robot.y }}
      transition={SPRING}
      style={{ cursor: clickable ? "pointer" : "default" }}
      onClick={() => clickable && onClick(robot)}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `${robot.name}, ${robot.title}: ${robot.label}` : undefined}
    >
      {selected && <ellipse cx={0} cy={3} rx={24} ry={10} fill="none" stroke={robot.color} strokeWidth={2} strokeDasharray="4 3" />}
      <Robot
        color={robot.color}
        state={robot.state}
        facing={robot.facing}
        scale={robot.kind === "filler" ? (robot.id === RECEPTIONIST_ID ? 0.95 : 0.85) : AGENT_SCALE}
        label={robot.kind === "agent" || robot.id === RECEPTIONIST_ID ? robot.name : undefined}
        muted={robot.kind === "filler" && robot.id !== RECEPTIONIST_ID}
      />
      {greeting && (
        <g transform="translate(0, -94)">
          <rect x={-92} y={-14} width={184} height={20} rx={10} fill="#f97316" />
          <polygon points="-4,6 4,6 0,11" fill="#f97316" />
          <text x={0} y={0} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="#ffffff">
            Welcome! The team is through the gate →
          </text>
        </g>
      )}
    </motion.g>
  );
}
