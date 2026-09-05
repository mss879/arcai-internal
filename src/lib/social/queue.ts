import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, SocialPlatform } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Putting a post on the publish queue (0118).
 *
 * The one place a social_posts row is raised: the Studio's "Schedule it"
 * button and the assistant's confirm card both land here, so the rules —
 * a design must be chosen, an attached client must have approved, the
 * accounts must be connected — are checked once and can't drift between the
 * two doors. Only ever queues: processDueSocialPosts owns the actual send.
 */

export type QueueSocialPostInput = {
  postId: string;
  accountIds: string[];
  /** ISO timestamp. */
  scheduledFor: string;
  createdBy: string | null;
};

export type QueuedAccount = { id: string; platform: SocialPlatform; name: string };

export type QueueSocialPostResult =
  | { ok: true; queued: number; accounts: QueuedAccount[]; topic: string }
  | { ok: false; error: string };

export async function queueSocialPost(
  db: DB,
  input: QueueSocialPostInput,
): Promise<QueueSocialPostResult> {
  if (!input.accountIds.length) {
    return { ok: false, error: "Pick at least one account." };
  }
  const when = new Date(input.scheduledFor);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, error: "That isn't a date I can schedule for." };
  }

  const { data: post } = await db
    .from("carousel_posts")
    .select("id, topic, caption, hashtags, chosen_option_id, client_id, client_status")
    .eq("id", input.postId)
    .maybeSingle();
  if (!post) return { ok: false, error: "That post no longer exists." };
  if (!post.chosen_option_id) {
    return { ok: false, error: "Pick a design first." };
  }
  if (post.client_id && post.client_status !== "approved") {
    return { ok: false, error: "The client hasn't approved this one yet." };
  }

  const { data: option } = await db
    .from("carousel_options")
    .select("slides")
    .eq("id", post.chosen_option_id)
    .maybeSingle();
  const media = (option?.slides ?? [])
    .filter((s) => s.image_url)
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ url: s.image_url! }));
  if (!media.length) {
    return { ok: false, error: "That design has no rendered slides yet." };
  }

  const { data: accounts } = await db
    .from("social_accounts")
    .select("id, platform, name")
    .in("id", input.accountIds)
    .eq("active", true);
  if (!accounts?.length) {
    return { ok: false, error: "Those accounts aren't connected." };
  }

  const caption = [
    post.caption,
    post.hashtags.length
      ? post.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { error } = await db.from("social_posts").insert(
    accounts.map((a) => ({
      platform: a.platform,
      account_id: a.id,
      carousel_post_id: post.id,
      client_id: post.client_id,
      caption,
      media,
      scheduled_for: when.toISOString(),
      status: "scheduled" as const,
      created_by: input.createdBy,
    })),
  );
  if (error) return { ok: false, error: error.message };

  await db.from("carousel_posts").update({ status: "scheduled" }).eq("id", post.id);

  return {
    ok: true,
    queued: accounts.length,
    accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name })),
    topic: post.topic,
  };
}

/**
 * The accounts a post can go to, without the token (encrypted or not).
 * `clientId` null = the agency's own; set = connected on a client's behalf.
 */
export async function listActiveSocialAccounts(
  db: DB,
): Promise<(QueuedAccount & { clientId: string | null })[]> {
  try {
    const { data } = await db
      .from("social_accounts")
      .select("id, platform, name, client_id")
      .eq("active", true)
      .order("name");
    return (data ?? []).map((a) => ({
      id: a.id,
      platform: a.platform,
      name: a.name,
      clientId: a.client_id,
    }));
  } catch {
    // 0118 not applied yet.
    return [];
  }
}
