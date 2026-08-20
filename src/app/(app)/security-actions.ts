"use server";

import { cookies } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deviceCookieName, sha256 } from "@/lib/device-trust";

/**
 * Company policy: screenshots of the system are logged. The client sentry
 * calls this when it catches a screenshot signal (the Print Screen key —
 * the only one browsers can see; macOS/phone screenshots are invisible to
 * web pages). The event lands in member_changes so it shows up in the
 * admin Activity view's Changes feed and Analytics. Members only; never
 * throws.
 */
export async function reportScreenshotAction(path: string): Promise<void> {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const admin = createAdminClient();
    const { data: prof } = await admin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (prof?.role !== "member") return;

    // Name the registered device it happened on, when recognizable.
    let deviceLabel: string | null = null;
    const raw = (await cookies()).get(deviceCookieName(user.id))?.value;
    if (raw) {
      const { data: devices } = await admin
        .from("trusted_devices")
        .select("label, token_hash")
        .eq("user_id", user.id);
      deviceLabel =
        devices?.find((d) => d.token_hash === sha256(raw))?.label ?? null;
    }

    const cleanPath =
      typeof path === "string" && path.startsWith("/")
        ? path.slice(0, 80)
        : "/";

    await admin.from("member_changes").insert({
      user_id: user.id,
      table_name: "screenshots",
      op: "created",
      label: `Print Screen on ${cleanPath}${deviceLabel ? ` · ${deviceLabel}` : ""}`,
    });
  } catch (e) {
    // Logging must never disturb the member's session.
    console.error(
      "[screenshot] failed to record:",
      e instanceof Error ? e.message : e,
    );
  }
}
