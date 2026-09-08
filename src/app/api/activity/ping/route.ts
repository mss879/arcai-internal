import { NextResponse } from "next/server";

import { touchActivity } from "@/lib/activity";
import { getProfile } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The member activity heartbeat (<ActivityHeartbeat/> posts here once a
 * minute while the app is open, and once more on the way out).
 *
 * This lives in a Route Handler rather than the (app) layout for two
 * reasons, both of which were silently breaking the monitor before:
 *
 *   * layouts "do not re-render on navigation", so a heartbeat inside one
 *     fires on hard loads only — a member could work all afternoon and
 *     register a single ping;
 *   * a layout cannot write cookies, so it could only ever bump a session
 *     that a *password login* had already opened. A member whose iPad
 *     stays signed in never logs in, so there was nothing to bump.
 *
 * Admins are deliberately not tracked. A signed-out ping is a plain 401 —
 * the client ignores it; the proxy has usually redirected it already.
 */
export async function POST() {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (profile.role !== "member") {
    return NextResponse.json({ ok: true, tracked: false });
  }

  const sessionId = await touchActivity(profile.id);
  return NextResponse.json({ ok: true, tracked: Boolean(sessionId) });
}
