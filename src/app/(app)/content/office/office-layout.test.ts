import { describe, expect, it } from "vitest";

import { ROSTER } from "@/lib/agents/roster";

import {
  COLS,
  GATE,
  ROWS,
  SPAWN,
  ZONES,
  ZONE_KEYS,
  buildBlocked,
  canStand,
  depthOf,
  isBlocked,
  project,
  reachableFrom,
  rotateRect,
  screenToWorldDelta,
  seatPoint,
} from "./office-layout";

/**
 * The floor is a game level now: if a desk is walled in, a seat sits inside a
 * table, or the gate is blocked, the visitor can never reach an agent and the
 * whole feature is a pretty picture. These pin the level.
 */

const blocked = buildBlocked();

describe("walkability", () => {
  it("the door and every seat are standable", () => {
    expect(canStand(blocked, SPAWN.c, SPAWN.r)).toBe(true);
    for (const key of ZONE_KEYS) {
      for (const [i, seat] of ZONES[key].seats.entries()) {
        expect(isBlocked(blocked, seat.c, seat.r), `${key} seat ${i} at ${seat.c},${seat.r} is blocked`).toBe(false);
      }
    }
  });

  it("the partition is closed except at the gate", () => {
    for (let c = 0; c < COLS; c++) {
      const inGate = c >= GATE.c && c < GATE.c + GATE.w;
      expect(isBlocked(blocked, c + 0.5, GATE.r + 0.5), `partition at c=${c}`).toBe(!inGate);
    }
  });

  it("every agent's desk is reachable from the door, through the gate", () => {
    const reach = reachableFrom(blocked, SPAWN);
    for (const a of ROSTER) {
      const seat = seatPoint(a.zone, 0);
      expect(reach.has(`${Math.floor(seat.c)},${Math.floor(seat.r)}`), `${a.name} at ${a.zone}`).toBe(true);
    }
    // And the meeting room, through its door.
    for (const seat of ZONES.meetingRoom.seats) {
      expect(reach.has(`${Math.floor(seat.c)},${Math.floor(seat.r)}`)).toBe(true);
    }
  });

  it("rooms behind glass are entered by their doors only", () => {
    // The Director's west wall blocks the whole side; the south wall has a gap.
    for (let r = 1; r < 7; r++) expect(isBlocked(blocked, 18.1, r + 0.5)).toBe(true);
    expect(isBlocked(blocked, 20.5, 6.9)).toBe(false);
    expect(isBlocked(blocked, 21.5, 6.9)).toBe(false);
    expect(isBlocked(blocked, 19.5, 6.9)).toBe(true);
  });
});

describe("projection", () => {
  it("rotating four times is the identity, and rotation preserves distances", () => {
    const a = project(3, 4, 0);
    const b = project(3, 4, 1);
    const back = project(3, 4, 0);
    expect(back).toEqual(a);
    expect(b).not.toEqual(a);
    const d0 = depthOf(3, 4, 0);
    expect(depthOf(3, 4, 2)).toBeCloseTo(-d0, 6);
  });

  it("rotating a rect keeps its area and swaps its sides on a quarter turn", () => {
    const rect = { c: 2, r: 3, w: 3, d: 1 };
    const q = rotateRect(rect, 1);
    expect(q.w).toBeCloseTo(1, 6);
    expect(q.d).toBeCloseTo(3, 6);
    const full = rotateRect(rect, 2);
    expect(full.w).toBeCloseTo(3, 6);
    expect(full.d).toBeCloseTo(1, 6);
  });

  it("screen-up walks into the picture at every rotation", () => {
    for (const rot of [0, 1, 2, 3] as const) {
      const d = screenToWorldDelta(0, -1, rot);
      const from = project(10, 10, rot);
      const to = project(10 + d.dc * 5, 10 + d.dr * 5, rot);
      expect(to.y).toBeLessThan(from.y);
      expect(Math.abs(to.x - from.x)).toBeLessThan(1e-6);
    }
    expect(ROWS * COLS).toBe(blocked.length);
  });
});
