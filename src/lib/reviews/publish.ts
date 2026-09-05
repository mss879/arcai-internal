import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logSystemWrite } from "@/lib/system-audit";
import type { Database } from "@/lib/database.types";
import { createWebsiteClient } from "@/lib/web-analytics/source";

type DB = SupabaseClient<Database>;

/**
 * Testimonials, from the CRM onto the website (0117).
 *
 * A client fills in the review form on their portal, the words land in
 * `project_reviews` — and then somebody copies and pastes them onto
 * arcai.agency by hand, or more often doesn't. The praise the agency earned
 * sat in a table nobody outside the team ever saw.
 *
 * This is the SECOND and LAST module that writes to the website's database.
 * The other is `@/lib/careers/sync`. That rule matters: the two Supabase
 * projects cannot be joined, so every cross-app write is a one-way mirror
 * that has to record what it did on this side — here, `website_review_id`
 * and `publish_error` — or a failure looks exactly like a success.
 *
 * Nothing is ever hard-deleted on the far side. Unpublishing sets the
 * website row's status back to 'rejected', the same rule the careers sync
 * follows for vacancies.
 */

export type PublishResult =
  | { ok: true; websiteReviewId: string }
  | { ok: false; error: string };

/** A review the client agreed we could use publicly. */
type PublishableReview = {
  id: string;
  rating: number | null;
  headline: string | null;
  body: string | null;
  client_name: string | null;
  publishable: boolean;
  status: string;
  website_review_id: string | null;
};

function validate(review: PublishableReview): string | null {
  if (review.status !== "submitted") return "That review hasn't been submitted yet.";
  // Consent is given, never assumed — publishable defaults to false.
  if (!review.publishable) {
    return "The client didn't agree to this being used publicly.";
  }
  if (!review.body?.trim()) return "There's nothing to publish.";
  return null;
}

/**
 * Put a review on the website, or update the one already there.
 *
 * Keyed by `website_review_id`, so publishing twice edits one row rather than
 * making two. The website's own review flow mints a `token` per row and marks
 * it used when the client fills the form there — ours arrives already filled,
 * so it carries a token that is used from the start.
 */
export async function publishReview(
  db: DB,
  reviewId: string,
  opts: { company?: string | null } = {},
): Promise<PublishResult> {
  const { data: review } = await db
    .from("project_reviews")
    .select(
      "id, rating, headline, body, client_name, publishable, status, website_review_id",
    )
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) return { ok: false, error: "Review not found." };

  const problem = validate(review as PublishableReview);
  if (problem) return { ok: false, error: problem };

  const row = {
    client_name: review.client_name?.trim() || "A client",
    client_company: opts.company?.trim() || null,
    rating: review.rating ?? 5,
    // The headline is ours to shape; the words are theirs.
    content: [review.headline?.trim(), review.body?.trim()]
      .filter(Boolean)
      .join("\n\n"),
    status: "approved",
    token_used: true,
  };

  try {
    const website = createWebsiteClient();

    let websiteReviewId = review.website_review_id;
    if (websiteReviewId) {
      const { error } = await website
        .from("client_reviews")
        .update(row)
        .eq("id", websiteReviewId);
      if (error) throw new Error(error.message);
    } else {
      const { data, error } = await website
        .from("client_reviews")
        // The website's schema mints its own token; ours is already answered.
        .insert({ ...row, token: crypto.randomUUID() })
        .select("id")
        .single();
      if (error || !data) throw new Error(error?.message ?? "Insert failed.");
      websiteReviewId = data.id as string;
    }

    await db
      .from("project_reviews")
      .update({
        publish_status: "published",
        published_at: new Date().toISOString(),
        website_review_id: websiteReviewId,
        publish_error: null,
      })
      .eq("id", review.id);

    // T5.3 — the only writer of the website's reviews leaves a line.
    await logSystemWrite(db, {
      job: "reviews",
      table: "project_reviews",
      rowId: review.id,
      action: "published",
      summary: `Review by ${row.client_name} published to the website`,
      meta: { website_review_id: websiteReviewId, rating: row.rating },
    });

    return { ok: true, websiteReviewId: websiteReviewId! };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Could not reach the website.";
    // Record the failure on our side: a publish that silently didn't happen
    // is worse than one that visibly didn't.
    await db
      .from("project_reviews")
      .update({ publish_status: "failed", publish_error: error })
      .eq("id", review.id);
    return { ok: false, error };
  }
}

/**
 * Take a review down.
 *
 * Sets the website row to 'rejected' rather than deleting it — the same rule
 * the careers sync follows, and for the same reason: a hard delete on the far
 * side is unrecoverable from here, and rows there may have relations we
 * cannot see.
 */
export async function unpublishReview(
  db: DB,
  reviewId: string,
): Promise<PublishResult | { ok: true; websiteReviewId: null }> {
  const { data: review } = await db
    .from("project_reviews")
    .select("id, website_review_id")
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) return { ok: false, error: "Review not found." };

  if (!review.website_review_id) {
    await db
      .from("project_reviews")
      .update({ publish_status: "unpublished", publish_error: null })
      .eq("id", review.id);
    return { ok: true, websiteReviewId: null };
  }

  try {
    const website = createWebsiteClient();
    const { error } = await website
      .from("client_reviews")
      .update({ status: "rejected" })
      .eq("id", review.website_review_id);
    if (error) throw new Error(error.message);

    await db
      .from("project_reviews")
      .update({
        publish_status: "unpublished",
        published_at: null,
        publish_error: null,
      })
      .eq("id", review.id);

    return { ok: true, websiteReviewId: review.website_review_id };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Could not reach the website.";
    await db
      .from("project_reviews")
      .update({ publish_status: "failed", publish_error: error })
      .eq("id", review.id);
    return { ok: false, error };
  }
}
