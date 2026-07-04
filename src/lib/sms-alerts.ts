import "server-only";

import { sendSms } from "@/lib/sms";
import { normalizePhone } from "@/lib/sms-utils";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Text a workspace member on their profile phone number when they're
 * assigned or tagged somewhere (todo, lead, mention). Reads the phone via
 * the service-role client (the actor is usually not the recipient), is a
 * no-op when the member has no phone or Notify.lk isn't configured, and
 * never throws — an SMS failure must never break the action that
 * triggered it. Mirrors the graceful behaviour of lib/push.ts.
 */
export async function sendSmsToUser(opts: {
  userId: string;
  message: string;
}): Promise<{ sent: boolean }> {
  try {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", opts.userId)
      .maybeSingle();
    if (!profile?.phone) return { sent: false };

    // Stored normalized, but re-normalize defensively for hand-edited rows.
    const phone = normalizePhone(profile.phone);
    if (!phone.ok) return { sent: false };

    const res = await sendSms({
      to: phone.value,
      message: opts.message,
      contactName: profile.full_name || undefined,
    });
    if (!res.ok && !res.error.includes("isn't configured")) {
      console.error("[sms-alert] send failed:", res.error);
    }
    return { sent: res.ok };
  } catch (e) {
    console.error(
      "[sms-alert] send failed:",
      e instanceof Error ? e.message : e,
    );
    return { sent: false };
  }
}
