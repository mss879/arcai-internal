import "server-only";

import webpush from "web-push";

import { createAdminClient } from "@/lib/supabase/admin";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@arcai.agency";

let configured = false;

/**
 * Lazily wire up VAPID details. Returns false (no-op) when keys are
 * missing — mirrors the graceful behaviour of lib/email.ts so push is
 * optional infrastructure.
 */
function ensureConfigured(): boolean {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return false;
  if (!configured) {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  }
  return true;
}

/**
 * Send a background web-push notification to every device a workspace
 * member has enabled. Reads their subscriptions via the service-role
 * client (the actor is usually not the recipient, so RLS would block a
 * normal read), prunes expired endpoints, and never throws — a push
 * failure must never break the action that triggered it.
 */
export async function sendPushToUser(opts: {
  userId: string;
  title: string;
  body?: string | null;
  link?: string | null;
}): Promise<{ sent: number }> {
  if (!ensureConfigured()) return { sent: 0 };

  try {
    const admin = createAdminClient();
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", opts.userId);

    if (!subs?.length) return { sent: 0 };

    const payload = JSON.stringify({
      title: opts.title,
      body: opts.body ?? "",
      link: opts.link ?? "/",
    });

    const stale: string[] = [];
    let sent = 0;

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // 404/410 = the subscription is gone; drop it.
          if (code === 404 || code === 410) stale.push(s.endpoint);
        }
      }),
    );

    if (stale.length) {
      await admin.from("push_subscriptions").delete().in("endpoint", stale);
    }

    return { sent };
  } catch (e) {
    console.error("[push] send failed:", e instanceof Error ? e.message : e);
    return { sent: 0 };
  }
}
