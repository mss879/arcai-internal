"use server";

import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionResult } from "@/lib/types";

/**
 * Submitting a review (0094).
 *
 * Public and unauthenticated. The token is the whole authorisation, and it
 * only ever addresses one review row — a review can't be written against a
 * project the token doesn't name, and an already-answered one can't be
 * overwritten by someone re-opening the link later.
 */
export async function submitReview(
  token: string,
  input: {
    rating: number;
    headline?: string;
    body?: string;
    publishable: boolean;
    name?: string;
  },
): Promise<ActionResult> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return { ok: false, error: "This link isn't valid." };
  }
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    return { ok: false, error: "Pick a rating first." };
  }

  const supabase = createAdminClient();

  const { data: review } = await supabase
    .from("project_reviews")
    .select("id, project_id, status, client_name")
    .eq("share_token", token)
    .maybeSingle();
  if (!review) return { ok: false, error: "This link isn't valid." };
  if (review.status === "submitted") {
    return { ok: false, error: "Thanks — you've already sent this one." };
  }

  const { error } = await supabase
    .from("project_reviews")
    .update({
      status: "submitted",
      rating: input.rating,
      headline: input.headline?.trim()?.slice(0, 140) || null,
      body: input.body?.trim()?.slice(0, 4000) || null,
      publishable: input.publishable,
      client_name: input.name?.trim() || review.client_name,
      submitted_at: new Date().toISOString(),
    })
    .eq("id", review.id);
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  const { notifyEveryone } = await import("@/lib/wa-agent");

  await logDeliveryEvent(
    supabase,
    review.project_id,
    "review_received",
    `${input.rating}/5${input.headline?.trim() ? ` — ${input.headline.trim()}` : ""}`,
    "portal",
  );

  // Worth telling the team either way: a five is something to publish, and a
  // two is something to fix before it turns into a public review elsewhere.
  await notifyEveryone(supabase, {
    title:
      input.rating >= 4
        ? `${input.rating}★ review in 🎉`
        : `${input.rating}★ review — worth a look`,
    body: input.headline?.trim() || input.body?.trim()?.slice(0, 120) || "No words left.",
    link: `/projects/${review.project_id}`,
  });

  revalidatePath(`/public/review/${token}`);
  return { ok: true };
}
