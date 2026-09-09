"use client";

import * as React from "react";

import {
  NEAR_RADIUS,
  SPAWN,
  canStand,
  depthOf,
  project,
  screenToWorldDelta,
  type Blocked,
  type Rotation,
  type Tile,
} from "./office-layout";

/**
 * You, on the floor (0130).
 *
 * Arrow keys / WASD (or the on-screen pad) move a small avatar across the
 * walkability grid at a steady speed, sliding along walls and furniture.
 * The loop runs on requestAnimationFrame and writes the avatar's transform
 * straight to the DOM — React renders nothing per frame. React is told two
 * things, and only when they change: the depth bucket (so the avatar is
 * re-sorted among the furniture) and which robot is within reach.
 */

export const PLAYER_SPEED = 3.4; // tiles per second

export type PlayerTarget = { id: string; c: number; r: number };

export type ControllerOptions = {
  enabled: boolean;
  rotation: Rotation;
  blocked: Blocked;
  /** Read fresh every check so moving robots are followed. */
  targets: React.RefObject<PlayerTarget[]>;
  onDepthChange: (tile: Tile) => void;
  onNear: (id: string | null) => void;
  onFirstMove: () => void;
  onRotate: (dir: 1 | -1) => void;
  onInteract: () => void;
};

type Pos = { c: number; r: number; facing: 1 | -1; moving: boolean };

const MOVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "W", "A", "S", "D"]);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

export function usePlayerController(opts: ControllerOptions) {
  const gRef = React.useRef<SVGGElement>(null);
  const faceRef = React.useRef<SVGGElement>(null);
  const animRef = React.useRef<SVGGElement>(null);
  const pos = React.useRef<Pos>({ c: SPAWN.c, r: SPAWN.r, facing: 1, moving: false });
  const keys = React.useRef(new Set<string>());
  const pad = React.useRef({ dx: 0, dy: 0 });
  const rotRef = React.useRef(opts.rotation);
  const optsRef = React.useRef(opts);
  React.useEffect(() => {
    optsRef.current = opts;
  });

  const apply = React.useCallback(() => {
    const p = project(pos.current.c, pos.current.r, rotRef.current);
    gRef.current?.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    faceRef.current?.setAttribute("transform", `scale(${pos.current.facing} 1)`);
    animRef.current?.setAttribute("class", pos.current.moving ? "robot-walk" : "robot-bob");
  }, []);

  React.useEffect(() => {
    rotRef.current = opts.rotation;
    apply();
  }, [opts.rotation, apply]);

  // Keyboard.
  React.useEffect(() => {
    if (!opts.enabled) return;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (MOVE_KEYS.has(e.key)) {
        keys.current.add(e.key.toLowerCase());
        e.preventDefault();
        return;
      }
      if (e.key === "q" || e.key === "Q") optsRef.current.onRotate(-1);
      if (e.key === "e" || e.key === "E") optsRef.current.onRotate(1);
      if (e.key === "Enter" || e.key === " ") {
        const near = nearRef.current;
        if (near) {
          e.preventDefault();
          optsRef.current.onInteract();
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.key.toLowerCase());
    };
    const blur = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      keys.current.clear();
    };
  }, [opts.enabled]);

  const nearRef = React.useRef<string | null>(null);

  // The loop.
  React.useEffect(() => {
    if (!opts.enabled) return;
    let raf = 0;
    let last = performance.now();
    let lastBucket = Number.NaN;
    let lastNearCheck = 0;
    let movedOnce = false;
    apply();

    const frame = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      const k = keys.current;
      let dx = pad.current.dx;
      let dy = pad.current.dy;
      if (k.has("arrowup") || k.has("w")) dy -= 1;
      if (k.has("arrowdown") || k.has("s")) dy += 1;
      if (k.has("arrowleft") || k.has("a")) dx -= 1;
      if (k.has("arrowright") || k.has("d")) dx += 1;
      const moving = dx !== 0 || dy !== 0;
      const p = pos.current;
      if (moving) {
        const len = Math.hypot(dx, dy);
        dx /= len;
        dy /= len;
        const w = screenToWorldDelta(dx, dy, rotRef.current);
        const wl = Math.hypot(w.dc, w.dr) || 1;
        const step = PLAYER_SPEED * dt;
        const nc = p.c + (w.dc / wl) * step;
        const nr = p.r + (w.dr / wl) * step;
        const blocked = optsRef.current.blocked;
        if (canStand(blocked, nc, p.r)) p.c = nc;
        if (canStand(blocked, p.c, nr)) p.r = nr;
        if (dx !== 0) p.facing = dx < 0 ? -1 : 1;
        if (!movedOnce) {
          movedOnce = true;
          optsRef.current.onFirstMove();
        }
      }
      p.moving = moving;
      apply();

      const bucket = Math.round(depthOf(p.c, p.r, rotRef.current) * 2) / 2;
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        optsRef.current.onDepthChange({ c: p.c, r: p.r });
      }

      if (t - lastNearCheck > 120) {
        lastNearCheck = t;
        let best: string | null = null;
        let bestD = NEAR_RADIUS;
        for (const target of optsRef.current.targets.current ?? []) {
          const d = Math.hypot(target.c - p.c, target.r - p.r);
          if (d < bestD) {
            bestD = d;
            best = target.id;
          }
        }
        if (best !== nearRef.current) {
          nearRef.current = best;
          optsRef.current.onNear(best);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [opts.enabled, apply]);

  const setPad = React.useCallback((dx: number, dy: number) => {
    pad.current = { dx, dy };
  }, []);

  const reset = React.useCallback(() => {
    pos.current = { c: SPAWN.c, r: SPAWN.r, facing: 1, moving: false };
    apply();
  }, [apply]);

  return { gRef, faceRef, animRef, setPad, reset, pos };
}

/** The visitor's avatar: a person, not a robot, so you always find yourself.
 * The name is drawn by the floor OUTSIDE the facing flip, so it never mirrors. */
export function PlayerAvatar() {
  return (
    <g>
      <ellipse cx={0} cy={2} rx={13} ry={5} fill="rgba(15, 23, 42, 0.14)" />
      <g>
        {/* legs */}
        <rect x={-7} y={-12} width={5.5} height={12} rx={2.5} fill="#1e293b" />
        <rect x={1.5} y={-12} width={5.5} height={12} rx={2.5} fill="#1e293b" />
        {/* body */}
        <rect x={-10} y={-34} width={20} height={23} rx={6} fill="#f97316" />
        <rect x={-10} y={-34} width={20} height={10} rx={6} fill="rgba(255,255,255,0.18)" />
        {/* arms */}
        <rect x={-15} y={-31} width={5} height={14} rx={2.5} fill="#fb923c" />
        <rect x={10} y={-31} width={5} height={14} rx={2.5} fill="#fb923c" />
        {/* head */}
        <circle cx={0} cy={-44} r={9.5} fill="#f1c8a5" />
        <path d="M-9.5 -46 Q0 -60 9.5 -46 Q5 -52 0 -52 Q-5 -52 -9.5 -46 Z" fill="#3b2f2f" />
        <circle cx={-3.2} cy={-44} r={1.1} fill="#1e293b" />
        <circle cx={3.2} cy={-44} r={1.1} fill="#1e293b" />
        <path d="M-3 -40 Q0 -38 3 -40" stroke="#b45309" strokeWidth={1} fill="none" strokeLinecap="round" />
      </g>
    </g>
  );
}

/** The label under the visitor, outside the flip. */
export function PlayerLabel({ name }: { name: string }) {
  return (
    <text x={0} y={17} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#0f172a" style={{ paintOrder: "stroke", stroke: "rgba(255,255,255,0.9)", strokeWidth: 3 }}>
      {name}
    </text>
  );
}
