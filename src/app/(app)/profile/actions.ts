"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  deviceCookieName,
  registerDevice,
  sha256,
} from "@/lib/device-trust";
import { normalizePhone } from "@/lib/sms-utils";
import type { Database } from "@/lib/database.types";
import type { ActionResult } from "@/lib/types";

type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

export async function updateProfile(input: {
  full_name?: string;
  title?: string;
  phone?: string;
  avatar_url?: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const patch: ProfileUpdate = {};
  if (input.full_name !== undefined) patch.full_name = input.full_name.trim();
  if (input.title !== undefined) patch.title = input.title.trim() || null;
  if (input.phone !== undefined) {
    if (!input.phone.trim()) {
      patch.phone = null;
    } else {
      const phone = normalizePhone(input.phone);
      if (!phone.ok) return { ok: false, error: phone.error };
      patch.phone = phone.value;
    }
  }
  if (input.avatar_url !== undefined) patch.avatar_url = input.avatar_url;

  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/profile");
  return { ok: true };
}

export async function changePassword(
  newPassword: string,
): Promise<ActionResult> {
  if (newPassword.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Register the CURRENT browser as the member's FIRST trusted device.
 * From that moment only trusted devices can sign in; the second device
 * joins via the SMS code on the login screen. Members can never remove
 * devices — only admins reset them from the Team page.
 */
export async function trustDevice(): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const admin = createAdminClient();
  const { data: prof } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (prof?.role !== "member") {
    return { ok: false, error: "Admins are exempt from device locking." };
  }

  const { data: devices, error } = await admin
    .from("trusted_devices")
    .select("id, token_hash")
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };

  const raw = (await cookies()).get(deviceCookieName(user.id))?.value;
  if (raw && (devices ?? []).some((d) => d.token_hash === sha256(raw))) {
    return { ok: false, error: "This device is already trusted." };
  }
  if ((devices ?? []).length >= 2) {
    return {
      ok: false,
      error: "You've already registered 2 devices — ask an admin to reset them.",
    };
  }
  if ((devices ?? []).length >= 1) {
    return {
      ok: false,
      error:
        "Your first device is already registered. To add this one, log in here and tap “Text me a code”.",
    };
  }

  const ua = (await headers()).get("user-agent");
  const res = await registerDevice(user.id, ua);
  if (!res.ok) return res;

  revalidatePath("/profile");
  return { ok: true };
}

/** Store (or refresh) a web-push subscription for the current device. */
export async function savePushSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      user_agent: userAgent ?? null,
    },
    { onConflict: "endpoint" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Remove a device's web-push subscription. */
export async function deletePushSubscription(
  endpoint: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
