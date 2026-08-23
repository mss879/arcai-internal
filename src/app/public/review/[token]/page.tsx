import { notFound } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import type { PortalLanguage } from "@/lib/types";

import { ReviewForm } from "./review-form";

export const metadata = {
  title: "How did we do? — ARC AI",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The review page (0094).
 *
 * Its own token and its own route on purpose: asking a client for praise must
 * not hand out access to the project, and someone about to say something kind
 * shouldn't be dropped onto a page about outstanding assets and a balance due.
 *
 * No passcode. The barrier to leaving a review should be zero — a code here
 * would cost more reviews than it could ever protect.
 */
export default async function PublicReviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isUuid(token)) notFound();

  const supabase = createAdminClient();

  const { data: review } = await supabase
    .from("project_reviews")
    .select("id, status, rating, headline, body, client_name, project_id")
    .eq("share_token", token)
    .maybeSingle();

  if (!review) notFound();

  // Only the project's NAME crosses over — nothing about its money or state.
  const { data: project } = await supabase
    .from("projects")
    .select("name, portal_language")
    .eq("id", review.project_id)
    .maybeSingle();

  return (
    <ReviewForm
      token={token}
      projectName={project?.name ?? "your project"}
      clientName={review.client_name}
      language={(project?.portal_language ?? "en") as PortalLanguage}
      alreadyDone={review.status === "submitted"}
      existing={
        review.status === "submitted"
          ? {
              rating: review.rating ?? 0,
              headline: review.headline,
              body: review.body,
            }
          : null
      }
    />
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
