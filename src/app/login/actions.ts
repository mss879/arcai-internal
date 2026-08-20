"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordLoginSession } from "@/lib/activity";
import { isSupabaseConfigured } from "@/lib/auth";
import {
  GRACE_HOURS,
  PIN_MAX_ATTEMPTS,
  PIN_RESEND_SECONDS,
  PIN_TTL_MIN,
  deviceCookieName,
  deviceCookieOptions,
  maskPhone,
  newPin,
  registerDevice,
  sha256,
} from "@/lib/device-trust";
import { isSmsConfigured, sendSms } from "@/lib/sms";

export type AuthState =
  | {
      error?: string;
      info?: string;
      /** Reveal the "Text me a code" + code input section on the login form. */
      deviceCodePrompt?: boolean;
      phoneMask?: string;
    }
  | undefined;

function safePath(input: string, fallback = "/dashboard") {
  return input.startsWith("/") && !input.startsWith("//") ? input : fallback;
}

const LOCKED_OUT =
  "This device isn't trusted for your account. Ask an admin to reset your trusted devices.";

/** Outcome of the member device gate for one login attempt. */
type Gate = {
  /** Non-null = refuse the login and show this state (after signing out). */
  block: AuthState | null;
  /** The trusted device this login used, when known (for the session log). */
  device: { id: string; label: string } | null;
  isMember: boolean;
};

/**
 * Device lock for members, evaluated AFTER the password checks out.
 * Throws on infrastructure errors (missing tables/keys) so the caller can
 * fail open.
 */
async function memberDeviceGate(opts: {
  userId: string;
  intent: string;
  deviceCode: string;
}): Promise<Gate> {
  const blocked = (state: AuthState): Gate => ({
    block: state,
    device: null,
    isMember: true,
  });
  const allowed = (device: { id: string; label: string } | null = null): Gate => ({
    block: null,
    device,
    isMember: true,
  });

  const admin = createAdminClient();

  const [profRes, devicesRes, graceRes] = await Promise.all([
    admin
      .from("profiles")
      .select("role, phone, full_name")
      .eq("id", opts.userId)
      .maybeSingle(),
    admin.from("trusted_devices").select("*").eq("user_id", opts.userId),
    admin.from("device_grace").select("*").eq("user_id", opts.userId).maybeSingle(),
  ]);
  if (devicesRes.error) throw devicesRes.error;
  if (graceRes.error) throw graceRes.error;

  // Admins are exempt from the device lock (and aren't session-logged).
  if (profRes.data?.role !== "member") {
    return { block: null, device: null, isMember: false };
  }

  const devices = devicesRes.data ?? [];
  let grace = graceRes.data ?? null;
  if (!grace) {
    // First contact with this member — start their 48h registration window.
    const startedAt = new Date().toISOString();
    await admin
      .from("device_grace")
      .upsert(
        { user_id: opts.userId, started_at: startedAt },
        { onConflict: "user_id", ignoreDuplicates: true },
      );
    grace = {
      user_id: opts.userId,
      started_at: startedAt,
      pair_code_hash: null,
      pair_code_expires_at: null,
      pair_code_attempts: 0,
      pair_code_sent_at: null,
    };
  }
  const withinGrace =
    Date.now() <
    new Date(grace.started_at).getTime() + GRACE_HOURS * 3_600_000;

  const cookieStore = await cookies();
  const raw = cookieStore.get(deviceCookieName(opts.userId))?.value ?? null;
  const matched = raw
    ? devices.find((d) => d.token_hash === sha256(raw))
    : undefined;

  // 1. Trusted device — welcome back. Refresh the 400-day cookie window.
  if (matched && raw) {
    await admin
      .from("trusted_devices")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", matched.id);
    cookieStore.set(deviceCookieName(opts.userId), raw, deviceCookieOptions());
    return allowed({ id: matched.id, label: matched.label });
  }

  const phone = profRes.data?.phone ?? null;
  const phoneMask = phone ? maskPhone(phone) : undefined;
  const slotFree = devices.length < 2;

  // 2. "Text me a code" — SMS a PIN to the phone number on the profile so
  //    this device can join as #2. Never to a number typed at login.
  if (opts.intent === "send-code") {
    if (devices.length === 0) {
      // No first device yet — either they can simply log in (window open)
      // or they're locked out entirely.
      return withinGrace ? allowed() : blocked({ error: LOCKED_OUT });
    }
    if (!slotFree) return blocked({ error: LOCKED_OUT });
    if (!phone) {
      return blocked({
        error:
          "No phone number is on your account — add it on My Profile from your trusted device, or ask an admin to add it, then try again.",
        deviceCodePrompt: true,
      });
    }
    if (!isSmsConfigured()) {
      return blocked({
        error:
          "Text messages aren't configured on the server. Ask an admin to reset your trusted devices instead.",
      });
    }
    const lastSent = grace.pair_code_sent_at
      ? new Date(grace.pair_code_sent_at).getTime()
      : 0;
    if (Date.now() - lastSent < PIN_RESEND_SECONDS * 1000) {
      return blocked({
        info: `A code was already sent to ${phoneMask} — give it a minute, then try again.`,
        deviceCodePrompt: true,
        phoneMask,
      });
    }

    const pin = newPin();
    const upd = await admin
      .from("device_grace")
      .update({
        pair_code_hash: sha256(pin),
        pair_code_expires_at: new Date(
          Date.now() + PIN_TTL_MIN * 60_000,
        ).toISOString(),
        pair_code_attempts: 0,
        pair_code_sent_at: new Date().toISOString(),
      })
      .eq("user_id", opts.userId);
    if (upd.error) throw upd.error;

    const sent = await sendSms({
      to: phone,
      message: `ARC AI: your device code is ${pin}. It expires in ${PIN_TTL_MIN} minutes. Never share it.`,
      contactName: profRes.data?.full_name,
    });
    if (!sent.ok) {
      return blocked({
        error: `Couldn't send the code: ${sent.error}`,
        deviceCodePrompt: true,
        phoneMask,
      });
    }
    return blocked({
      info: `Code sent to your phone ${phoneMask}. Enter it below, then log in.`,
      deviceCodePrompt: true,
      phoneMask,
    });
  }

  // 3. A PIN was entered — redeem it to register this device.
  if (opts.deviceCode) {
    const codeHash = sha256(opts.deviceCode.trim());
    const validPin =
      slotFree &&
      devices.length > 0 &&
      !!grace.pair_code_hash &&
      !!grace.pair_code_expires_at &&
      Date.now() < new Date(grace.pair_code_expires_at).getTime() &&
      (grace.pair_code_attempts ?? 0) < PIN_MAX_ATTEMPTS &&
      codeHash === grace.pair_code_hash;

    if (validPin) {
      await admin
        .from("device_grace")
        .update({
          pair_code_hash: null,
          pair_code_expires_at: null,
          pair_code_attempts: 0,
        })
        .eq("user_id", opts.userId);
      const ua = (await headers()).get("user-agent");
      const reg = await registerDevice(opts.userId, ua);
      if (!reg.ok) return blocked({ error: reg.error });
      return allowed({ id: reg.id, label: reg.label });
    }

    if (grace.pair_code_hash) {
      await admin
        .from("device_grace")
        .update({ pair_code_attempts: (grace.pair_code_attempts ?? 0) + 1 })
        .eq("user_id", opts.userId);
    }
    return blocked({
      error: "Invalid or expired code. Tap “Text me a code” to get a fresh one.",
      deviceCodePrompt: slotFree && devices.length > 0,
      phoneMask,
    });
  }

  // 4. No devices registered yet and the 48h window is open — let them in so
  //    they can trust this (or another) device from their profile.
  if (devices.length === 0 && withinGrace) return allowed();

  // 5. Refused. Offer the SMS path when a slot is free.
  if (slotFree && devices.length > 0) {
    return blocked({
      error:
        "This device isn't trusted. We can text a sign-in code to the phone number on your account.",
      deviceCodePrompt: true,
      phoneMask,
    });
  }
  return blocked({ error: LOCKED_OUT });
}

/** Sign in with username OR email + password. */
export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  if (!isSupabaseConfigured()) {
    return { error: "Supabase is not configured yet. Add your keys to .env.local." };
  }

  const identifier = String(formData.get("identifier") || "").trim();
  const password = String(formData.get("password") || "");
  const redirectTo = safePath(String(formData.get("redirectTo") || "/dashboard"));
  const intent = String(formData.get("intent") || "");
  const deviceCode = String(formData.get("deviceCode") || "").trim();

  if (!identifier || !password) {
    return { error: "Enter your username/email and password." };
  }

  let email = identifier;

  // Resolve a username to its email using the privileged client.
  if (!identifier.includes("@")) {
    try {
      const admin = createAdminClient();
      const { data } = await admin
        .from("profiles")
        .select("email")
        .eq("username", identifier.toLowerCase())
        .maybeSingle();
      if (!data?.email) {
        return { error: "No account found with that username." };
      }
      email = data.email;
    } catch {
      return { error: "Unable to resolve username — try your email instead." };
    }
  }

  const supabase = await createClient();
  const { data: signIn, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !signIn?.user) {
    return { error: "Invalid credentials. Please try again." };
  }

  // Device lock (members only). Fails OPEN if the check itself breaks —
  // e.g. migrations not applied yet — so logins never brick site-wide.
  let gate: Gate;
  try {
    gate = await memberDeviceGate({ userId: signIn.user.id, intent, deviceCode });
  } catch (e) {
    console.error(
      "[login] device gate crashed — allowing login:",
      e instanceof Error ? e.message : e,
    );
    gate = { block: null, device: null, isMember: false };
  }
  if (gate.block) {
    // The password created a session; remove it before refusing.
    await supabase.auth.signOut();
    return gate.block;
  }

  // Admin monitoring: one row per member sign-in (time, device, IP, location).
  // Never blocks the login — recordLoginSession swallows its own errors.
  if (gate.isMember) {
    await recordLoginSession({
      userId: signIn.user.id,
      deviceId: gate.device?.id ?? null,
      deviceLabel: gate.device?.label ?? null,
    });
  }

  redirect(redirectTo);
}

/** Sign the current user out. */
export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
