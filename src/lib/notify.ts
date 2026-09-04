import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, NotificationType } from "@/lib/database.types";
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
};

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

  const { error } = await supabase.from("notifications").insert(
    ids.map((userId) => ({
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

  if (input.push !== false) {
    await Promise.allSettled(
      ids.map((userId) =>
        sendPushToUser({
          userId,
          title: input.title,
          body: body || input.title,
          link: input.link,
        }),
      ),
    );
  }
  return ids.length;
}
