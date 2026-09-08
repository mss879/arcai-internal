import { describe, expect, it } from "vitest";

import {
  BUMP_THROTTLE_MS,
  IDLE_GAP_MS,
  decideSession,
  isLive,
} from "@/lib/activity-core";

const NOW = Date.parse("2026-09-09T10:00:00.000Z");

/** A row last seen `ms` before NOW, in the shape Postgres actually returns. */
function seen(ms: number, id = "s1") {
  return {
    id,
    last_active_at: new Date(NOW - ms)
      .toISOString()
      .replace("Z", "000+00:00"), // microseconds + offset, as PostgREST sends
  };
}

describe("isLive", () => {
  it("counts a recent heartbeat as live", () => {
    expect(isLive(seen(60_000), NOW)).toBe(true);
  });

  it("ends a session once it has been quiet past the idle gap", () => {
    expect(isLive(seen(IDLE_GAP_MS + 1_000), NOW)).toBe(false);
  });
});

describe("decideSession", () => {
  it("continues the cookie's session without rewriting the cookie", () => {
    const d = decideSession({
      now: NOW,
      cookieSession: seen(5 * 60_000),
      deviceSession: null,
    });
    expect(d).toEqual({
      action: "continue",
      sessionId: "s1",
      write: true,
      setCookie: false,
    });
  });

  it("holds the write when the session was bumped seconds ago", () => {
    const d = decideSession({
      now: NOW,
      cookieSession: seen(BUMP_THROTTLE_MS / 2),
      deviceSession: null,
    });
    expect(d).toMatchObject({ action: "continue", write: false });
  });

  // The whole point of the fix: an iPad that is permanently signed in and
  // simply gets opened. No cookie, no live session, no password — and the
  // old monitor recorded nothing at all for it.
  it("opens a new session when nothing is live", () => {
    expect(
      decideSession({ now: NOW, cookieSession: null, deviceSession: null }),
    ).toEqual({ action: "open" });
  });

  it("opens a new session once the previous one has gone quiet", () => {
    expect(
      decideSession({
        now: NOW,
        cookieSession: seen(IDLE_GAP_MS + 60_000),
        deviceSession: null,
      }),
    ).toEqual({ action: "open" });
  });

  // A browser that dropped the session cookie (or a second tab) must rejoin
  // the session it belongs to, not fragment the day into several.
  it("adopts the device's live session and repoints the cookie", () => {
    const d = decideSession({
      now: NOW,
      cookieSession: null,
      deviceSession: seen(4 * 60_000, "device-session"),
    });
    expect(d).toEqual({
      action: "continue",
      sessionId: "device-session",
      write: true,
      setCookie: true,
    });
  });

  it("prefers a live device session over a cookie pointing at a dead one", () => {
    const d = decideSession({
      now: NOW,
      cookieSession: seen(IDLE_GAP_MS + 60_000, "dead"),
      deviceSession: seen(30_000, "alive"),
    });
    expect(d).toMatchObject({ sessionId: "alive", setCookie: true });
  });

  it("keeps the cookie's own session when both are live", () => {
    const d = decideSession({
      now: NOW,
      cookieSession: seen(2 * 60_000, "mine"),
      deviceSession: seen(30_000, "other-tab"),
    });
    expect(d).toMatchObject({ sessionId: "mine", setCookie: false });
  });
});
