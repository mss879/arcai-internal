import "server-only";

import { cookies, headers } from "next/headers";

import {
  IDLE_GAP_MS,
  decideSession,
  isLive,
  type SessionRow,
} from "@/lib/activity-core";
import { deviceCookieName, sha256 } from "@/lib/device-trust";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Member activity monitoring (admins are not logged).
 *
 * One `login_sessions` row per stretch of work — time, device, IP and
 * location — with `last_active_at` stretched by a client heartbeat while
 * the tab is open, so the gap between the two columns is how long they
 * actually stayed. Location comes from Netlify's `x-nf-geo` request
 * header — no external geo service involved; on localhost it's absent.
 *
 * A row is opened by whichever comes first:
 *
 *   * `recordLoginSession` — they signed in with a password (kind
 *     'login'), which is also where the device gate hands us the exact
 *     trusted device that was used; or
 *   * `touchActivity` — the heartbeat found no live session (kind
 *     'resume'). This is the common case: a member whose iPad is
 *     permanently signed in never touches the login form, and before
 *     this existed the monitor simply stopped recording them.
 *
 * Everything here is best-effort and swallows its own errors: monitoring
 * must never block a login or fail a page.
 */

export const SESSION_COOKIE = "arc_lsid";

/**
 * 400 days — the maximum cookie lifetime browsers honor, same as the
 * device cookie. It deliberately OUTLIVES the browser session: the old
 * session-scoped cookie meant closing Safari silently switched the
 * monitor off until the next password login. Pointing at a stale row is
 * harmless — `touchActivity` opens a new session when the row it names
 * has gone quiet.
 */
const SESSION_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GeoInfo = {
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
};

type DeviceInfo = { id: string | null; label: string | null };

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  };
}

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
 * Which registered device is making this request, from the same 400-day
 * device cookie the member lock uses (src/lib/device-trust.ts). The login
 * path gets this from the device gate; the heartbeat has to look it up.
 */
async function currentDevice(userId: string): Promise<DeviceInfo> {
  const empty: DeviceInfo = { id: null, label: null };
  try {
    const token = (await cookies()).get(deviceCookieName(userId))?.value;
    if (!token) return empty;
    const { data } = await createAdminClient()
      .from("trusted_devices")
      .select("id, label")
      .eq("user_id", userId)
      .eq("token_hash", sha256(token))
      .maybeSingle();
    return data ? { id: data.id, label: data.label } : empty;
  } catch {
    return empty;
  }
}

/**
 * PostgREST's schema-cache miss and Postgres's own undefined_column — the
 * two ways "that column isn't there yet" arrives before a migration runs.
 */
function isMissingColumnError(error: { code?: string } | null): boolean {
  return error?.code === "PGRST204" || error?.code === "42703";
}

/**
 * Open a session row and point the cookie at it. `kind` records how it
 * started; the label falls back to the user agent so an unregistered
 * browser is still identifiable in the Activity view.
 */
async function openSession(opts: {
  userId: string;
  device: DeviceInfo;
  kind: "login" | "resume";
}): Promise<string> {
  const [location, h] = await Promise.all([requestLocation(), headers()]);
  const row = {
    user_id: opts.userId,
    device_id: opts.device.id,
    device_label: opts.device.label,
    ip: location.ip,
    city: location.city,
    region: location.region,
    country: location.country,
    user_agent: h.get("user-agent"),
  };

  const admin = createAdminClient();
  let { data, error } = await admin
    .from("login_sessions")
    .insert({ ...row, kind: opts.kind })
    .select("id")
    .single();

  // `kind` arrives with 0128 — until that migration is applied, insert the
  // row without it rather than losing the session entirely. Narrowly: only
  // the two "no such column" codes retry. Retrying a genuine failure (RLS,
  // FK, timeout) just pays for it twice, and retrying a write whose
  // response was merely lost would duplicate the session.
  if (!data && isMissingColumnError(error)) {
    ({ data, error } = await admin
      .from("login_sessions")
      .insert(row)
      .select("id")
      .single());
  }
  if (error || !data) throw error ?? new Error("no row returned");

  (await cookies()).set(SESSION_COOKIE, data.id, sessionCookieOptions());
  return data.id;
}

/**
 * Insert the login_sessions row for a fresh member sign-in and remember
 * its id in a cookie. Server Actions only (sets a cookie).
 * Never throws — monitoring must never block a login.
 */
export async function recordLoginSession(opts: {
  userId: string;
  deviceId: string | null;
  deviceLabel: string | null;
}): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await openSession({
      userId: opts.userId,
      device: { id: opts.deviceId, label: opts.deviceLabel },
      kind: "login",
    });
  } catch (e) {
    console.error(
      "[activity] failed to record login session:",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * The heartbeat, called by <ActivityHeartbeat> while a member has the app
 * open and in front of them. Route Handlers / Server Actions only — it
 * writes the session cookie.
 *
 * Stretches the current session's `last_active_at`, or opens a new
 * session when there isn't a live one. That second half is the whole
 * point: a member who never signs in (because they never signed out)
 * used to be invisible here forever.
 *
 * Returns the session id it recorded against, or null if it couldn't.
 */
export async function touchActivity(userId: string): Promise<string | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const admin = createAdminClient();
    const now = Date.now();
    // The queries only ever ask for sessions that could still be live;
    // decideSession() is what actually rules on them.
    const liveSince = new Date(now - IDLE_GAP_MS).toISOString();

    // What this browser thinks its session is. A query that FAILS must not
    // be read as "no live session" — that would open a fresh row on every
    // ping for the length of a Supabase wobble, filling the member's
    // history with phantom one-minute sessions.
    const cookieStore = await cookies();
    const lsid = cookieStore.get(SESSION_COOKIE)?.value;
    const { data: cookieSession, error: cookieError } =
      lsid && UUID_RE.test(lsid)
        ? await admin
            .from("login_sessions")
            .select("id, last_active_at")
            .eq("id", lsid)
            .eq("user_id", userId)
            .gt("last_active_at", liveSince)
            .maybeSingle()
        : { data: null, error: null };
    if (cookieError) throw cookieError;

    // …and, only when the cookie can't answer, what the database still has
    // open for this device — so the steady-state heartbeat is one SELECT.
    // Identity is the registered device where there is one, and the user
    // agent otherwise (an unregistered browser inside its 48h window), so
    // two different machines never share a session row.
    let device: DeviceInfo = { id: null, label: null };
    let deviceSession: SessionRow | null = null;
    if (!cookieSession || !isLive(cookieSession, now)) {
      const [found, h] = await Promise.all([currentDevice(userId), headers()]);
      device = found;
      let deviceQuery = admin
        .from("login_sessions")
        .select("id, last_active_at")
        .eq("user_id", userId)
        .gt("last_active_at", liveSince)
        .order("last_active_at", { ascending: false })
        .limit(1);
      deviceQuery = device.id
        ? deviceQuery.eq("device_id", device.id)
        : deviceQuery
            .is("device_id", null)
            .eq("user_agent", h.get("user-agent") ?? "");
      const deviceRes = await deviceQuery.maybeSingle();
      if (deviceRes.error) throw deviceRes.error;
      deviceSession = deviceRes.data;
    }

    const decision = decideSession({ now, cookieSession, deviceSession });

    if (decision.action === "continue") {
      if (decision.setCookie) {
        cookieStore.set(SESSION_COOKIE, decision.sessionId, sessionCookieOptions());
      }
      if (decision.write) {
        await admin
          .from("login_sessions")
          .update({ last_active_at: new Date(now).toISOString() })
          .eq("id", decision.sessionId)
          .eq("user_id", userId);
      }
      return decision.sessionId;
    }

    // A genuinely new stretch of work: open a session for it, and let the
    // device list show it was used today even without a sign-in.
    const id = await openSession({ userId, device, kind: "resume" });
    if (device.id) {
      await admin
        .from("trusted_devices")
        .update({ last_used_at: new Date(now).toISOString() })
        .eq("id", device.id);
    }
    return id;
  } catch (e) {
    console.error(
      "[activity] heartbeat failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
