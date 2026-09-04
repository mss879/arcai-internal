import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { sendAndLogEmail } from "@/lib/email-outbox";

type DB = SupabaseClient<Database>;

/**
 * Digests, by email, for the people who asked for them (0115).
 *
 * The weekly digest and the morning briefing both existed and both landed
 * in-app only — which is fine for whoever opens the CRM first thing, and
 * useless for the owner reading mail on their phone before they do. This
 * sends the same text as an email to the users whose notification
 * preferences say `digest_weekly` or `digest_daily`.
 *
 * It never generates anything itself: the caller passes the text it has
 * already produced, so a digest costs exactly one AI call whether or not
 * anybody has the email switched on.
 */

export type DigestKind = "weekly" | "daily";

/**
 * Email one digest to everyone opted into that kind.
 *
 * Returns how many people it reached. Best-effort throughout: the in-app
 * digest has already been delivered, so a mail failure must not read as a
 * digest that never ran.
 */
export async function sendDigestEmails(
  db: DB,
  kind: DigestKind,
  input: { subject: string; body: string; link: string },
  /** Only these users (the daily briefing is per-person). */
  onlyUserIds?: string[],
): Promise<number> {
  try {
    const column = kind === "weekly" ? "digest_weekly" : "digest_daily";
    let query = db
      .from("notification_prefs")
      .select("user_id")
      .eq(column, true);
    if (onlyUserIds) {
      if (onlyUserIds.length === 0) return 0;
      query = query.in("user_id", onlyUserIds);
    }
    const { data: opted } = await query;
    const ids = (opted ?? []).map((r) => r.user_id);
    if (!ids.length) return 0;

    const { data: profiles } = await db
      .from("profiles")
      .select("id, email")
      .in("id", ids);
    const addresses = (profiles ?? []).map((p) => p.email).filter(Boolean);
    if (!addresses.length) return 0;

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
    await sendAndLogEmail(db, {
      to: addresses,
      kind: "digest",
      actor: "system",
      message: {
        transport: "generic",
        subject: input.subject,
        body: input.body,
        ...(base ? { cta: { href: `${base}${input.link}`, label: "Open ARC AI" } } : {}),
      },
    });
    return addresses.length;
  } catch {
    // notification_prefs may not exist yet, or mail may be down. The digest
    // itself already happened.
    return 0;
  }
}
