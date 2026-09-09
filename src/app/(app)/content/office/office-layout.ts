/**
 * The office floor plan (0130) — pure geometry, shared by the drawing, the
 * simulation, the player's collision and the tests.
 *
 * One isometric floor of 32×20 tiles (64×32 px each) that can be viewed from
 * four sides: every point goes through `project(c, r, rotation)`, so a desk
 * described once in world tiles draws correctly at any rotation. Rooms are
 * separated by two-tile corridors; the Director's office and the meeting room
 * have glass walls with doors; a glass partition with one gate separates the
 * reception strip from the office, so a visitor always enters past the desk.
 *
 * `FURNITURE` is data, not JSX, so the same list draws the floor and builds
 * the walkability grid the player collides with.
 */

import type { OfficeZoneKey } from "@/lib/agents/office-types";

export const TILE_W = 64;
export const TILE_H = 32;
export const COLS = 32;
export const ROWS = 20;
export const VIEW_W = 1700;
export const VIEW_H = 980;
/** Where the floor's centre tile projects to. */
export const ORIGIN = { x: VIEW_W / 2, y: 520 };
/** Height of the slab's visible side. */
export const SLAB = 22;

export type Rotation = 0 | 1 | 2 | 3;
export type Point = { x: number; y: number };
export type Tile = { c: number; r: number };
export type Rect = { c: number; r: number; w: number; d: number };

// ---- Projection -------------------------------------------------------------------

/** Rotate a centre-relative offset a quarter turn `rot` times (clockwise on screen). */
export function rotateRel(dc: number, dr: number, rot: Rotation): { dc: number; dr: number } {
  switch (rot) {
    case 0:
      return { dc, dr };
    case 1:
      return { dc: -dr, dr: dc };
    case 2:
      return { dc: -dc, dr: -dr };
    case 3:
      return { dc: dr, dr: -dc };
  }
}

export function unrotateRel(dc: number, dr: number, rot: Rotation): { dc: number; dr: number } {
  return rotateRel(dc, dr, ((4 - rot) % 4) as Rotation);
}

export function toRel(c: number, r: number): { dc: number; dr: number } {
  return { dc: c - COLS / 2, dr: r - ROWS / 2 };
}

/** Project an already-rotated, centre-relative offset. */
export function projectRel(dc: number, dr: number): Point {
  return { x: ORIGIN.x + (dc - dr) * (TILE_W / 2), y: ORIGIN.y + (dc + dr) * (TILE_H / 2) };
}

/** World tile → screen pixels at a rotation. */
export function project(c: number, r: number, rot: Rotation): Point {
  const { dc, dr } = toRel(c, r);
  const q = rotateRel(dc, dr, rot);
  return projectRel(q.dc, q.dr);
}

/** Painter's order at a rotation: smaller draws first. */
export function depthOf(c: number, r: number, rot: Rotation): number {
  const { dc, dr } = toRel(c, r);
  const q = rotateRel(dc, dr, rot);
  return q.dc + q.dr;
}

/** A world rect as an axis-aligned rect in the rotated, centre-relative frame. */
export function rotateRect(rect: Rect, rot: Rotation): Rect {
  const corners = [
    toRel(rect.c, rect.r),
    toRel(rect.c + rect.w, rect.r),
    toRel(rect.c, rect.r + rect.d),
    toRel(rect.c + rect.w, rect.r + rect.d),
  ].map((p) => rotateRel(p.dc, p.dr, rot));
  const cs = corners.map((p) => p.dc);
  const rs = corners.map((p) => p.dr);
  const c = Math.min(...cs);
  const r = Math.min(...rs);
  return { c, r, w: Math.max(...cs) - c, d: Math.max(...rs) - r };
}

/**
 * A screen-space direction (arrow keys) as a world-space direction at the
 * current rotation. Screen up moves the character "into" the picture.
 */
export function screenToWorldDelta(dx: number, dy: number, rot: Rotation): { dc: number; dr: number } {
  const dcp = dx / TILE_W + dy / TILE_H;
  const drp = dy / TILE_H - dx / TILE_W;
  return unrotateRel(dcp, drp, rot);
}

// ---- Zones ---------------------------------------------------------------------------

export type Zone = {
  key: OfficeZoneKey;
  label: string;
  rect: Rect;
  /** Where a robot stands, in order of preference. All must be walkable. */
  seats: Tile[];
  /** Where the room's name is painted on the floor. */
  decal: Tile;
};

export const ZONES: Record<OfficeZoneKey, Zone> = {
  library: {
    key: "library",
    label: "Research library",
    rect: { c: 1, r: 1, w: 6, d: 6 },
    seats: [{ c: 3.5, r: 5.5 }, { c: 5.5, r: 4.5 }],
    decal: { c: 1.4, r: 6.6 },
  },
  strategyTable: {
    key: "strategyTable",
    label: "Strategy table",
    rect: { c: 9, r: 1, w: 6, d: 6 },
    seats: [{ c: 12, r: 5.5 }, { c: 10.3, r: 3.6 }, { c: 13.7, r: 3.6 }],
    decal: { c: 9.4, r: 6.6 },
  },
  managerOffice: {
    key: "managerOffice",
    label: "Director's office",
    rect: { c: 18, r: 1, w: 7, d: 6 },
    seats: [{ c: 21.5, r: 4.9 }, { c: 23.4, r: 4.4 }],
    decal: { c: 19.4, r: 5.9 },
  },
  writingDesk: {
    key: "writingDesk",
    label: "Writing desk",
    rect: { c: 1, r: 9, w: 6, d: 6 },
    seats: [{ c: 3.5, r: 12.7 }, { c: 5.5, r: 12 }],
    decal: { c: 1.4, r: 14.6 },
  },
  meetingRoom: {
    key: "meetingRoom",
    label: "Meeting room",
    rect: { c: 9, r: 9, w: 6, d: 6 },
    seats: [
      { c: 10.6, r: 13.3 },
      { c: 12, r: 13.4 },
      { c: 13.4, r: 13.3 },
      { c: 10.8, r: 10.5 },
      { c: 13.2, r: 10.5 },
    ],
    decal: { c: 10.2, r: 13.9 },
  },
  designStudio: {
    key: "designStudio",
    label: "Design studio",
    rect: { c: 18, r: 9, w: 7, d: 6 },
    seats: [{ c: 21.5, r: 12.7 }, { c: 23.2, r: 12 }],
    decal: { c: 19.4, r: 14.6 },
  },
  brandCorner: {
    key: "brandCorner",
    label: "Brand corner",
    rect: { c: 9, r: 16, w: 4, d: 4 },
    seats: [{ c: 10.8, r: 18.7 }, { c: 12.4, r: 18.3 }],
    decal: { c: 9.3, r: 19.4 },
  },
  qaDesk: {
    key: "qaDesk",
    label: "QA desk",
    rect: { c: 13, r: 16, w: 4, d: 4 },
    seats: [{ c: 14.5, r: 18.7 }, { c: 16.2, r: 18.3 }],
    decal: { c: 13.3, r: 19.4 },
  },
  dispatchDesk: {
    key: "dispatchDesk",
    label: "Dispatch",
    rect: { c: 17, r: 16, w: 4, d: 4 },
    seats: [{ c: 19.1, r: 18.7 }, { c: 20.6, r: 18.3 }],
    decal: { c: 17.3, r: 19.4 },
  },
  opsStudio: {
    key: "opsStudio",
    label: "Generalists' studio",
    rect: { c: 27, r: 1, w: 5, d: 14 },
    seats: [{ c: 29.5, r: 4.6 }, { c: 29.5, r: 12.2 }, { c: 27.6, r: 8 }],
    decal: { c: 27.4, r: 14.6 },
  },
  corridor: {
    key: "corridor",
    label: "Corridor",
    rect: { c: 7, r: 1, w: 2, d: 15 },
    seats: [{ c: 7.6, r: 8 }, { c: 16.4, r: 8 }, { c: 12.5, r: 15.5 }, { c: 7.6, r: 15.5 }, { c: 16.4, r: 15.5 }, { c: 12, r: 7.6 }, { c: 25.6, r: 8 }, { c: 25.6, r: 15.4 }],
    decal: { c: 7.2, r: 8.6 },
  },
  reception: {
    key: "reception",
    label: "Reception",
    rect: { c: 1, r: 16, w: 6, d: 4 },
    seats: [{ c: 2.2, r: 17.4 }, { c: 5.4, r: 18.4 }, { c: 6.6, r: 17.6 }],
    decal: { c: 1.3, r: 17.1 },
  },
  breakout: {
    key: "breakout",
    label: "Breakout",
    rect: { c: 21, r: 16, w: 5, d: 4 },
    seats: [{ c: 22.4, r: 18.6 }, { c: 23.8, r: 18.3 }, { c: 21.6, r: 18.8 }, { c: 25.2, r: 18.6 }, { c: 22.8, r: 19.3 }],
    decal: { c: 21.3, r: 19.4 },
  },
};

export const ZONE_KEYS = Object.keys(ZONES) as OfficeZoneKey[];

/** The tile a robot stands on in a zone (wraps past the last seat). */
export function seatPoint(zoneKey: OfficeZoneKey, index = 0): Tile {
  const zone = ZONES[zoneKey];
  return zone.seats[((index % zone.seats.length) + zone.seats.length) % zone.seats.length];
}

// ---- Furniture (data) ------------------------------------------------------------------

export type Furniture =
  | { kind: "desk"; key: string; rect: Rect; accent: string; top?: string }
  | { kind: "roundTable"; key: string; at: Tile; radius: number }
  | { kind: "table"; key: string; rect: Rect }
  | { kind: "shelf"; key: string; rect: Rect }
  | { kind: "board"; key: string; rect: Rect; h: number; variant: "white" | "mood" | "screen" | "easel" }
  | { kind: "wall"; key: string; rect: Rect; h: number; variant?: "glass" | "window" | "post" }
  | { kind: "rug"; key: string; rect: Rect; pattern: "dots" | "stripes" }
  | { kind: "plant"; key: string; at: Tile; size?: number }
  | { kind: "lamp"; key: string; at: Tile }
  | { kind: "sofa"; key: string; rect: Rect }
  | { kind: "coffee"; key: string; rect: Rect }
  | { kind: "counter"; key: string; rect: Rect }
  | { kind: "printer"; key: string; rect: Rect }
  | { kind: "chair"; key: string; rect: Rect }
  | { kind: "mat"; key: string; rect: Rect };

const desk = (key: string, c: number, r: number, accent: string, top?: string): Furniture => ({
  kind: "desk",
  key,
  rect: { c, r, w: 1.8, d: 0.9 },
  accent,
  top,
});

/** The glass partition between reception and the office, with one gate. */
export const GATE: Rect = { c: 7, r: 16, w: 2, d: 1 };

export const FURNITURE: Furniture[] = [
  // Research library
  { kind: "shelf", key: "shelf-1", rect: { c: 1.2, r: 1.1, w: 1.2, d: 0.5 } },
  { kind: "shelf", key: "shelf-2", rect: { c: 2.8, r: 1.1, w: 1.2, d: 0.5 } },
  { kind: "shelf", key: "shelf-3", rect: { c: 4.4, r: 1.1, w: 1.2, d: 0.5 } },
  desk("library-desk", 2.6, 3.4, "#0ea5e9"),
  { kind: "plant", key: "library-plant", at: { c: 6.4, r: 1.6 }, size: 0.9 },

  // Strategy table
  { kind: "board", key: "whiteboard", rect: { c: 10.6, r: 1.1, w: 2.8, d: 0.18 }, h: 54, variant: "white" },
  { kind: "roundTable", key: "round-table", at: { c: 12, r: 3.6 }, radius: 0.9 },

  // Director's office (glass on the corridor sides, door on the south wall)
  { kind: "wall", key: "office-w", rect: { c: 18, r: 1, w: 0.18, d: 6 }, h: 70 },
  { kind: "wall", key: "office-s1", rect: { c: 18, r: 6.82, w: 2, d: 0.18 }, h: 70 },
  { kind: "wall", key: "office-s2", rect: { c: 22, r: 6.82, w: 3, d: 0.18 }, h: 70 },
  desk("office-desk", 20.6, 2.6, "#f97316", "#ffedd5"),
  { kind: "plant", key: "office-plant", at: { c: 23.6, r: 1.6 } },

  // Writing desk
  desk("writing-desk", 2.6, 10.6, "#10b981"),
  { kind: "lamp", key: "writing-lamp", at: { c: 5.6, r: 9.6 } },

  // Meeting room (glass all round, door on the south wall)
  { kind: "wall", key: "meet-n", rect: { c: 9, r: 9, w: 6, d: 0.18 }, h: 64 },
  { kind: "wall", key: "meet-w", rect: { c: 9, r: 9, w: 0.18, d: 6 }, h: 64 },
  { kind: "wall", key: "meet-e", rect: { c: 14.82, r: 9, w: 0.18, d: 6 }, h: 64 },
  { kind: "wall", key: "meet-s1", rect: { c: 9, r: 14.82, w: 2, d: 0.18 }, h: 64 },
  { kind: "wall", key: "meet-s2", rect: { c: 13, r: 14.82, w: 2, d: 0.18 }, h: 64 },
  { kind: "table", key: "meeting-table", rect: { c: 10.6, r: 11.2, w: 2.3, d: 1.1 } },
  { kind: "chair", key: "meet-chair-1", rect: { c: 10.9, r: 10.4, w: 0.5, d: 0.5 } },
  { kind: "chair", key: "meet-chair-2", rect: { c: 12.5, r: 10.4, w: 0.5, d: 0.5 } },

  // Design studio
  desk("design-desk", 20.6, 10.6, "#ec4899"),
  { kind: "board", key: "easel", rect: { c: 23.4, r: 9.7, w: 0.6, d: 0.18 }, h: 58, variant: "easel" },
  { kind: "printer", key: "printer", rect: { c: 18.7, r: 12.4, w: 0.9, d: 0.7 } },

  // The partition: glass, the gate, the brand mood-board and the dispatch screen hang on it.
  { kind: "wall", key: "part-1", rect: { c: 0, r: 16, w: 7, d: 0.18 }, h: 56 },
  { kind: "board", key: "moodboard", rect: { c: 9, r: 16, w: 3, d: 0.18 }, h: 56, variant: "mood" },
  { kind: "wall", key: "part-2", rect: { c: 12, r: 16, w: 6, d: 0.18 }, h: 56 },
  { kind: "board", key: "dispatch-screen", rect: { c: 18, r: 16, w: 3, d: 0.18 }, h: 56, variant: "screen" },
  { kind: "wall", key: "part-3", rect: { c: 21, r: 16, w: 11, d: 0.18 }, h: 56 },

  // Reception strip
  { kind: "counter", key: "reception-counter", rect: { c: 0.6, r: 18.0, w: 3.0, d: 0.8 } },
  { kind: "mat", key: "door-mat", rect: { c: 2.8, r: 19.3, w: 1.4, d: 0.6 } },
  { kind: "plant", key: "reception-plant", at: { c: 6.4, r: 19.0 }, size: 0.85 },
  desk("brand-desk", 9.9, 17.1, "#f59e0b"),
  desk("qa-desk", 13.6, 17.1, "#6366f1"),
  { kind: "lamp", key: "qa-lamp", at: { c: 16.5, r: 19.3 } },
  desk("dispatch-desk", 18.2, 17.1, "#14b8a6"),
  { kind: "sofa", key: "sofa", rect: { c: 21.6, r: 17.1, w: 2.0, d: 0.9 } },
  { kind: "coffee", key: "coffee", rect: { c: 24.3, r: 17.2, w: 0.6, d: 0.6 } },
  { kind: "plant", key: "breakout-plant-1", at: { c: 24.6, r: 19.4 }, size: 0.8 },
  { kind: "plant", key: "breakout-plant-2", at: { c: 21.3, r: 19.5 }, size: 0.8 },

  // Generalists' studio (0131): two desks, a whiteboard, room to think.
  { kind: "board", key: "ops-whiteboard", rect: { c: 27.6, r: 1.1, w: 2.4, d: 0.18 }, h: 54, variant: "white" },
  desk("ops-desk-a", 28.6, 2.6, "#2563eb"),
  desk("ops-desk-b", 28.6, 10.2, "#65a30d"),
  { kind: "plant", key: "ops-plant-1", at: { c: 31.4, r: 1.6 } },
  { kind: "plant", key: "ops-plant-2", at: { c: 31.4, r: 13.6 }, size: 0.9 },
  { kind: "lamp", key: "ops-lamp", at: { c: 27.5, r: 7.6 } },

  // A phone booth and greenery on the front strip's far end.
  { kind: "wall", key: "booth", rect: { c: 27.6, r: 17.2, w: 1.6, d: 1.3 }, h: 72 },
  { kind: "plant", key: "strip-plant", at: { c: 30.6, r: 18.6 } },
  { kind: "lamp", key: "strip-lamp", at: { c: 31.4, r: 17.4 } },

  // Windows along the back edges — daylight for the rooms behind them.
  { kind: "wall", key: "window-n1", rect: { c: 0.5, r: 0, w: 6.5, d: 0.14 }, h: 96, variant: "window" },
  { kind: "wall", key: "window-n2", rect: { c: 8.5, r: 0, w: 7, d: 0.14 }, h: 96, variant: "window" },
  { kind: "wall", key: "window-n3", rect: { c: 17.5, r: 0, w: 7.5, d: 0.14 }, h: 96, variant: "window" },
  { kind: "wall", key: "window-n4", rect: { c: 26.5, r: 0, w: 5, d: 0.14 }, h: 96, variant: "window" },
  { kind: "wall", key: "window-e1", rect: { c: 31.86, r: 0.5, w: 0.14, d: 6 }, h: 96, variant: "window" },
  { kind: "wall", key: "window-e2", rect: { c: 31.86, r: 8.5, w: 0.14, d: 6.5 }, h: 96, variant: "window" },

  // Soft floors where people sit.
  { kind: "rug", key: "meeting-rug", rect: { c: 9.6, r: 9.6, w: 5, d: 4.9 }, pattern: "dots" },
  { kind: "rug", key: "breakout-rug", rect: { c: 21.2, r: 16.6, w: 3.6, d: 3 }, pattern: "stripes" },
  { kind: "rug", key: "office-rug", rect: { c: 19, r: 1.6, w: 5.4, d: 4.4 }, pattern: "dots" },

  // The entrance: two posts either side of the mat.
  { kind: "wall", key: "door-post-l", rect: { c: 1.7, r: 19.55, w: 0.3, d: 0.3 }, h: 78, variant: "post" },
  { kind: "wall", key: "door-post-r", rect: { c: 5.3, r: 19.55, w: 0.3, d: 0.3 }, h: 78, variant: "post" },

  // Corridor life
  { kind: "lamp", key: "corridor-lamp-1", at: { c: 7.5, r: 1.5 } },
  { kind: "lamp", key: "corridor-lamp-2", at: { c: 16.5, r: 14.5 } },
  { kind: "plant", key: "corridor-plant", at: { c: 26.4, r: 8.0 } },
];

/** The chair in front of a desk (drawn and blocked with it). */
export function deskChair(rect: Rect): Rect {
  return { c: rect.c + 0.6, r: rect.r + rect.d + 0.15, w: 0.6, d: 0.55 };
}

/** What blocks walking, or null for decals. */
export function footprints(f: Furniture): Rect[] {
  switch (f.kind) {
    case "desk":
      // The chair is where the robot stands; only the desk itself blocks.
      return [f.rect];
    case "roundTable":
      return [{ c: f.at.c - f.radius, r: f.at.r - f.radius, w: f.radius * 2, d: f.radius * 2 }];
    case "plant":
      return [{ c: f.at.c - 0.3, r: f.at.r - 0.3, w: 0.6, d: 0.6 }];
    case "lamp":
      return [{ c: f.at.c - 0.25, r: f.at.r - 0.25, w: 0.5, d: 0.5 }];
    case "mat":
    case "chair":
    case "rug":
      return [];
    default:
      return [f.rect];
  }
}

// ---- Walkability ------------------------------------------------------------------------

/** ROWS × COLS, 1 = blocked. */
export type Blocked = Uint8Array;

export function buildBlocked(): Blocked {
  const grid = new Uint8Array(ROWS * COLS);
  const mark = (rect: Rect) => {
    const c0 = Math.max(0, Math.floor(rect.c + 1e-6));
    const c1 = Math.min(COLS - 1, Math.ceil(rect.c + rect.w - 1e-6) - 1);
    const r0 = Math.max(0, Math.floor(rect.r + 1e-6));
    const r1 = Math.min(ROWS - 1, Math.ceil(rect.r + rect.d - 1e-6) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r * COLS + c] = 1;
  };
  for (const f of FURNITURE) for (const rect of footprints(f)) mark(rect);
  return grid;
}

export function isBlocked(grid: Blocked, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return true;
  return grid[Math.floor(r) * COLS + Math.floor(c)] === 1;
}

/** The player's body is a small disc; sample its rim. */
export const PLAYER_RADIUS = 0.26;

export function canStand(grid: Blocked, c: number, r: number): boolean {
  const k = PLAYER_RADIUS;
  return (
    !isBlocked(grid, c - k, r - k) &&
    !isBlocked(grid, c + k, r - k) &&
    !isBlocked(grid, c - k, r + k) &&
    !isBlocked(grid, c + k, r + k)
  );
}

/** Where a visitor starts: on the door mat, inside the front edge. */
export const SPAWN: Tile = { c: 3.5, r: 19.45 };

/** How close (in tiles) counts as standing with a robot. */
export const NEAR_RADIUS = 2.1;

/** Breadth-first walk over tiles; the test proves every desk is reachable. */
export function reachableFrom(grid: Blocked, start: Tile): Set<string> {
  const key = (c: number, r: number) => `${c},${r}`;
  const seen = new Set<string>();
  const queue: Tile[] = [{ c: Math.floor(start.c), r: Math.floor(start.r) }];
  seen.add(key(queue[0].c, queue[0].r));
  while (queue.length) {
    const { c, r } = queue.shift()!;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      if (grid[nr * COLS + nc] === 1) continue;
      const k = key(nc, nr);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ c: nc, r: nr });
    }
  }
  return seen;
}
