import "server-only";

import { cookies, headers } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Member login monitoring (admins are not logged).
 *
 * loginAction inserts one `login_sessions` row per member sign-in — time,
 * device, IP and location — and stores the row id in a browser-session
 * cookie. Every page navigation then bumps `last_active_at` (throttled to
 * once a minute), so admins can see how long the member stayed active.
 * Location comes from Netlify's `x-nf-geo` request header — no external
 * geo service involved; on localhost it's simply absent.
 */

export const SESSION_COOKIE = "arc_lsid";

/** Don't write more than one heartbeat per minute per session. */
const BUMP_THROTTLE_MS = 60_000;
/** Matches the client idle logout — a 30 min gap means the session ended. */
const IDLE_GAP_MS = 30 * 60_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GeoInfo = {
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
};

function parseGeoHeader(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    /* Netlify has shipped this header base64-encoded in some runtimes. */
  }
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** IP + city/region/country for the current request (nulls on localhost). */
export async function requestLocation(): Promise<GeoInfo> {
  const h = await headers();
  const ip =
    h.get("x-nf-client-connection-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  const geo = parseGeoHeader(h.get("x-nf-geo"));
  const country = geo?.country as { name?: string; code?: string } | undefined;
  const subdivision = geo?.subdivision as { name?: string } | undefined;

  return {
    ip,
    city: typeof geo?.city === "string" ? geo.city : null,
    region: subdivision?.name ?? null,
    country: country?.name ?? country?.code ?? null,
  };
}

/**
 * Insert the login_sessions row for a fresh member sign-in and remember its
 * id in a browser-session cookie. Server Actions only (sets a cookie).
 * Never throws — monitoring must never block a login.
 */
export async function recordLoginSession(opts: {
  userId: string;
  deviceId: string | null;
  deviceLabel: string | null;
}): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const [location, h] = await Promise.all([requestLocation(), headers()]);
    const { data, error } = await createAdminClient()
      .from("login_sessions")
      .insert({
        user_id: opts.userId,
        device_id: opts.deviceId,
        device_label: opts.deviceLabel,
        ip: location.ip,
        city: location.city,
        region: location.region,
        country: location.country,
        user_agent: h.get("user-agent"),
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("no row returned");

    (await cookies()).set(SESSION_COOKIE, data.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      // No maxAge: dies with the browser session, like the activity it tracks.
    });
  } catch (e) {
    console.error(
      "[activity] failed to record login session:",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Heartbeat: stretch the current session's `last_active_at` to now.
 * Safe in Server Components (no cookie writes). The WHERE clause does all
 * the work — at most one write a minute, and a session that's been idle
 * past the logout threshold is left ended rather than stretched.
 */
export async function bumpActivity(userId: string): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const lsid = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!lsid || !UUID_RE.test(lsid)) return;
    const now = Date.now();
    await createAdminClient()
      .from("login_sessions")
      .update({ last_active_at: new Date(now).toISOString() })
      .eq("id", lsid)
      .eq("user_id", userId)
      .lt("last_active_at", new Date(now - BUMP_THROTTLE_MS).toISOString())
      .gt("last_active_at", new Date(now - IDLE_GAP_MS).toISOString());
  } catch (e) {
    console.error(
      "[activity] heartbeat failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
