import { notFound } from "next/navigation";

import { INVOICE_COMPANY } from "@/lib/invoice";
import { createAdminClient } from "@/lib/supabase/admin";

import { ContentApproval } from "./content-approval";

export const metadata = { title: "Your post — ARC AI" };

/**
 * Where a client says yes to a post (0118).
 *
 * Approval used to happen in WhatsApp, in screenshots, and was lost — so
 * "did they approve this?" was answered from memory, and a post occasionally
 * went out that nobody had actually cleared.
 *
 * Public, under `/public` like the project portal, and read with hand-picked
 * columns: a carousel row carries internal analysis and the other design
 * option nobody chose.
 */
export default async function ContentApprovalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: post } = await supabase
    .from("carousel_posts")
    .select(
      "id, topic, caption, hashtags, scheduled_for, chosen_option_id, client_status, client_feedback, client_id",
    )
    .eq("approval_token", token)
    .maybeSingle();
  if (!post) notFound();
  // A post nobody has sent yet is not a page anybody should be reading.
  if (post.client_status === "not_sent") notFound();

  // Only the chosen design — the option they didn't get is our business.
  // Slides live as JSON on the option row, not as their own table.
  const { data: option } = post.chosen_option_id
    ? await supabase
        .from("carousel_options")
        .select("slides")
        .eq("id", post.chosen_option_id)
        .maybeSingle()
    : { data: null };
  const slides = (option?.slides ?? [])
    .filter((s) => s.image_url)
    .sort((a, b) => a.index - b.index);

  const client = post.client_id
    ? (
        await supabase
          .from("clients")
          .select("name")
          .eq("id", post.client_id)
          .maybeSingle()
      ).data
    : null;

  return (
    <ContentApproval
      token={token}
      topic={post.topic}
      caption={post.caption}
      hashtags={post.hashtags}
      scheduledFor={post.scheduled_for}
      clientName={client?.name ?? null}
      status={post.client_status}
      feedback={post.client_feedback}
      slides={slides.map((s) => ({ id: String(s.index), url: s.image_url! }))}
      company={INVOICE_COMPANY}
    />
  );
}
