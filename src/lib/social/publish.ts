import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logSystemWrite } from "@/lib/system-audit";
import type { Database, SocialMediaItem } from "@/lib/database.types";
import { notifyUsers } from "@/lib/notify";
import { decryptToken } from "@/lib/social/crypto";
import { publishToFacebook, publishToInstagram } from "@/lib/social/meta";

type DB = SupabaseClient<Database>;

/**
 * Publish what's due (0118).
 *
 * The Studio wrote captions and rendered carousels beautifully and then
 * stopped at a ZIP file, so the last step — actually posting — was the one
 * that quietly didn't happen on a busy week.
 *
 * Three rules this encodes, all of them about not making a mess on somebody
 * else's feed:
 *
 *   • A lease, not a flag. Two ticks must never publish the same post twice;
 *     a duplicate on a client's Instagram is not something you can undo
 *     quietly.
 *   • Three attempts, then stop and tell a person. Retrying an expired token
 *     forever is just noise.
 *   • Nothing publishes that the client hasn't approved, when a client is
 *     attached. Approval lives on the carousel post, and is re-checked here
 *     rather than trusted from when the post was scheduled.
 */

/** Publishing is slow and metered; the tick is shared. */
const MAX_POSTS_PER_TICK = 3;
const MAX_ATTEMPTS = 3;
/** A publish that has held the lease longer than this has died. */
const LEASE_MS = 5 * 60_000;

export type SocialPublishResult = { published: number; failed: number };

/**
 * A dry run when Meta isn't connected yet.
 *
 * app review for instagram_content_publish takes weeks, so the queue has to
 * be usable before it lands: the post moves to `published` with no external
 * id, and the UI says it was a dry run rather than pretending it went out.
 */
function dryRunEnabled(): boolean {
  return process.env.SOCIAL_DRY_RUN === "1";
}

export async function processDueSocialPosts(db: DB): Promise<SocialPublishResult> {
  const result: SocialPublishResult = { published: 0, failed: 0 };
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_MS).toISOString();

  const { data: due } = await db
    .from("social_posts")
    .select(
      "id, platform, account_id, carousel_post_id, client_id, caption, media, attempts, locked_at",
    )
    .eq("status", "scheduled")
    .lte("scheduled_for", now.toISOString())
    .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
    .order("scheduled_for", { ascending: true })
    .limit(MAX_POSTS_PER_TICK);
  if (!due?.length) return result;

  for (const post of due) {
    // Claim it. The conditional update IS the lease: whoever wins owns this
    // post, and every other tick moves on.
    const { data: claimed } = await db
      .from("social_posts")
      .update({
        status: "publishing",
        locked_at: now.toISOString(),
        attempts: post.attempts + 1,
      })
      .eq("id", post.id)
      .eq("status", "scheduled")
      .select("id");
    if (!claimed?.length) continue;

    const outcome = await publishOne(db, post);

    if (outcome.ok) {
      await db
        .from("social_posts")
        .update({
          status: "published",
          external_post_id: outcome.externalId,
          permalink: outcome.permalink,
          error: null,
          locked_at: null,
        })
        .eq("id", post.id);
      if (post.carousel_post_id) {
        await db
          .from("carousel_posts")
          .update({ status: "published" })
          .eq("id", post.carousel_post_id);
      }
      // T5.3 — a post that went out to the world gets a line.
      await logSystemWrite(db, {
        job: "socialPublish",
        table: "social_posts",
        rowId: post.id,
        action: "published",
        summary: `Post published${outcome.permalink ? ` — ${outcome.permalink}` : dryRunEnabled() ? " (dry run)" : ""}`,
        meta: { external_post_id: outcome.externalId ?? null, permalink: outcome.permalink ?? null, carousel_post_id: post.carousel_post_id ?? null },
      });
      result.published += 1;
      continue;
    }

    result.failed += 1;
    const spent = post.attempts + 1 >= MAX_ATTEMPTS;
    await db
      .from("social_posts")
      .update({
        // Back to scheduled for another go, unless the attempts are spent.
        status: spent ? "failed" : "scheduled",
        error: outcome.error,
        locked_at: null,
      })
      .eq("id", post.id);

    if (spent) {
      if (post.carousel_post_id) {
        await db
          .from("carousel_posts")
          .update({ status: "publish_failed" })
          .eq("id", post.carousel_post_id);
      }
      await notifyUsers(db, {
        userIds: "all",
        type: "system",
        title: "A post didn't go out",
        body: `${post.platform === "instagram" ? "Instagram" : "Facebook"}: ${outcome.error}`,
        link: "/content",
      });
    }
  }

  return result;
}

async function publishOne(
  db: DB,
  post: {
    id: string;
    platform: string;
    account_id: string | null;
    carousel_post_id: string | null;
    client_id: string | null;
    caption: string;
    media: SocialMediaItem[];
  },
): Promise<
  { ok: true; externalId: string | null; permalink: string | null } | { ok: false; error: string }
> {
  const urls = (post.media ?? []).map((m) => m.url).filter(Boolean);
  if (!urls.length) return { ok: false, error: "The post has no images." };

  // Re-checked here, not trusted from scheduling time: a client may have
  // asked for changes in between, and posting anyway is the worst outcome
  // this feature can produce.
  if (post.carousel_post_id) {
    const { data: source } = await db
      .from("carousel_posts")
      .select("client_id, client_status")
      .eq("id", post.carousel_post_id)
      .maybeSingle();
    if (source?.client_id && source.client_status !== "approved") {
      return {
        ok: false,
        error: "The client hasn't approved this one yet.",
      };
    }
  }

  if (dryRunEnabled()) {
    // Meta app review is weeks away; the queue still has to be usable.
    return { ok: true, externalId: null, permalink: null };
  }

  if (!post.account_id) return { ok: false, error: "No account chosen." };

  const { data: account } = await db
    .from("social_accounts")
    .select("platform, external_id, page_id, access_token_enc, active")
    .eq("id", post.account_id)
    .maybeSingle();
  if (!account || !account.active) {
    return { ok: false, error: "That account is no longer connected." };
  }

  const token = decryptToken(account.access_token_enc);
  if (!token) {
    return {
      ok: false,
      error:
        "The saved access token can't be read — reconnect the account (or check SOCIAL_TOKEN_KEY).",
    };
  }

  if (account.platform === "instagram") {
    return publishToInstagram({
      igUserId: account.external_id,
      accessToken: token,
      caption: post.caption,
      imageUrls: urls,
    });
  }
  return publishToFacebook({
    pageId: account.page_id || account.external_id,
    accessToken: token,
    caption: post.caption,
    imageUrls: urls,
  });
}
