"use server";

/**
 * The Arcus terminal (0104) — registering THE machine.
 *
 * One computer in the agency is where Arcus lives: the owner's workstation,
 * signed in around the clock, listening for its name. These actions mark the
 * current browser as that machine (`trusted_devices.is_terminal`), and the
 * shell reads the flag to switch off the idle logout and force the wake word
 * on — see `isTerminalDevice()`.
 *
 * Deliberately a PARALLEL path to the member device-lock, never a branch of
 * it. `trustDevice()` and the SMS-PIN flow own the member 2-device rules and
 * are untouched; this path refuses members outright, so it can never be used
 * to mint a member a third device row. Admins are exempt from device locking
 * (`auth.ts` only gates `role === "member"`), so an admin gaining a device
 * row here changes nothing about their access — the row exists purely to
 * carry the terminal flag.
 *
 * All writes go through the service-role client because `trusted_devices`
 * has no insert/update policies at all (0079) — by design, so the caps can't
 * be bypassed through PostgREST. That design is why no RLS changed for this.
 */

import { cookies, headers } from "next/headers";

import { requireProfile } from "@/lib/auth";
import {
  deviceCookieName,
  deviceLabelFromUA,
  registerDevice,
  sha256,
} from "@/lib/device-trust";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

export type TerminalStatus = {
  /** True when THIS browser is the registered terminal. */
  isTerminal: boolean;
  /** Where the flag currently lives, if anywhere ("Mac · Chrome"). */
  terminalLabel: string | null;
  registeredAt: string | null;
};

export async function getTerminalStatus(): Promise<
  ActionResult<TerminalStatus>
> {
  try {
    const profile = await requireProfile();
    const admin = createAdminClient();
    const { data: terminal } = await admin
      .from("trusted_devices")
      .select("token_hash, label, created_at")
      .eq("user_id", profile.id)
      .eq("is_terminal", true)
      .maybeSingle();

    const token = (await cookies()).get(deviceCookieName(profile.id))?.value;
    return {
      ok: true,
      isTerminal: Boolean(
        terminal && token && terminal.token_hash === sha256(token),
      ),
      terminalLabel: terminal?.label ?? null,
      registeredAt: terminal?.created_at ?? null,
    };
  } catch {
    return { ok: false, error: "Could not read the terminal status." };
  }
}

export async function registerTerminal(): Promise<ActionResult> {
  const profile = await requireProfile();

  // Members live under the 2-device lock; a terminal that never logs out
  // would be a hole punched straight through it. The admin's workstation is
  // what this feature is for.
  if (profile.role === "member") {
    return {
      ok: false,
      error: "Terminal mode is for the admin workstation.",
    };
  }

  const admin = createAdminClient();
  const ua = (await headers()).get("user-agent");
  const token = (await cookies()).get(deviceCookieName(profile.id))?.value;

  // Exactly one terminal per user: clear the flag wherever it was before
  // planting it here, so moving machines is one click, not a cleanup chore.
  const { error: clearError } = await admin
    .from("trusted_devices")
    .update({ is_terminal: false })
    .eq("user_id", profile.id)
    .eq("is_terminal", true);
  if (clearError) {
    return {
      ok: false,
      error:
        "Could not update the device registry — has migration 0104 been run?",
    };
  }

  // Reuse this browser's existing device row when its cookie matches one;
  // otherwise mint a row + 400-day cookie via the existing helper.
  if (token) {
    const { data: existing } = await admin
      .from("trusted_devices")
      .select("id")
      .eq("user_id", profile.id)
      .eq("token_hash", sha256(token))
      .maybeSingle();
    if (existing) {
      const { error } = await admin
        .from("trusted_devices")
        .update({
          is_terminal: true,
          label: `${deviceLabelFromUA(ua)} · Terminal`,
          last_used_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return error ? { ok: false, error: error.message } : { ok: true };
    }
  }

  const created = await registerDevice(profile.id, ua);
  if (!created.ok) return created;
  const { error } = await admin
    .from("trusted_devices")
    .update({
      is_terminal: true,
      label: `${created.label} · Terminal`,
    })
    .eq("id", created.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function unregisterTerminal(): Promise<ActionResult> {
  const profile = await requireProfile();
  const { error } = await createAdminClient()
    .from("trusted_devices")
    .update({ is_terminal: false })
    .eq("user_id", profile.id)
    .eq("is_terminal", true);
  return error ? { ok: false, error: error.message } : { ok: true };
}
