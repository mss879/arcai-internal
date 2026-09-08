/**
 * The one decision the member activity monitor has to get right, pulled
 * out of the server-only module so it can be tested: given what this
 * browser claims its session is, and what the database still has open for
 * this device, does a heartbeat continue a session or start a new one?
 *
 * Getting this wrong is how the monitor broke in the first place — the old
 * version could only ever continue a session that a password login had
 * opened, so a member who never signs out was never recorded again.
 */

/** Don't write more than one heartbeat per minute per session. */
export const BUMP_THROTTLE_MS = 60_000;

/**
 * A gap this long ends a session: the next heartbeat opens a new row
 * rather than stretching the old one across the silence. Matches the
 * client idle logout, so a session that timed out is never resurrected.
 */
export const IDLE_GAP_MS = 30 * 60_000;

/** The columns of a `login_sessions` row this decision needs. */
export type SessionRow = { id: string; last_active_at: string };

export type SessionDecision =
  | {
      action: "continue";
      sessionId: string;
      /** Write `last_active_at`, or is the throttle still holding? */
      write: boolean;
      /** Point the cookie at this session (it wasn't already). */
      setCookie: boolean;
    }
  | { action: "open" };

/** Has this session gone quiet long enough to count as ended? */
export function isLive(row: SessionRow, now: number): boolean {
  return new Date(row.last_active_at).getTime() > now - IDLE_GAP_MS;
}

/**
 * `cookieSession` is the row this browser's cookie names (null when the
 * cookie is missing, forged, or points at a deleted row); `deviceSession`
 * is the newest session still open for the same device, which is how a
 * second tab — or a browser that dropped the cookie — rejoins the session
 * it belongs to instead of splitting the day into fragments.
 */
export function decideSession(input: {
  now: number;
  cookieSession: SessionRow | null;
  deviceSession: SessionRow | null;
}): SessionDecision {
  const { now, cookieSession, deviceSession } = input;

  const resume = (row: SessionRow, setCookie: boolean): SessionDecision => ({
    action: "continue",
    sessionId: row.id,
    // Timestamps are parsed, never string-compared: Postgres returns
    // microseconds and a `+00:00` offset, JS gives milliseconds and a `Z`.
    write: new Date(row.last_active_at).getTime() <= now - BUMP_THROTTLE_MS,
    setCookie,
  });

  if (cookieSession && isLive(cookieSession, now)) {
    return resume(cookieSession, false);
  }
  if (deviceSession && isLive(deviceSession, now)) {
    return resume(deviceSession, true);
  }
  return { action: "open" };
}
