import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Database,
  NotificationChannelPrefs,
  NotificationType,
} from "@/lib/database.types";
import { inQuietHours } from "@/lib/assistant/quiet-hours";
import { sendAndLogEmail } from "@/lib/email-outbox";
import { sendPushToUser } from "@/lib/push";

type DB = SupabaseClient<Database>;

/**
 * One way to tell the team something (0112).
 *
 * Thirty-odd call sites used to insert `notifications` rows one by one in a
 * loop, each followed by its own push call — which is how a quote acceptance
 * came to cost 2N round-trips for N teammates. This does ONE batched insert
 * and fans the pushes out concurrently, and it is the place to change when
 * "notify the team" one day means Slack as well.
 *
 * Push failures never fail the notification: the row is what the bell reads.
 */
export type NotifyInput = {
  /** Specific people, or every profile in the workspace. */
  userIds: "all" | string[];
  type?: NotificationType;
  title: string;
  body?: string | null;
  link: string;
  /** Who did the thing (shown as the actor). Null for the system. */
  actorId?: string | null;
  /** Also push to devices (default true). */
  push?: boolean;
  /**
   * 0115 — this one is worth waking somebody for. Bypasses quiet hours (a
   * hand-off or a failed payment at 11pm is exactly what quiet hours must not
   * swallow); it does NOT override a muted thread or a channel turned off,
   * because those are the person's own decision.
   */
  urgent?: boolean;
};

type Prefs = Database["public"]["Tables"]["notification_prefs"]["Row"];

/** What this person wants for this kind of notification. */
function wants(
  prefs: Prefs | undefined,
  type: NotificationType,
  channel: "inapp" | "push" | "email",
): boolean {
  const forType = (prefs?.channels as NotificationChannelPrefs | undefined)?.[type];
  const chosen = forType?.[channel];
  if (chosen !== undefined) return chosen;
  // Defaults with no row and no explicit choice: in-app and push on, email
  // off. An empty prefs row must behave exactly like no row at all.
  return channel !== "email";
}

/** Muting is by link prefix, so muting a thread mutes everything about it. */
function muted(prefs: Prefs | undefined, link: string): boolean {
  return (prefs?.muted_links ?? []).some((m) => m && link.startsWith(m));
}

/** Returns how many people were notified. */
export async function notifyUsers(supabase: DB, input: NotifyInput): Promise<number> {
  let ids: string[];
  if (input.userIds === "all") {
    const { data: profiles } = await supabase.from("profiles").select("id");
    ids = (profiles ?? []).map((p) => p.id);
  } else {
    ids = input.userIds;
  }
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return 0;

  const type: NotificationType = input.type ?? "system";
  const body = input.body?.trim() || null;

  // 0115 — one read for everybody's preferences. Missing table or missing row
  // both mean "the defaults", so this degrades to the old behaviour exactly.
  const prefsById = new Map<string, Prefs>();
  try {
    const { data } = await supabase
      .from("notification_prefs")
      .select("*")
      .in("user_id", ids);
    for (const row of data ?? []) prefsById.set(row.user_id, row);
  } catch {
    // no prefs table yet
  }

  // A muted thread is muted everywhere — no row, no push, no email. That is
  // what "mute" has to mean, or the bell keeps counting what you silenced.
  const audience = ids.filter((id) => !muted(prefsById.get(id), input.link));
  if (!audience.length) return 0;

  const inapp = audience.filter((id) => wants(prefsById.get(id), type, "inapp"));
  if (inapp.length) {
    const { error } = await supabase.from("notifications").insert(
      inapp.map((userId) => ({
        user_id: userId,
        actor_id: input.actorId ?? null,
        type,
        title: input.title,
        body,
        link: input.link,
      })),
    );
    if (error) {
      console.error("[notify] insert failed:", error.message);
      return 0;
    }
  }

  if (input.push !== false) {
    const pushTo = audience.filter((id) => {
      const prefs = prefsById.get(id);
      if (!wants(prefs, type, "push")) return false;
      if (input.urgent) return true;
      if (!prefs?.quiet_hours_enabled) return true;
      const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
      return !inQuietHours(
        prefs.timezone,
        hh(prefs.quiet_hours_start),
        hh(prefs.quiet_hours_end),
      );
    });
    await Promise.allSettled(
      pushTo.map((userId) =>
        sendPushToUser({
          userId,
          title: input.title,
          body: body || input.title,
          link: input.link,
        }),
      ),
    );
  }

  // Email is opt-in per type. Nobody gets it by accident.
  const emailTo = audience.filter((id) => wants(prefsById.get(id), type, "email"));
  if (emailTo.length) await emailNotification(supabase, emailTo, input, body);

  return audience.length;
}

/**
 * Send a notification on as an email, for the people who asked for that.
 *
 * Best-effort and last: the notifications row is what the bell reads, and a
 * mail failure must not make a notification look like it never happened.
 */
async function emailNotification(
  supabase: DB,
  userIds: string[],
  input: NotifyInput,
  body: string | null,
): Promise<void> {
  try {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", userIds);
    const addresses = (profiles ?? []).map((p) => p.email).filter(Boolean);
    if (!addresses.length) return;

    const link = input.link.startsWith("http")
      ? input.link
      : `${process.env.NEXT_PUBLIC_APP_URL ?? ""}${input.link}`;

    await sendAndLogEmail(supabase, {
      to: addresses,
      kind: "system",
      actor: "system",
      message: {
        transport: "generic",
        subject: input.title,
        body: body || input.title,
        ...(link.startsWith("http")
          ? { cta: { href: link, label: "Open in ARC AI" } }
          : {}),
      },
    });
  } catch {
    // The bell already has it.
  }
}
