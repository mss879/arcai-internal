import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { createHash, randomBytes, randomInt } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { TrustedDevice } from "@/lib/types";

/**
 * Strict device lock for members (admins are exempt).
 *
 * A "device" is a browser profile holding a long-lived httpOnly cookie with a
 * random 256-bit token; only the token's sha256 lives in the DB. Nothing here
 * looks at IPs or networks — changing Wi-Fi never affects the lock.
 *
 * Rules: a member may register at most 2 devices. Device #1 is trusted from
 * the profile page within a 48h window that starts the first time they load
 * the app; the moment it's trusted, untrusted devices can no longer sign in.
 * Device #2 joins via a 6-digit SMS PIN sent to the phone number on the
 * member's profile. Members can never remove devices — admins reset them.
 */

export const GRACE_HOURS = 48;
export const PIN_TTL_MIN = 10;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_RESEND_SECONDS = 60;

/** 400 days — the maximum cookie lifetime browsers honor. Refreshed on login. */
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/** Per-user cookie name, so a shared computer can serve two members. */
export function deviceCookieName(userId: string) {
  return `arc_device_${userId}`;
}

export function deviceCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  };
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function newDeviceToken() {
  return randomBytes(32).toString("base64url");
}

export function newPin() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** "•••• 123" — enough for the member to recognize their own number. */
export function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return `•••• ${digits.slice(-3)}`;
}

/** Human label for the device list, e.g. "iPhone · Safari". */
export function deviceLabelFromUA(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const os = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Device";
  const browser = /Edg(e|iOS|A)?\//i.test(ua)
    ? "Edge"
    : /OPR\/|Opera/i.test(ua)
      ? "Opera"
      : /CriOS\//i.test(ua)
        ? "Chrome"
        : /FxiOS\//i.test(ua)
          ? "Firefox"
          : /Chrome\//i.test(ua)
            ? "Chrome"
            : /Firefox\//i.test(ua)
              ? "Firefox"
              : /Safari\//i.test(ua)
                ? "Safari"
                : "Browser";
  return `${os} · ${browser}`;
}

export type DeviceStatus = {
  devices: TrustedDevice[];
  /** The trusted device matching this request's cookie, if any. */
  currentDeviceId: string | null;
  currentDeviceTrusted: boolean;
  /** ISO deadline of the 48h first-device window (null = clock not started). */
  graceDeadline: string | null;
  withinGrace: boolean;
  /** True when this request must be treated as signed-out for a member. */
  blocked: boolean;
};

const PERMISSIVE: DeviceStatus = {
  devices: [],
  currentDeviceId: null,
  currentDeviceTrusted: false,
  graceDeadline: null,
  withinGrace: true,
  blocked: false,
};

/**
 * The per-request device check for the CURRENT user (RLS: select own).
 * Cached so the auth gate, the app-shell banner, and the profile page share
 * one set of queries. Creates the member's 48h grace row on first sight —
 * that's the moment the warning banner becomes visible to them.
 *
 * Fails OPEN (never locks anyone out) if the tables don't exist yet
 * (migration 0079 not applied) or the status check crashes.
 */
export const getDeviceStatus = cache(
  async (userId: string): Promise<DeviceStatus> => {
    try {
      const supabase = await createClient();
      const [devicesRes, graceRes, cookieStore] = await Promise.all([
        supabase
          .from("trusted_devices")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: true }),
        supabase
          .from("device_grace")
          .select("started_at")
          .eq("user_id", userId)
          .maybeSingle(),
        cookies(),
      ]);
      if (devicesRes.error) throw devicesRes.error;
      if (graceRes.error) throw graceRes.error;

      const devices = devicesRes.data ?? [];

      let startedAt = graceRes.data?.started_at ?? null;
      if (!startedAt && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        // First authenticated page view — start the 48h window now.
        startedAt = new Date().toISOString();
        await createAdminClient()
          .from("device_grace")
          .upsert(
            { user_id: userId, started_at: startedAt },
            { onConflict: "user_id", ignoreDuplicates: true },
          );
      }

      const raw = cookieStore.get(deviceCookieName(userId))?.value ?? null;
      const hash = raw ? sha256(raw) : null;
      const current = hash
        ? (devices.find((d) => d.token_hash === hash) ?? null)
        : null;

      const deadlineMs = startedAt
        ? new Date(startedAt).getTime() + GRACE_HOURS * 3_600_000
        : null;
      // No clock yet (e.g. service key missing) counts as within the window.
      const withinGrace = deadlineMs === null || Date.now() < deadlineMs;

      return {
        devices,
        currentDeviceId: current?.id ?? null,
        currentDeviceTrusted: !!current,
        graceDeadline: deadlineMs ? new Date(deadlineMs).toISOString() : null,
        withinGrace,
        blocked: !current && !(devices.length === 0 && withinGrace),
      };
    } catch (e) {
      console.error(
        "[device-trust] status check failed — failing open:",
        e instanceof Error ? e.message : e,
      );
      return PERMISSIVE;
    }
  },
);

/**
 * Register the CURRENT browser as one of the user's trusted devices and set
 * its device cookie. Server Actions only (cookie writes). Callers enforce
 * the slot rules; this just writes the row + cookie.
 */
export async function registerDevice(
  userId: string,
  userAgent: string | null,
): Promise<
  { ok: true; id: string; label: string } | { ok: false; error: string }
> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: "Device registration isn't configured on the server." };
  }
  const token = newDeviceToken();
  const label = deviceLabelFromUA(userAgent);
  const { data, error } = await createAdminClient()
    .from("trusted_devices")
    .insert({
      user_id: userId,
      token_hash: sha256(token),
      label,
      user_agent: userAgent,
      last_used_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not register device." };
  }
  (await cookies()).set(deviceCookieName(userId), token, deviceCookieOptions());
  return { ok: true, id: data.id, label };
}
