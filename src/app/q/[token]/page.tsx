import { notFound } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { INVOICE_COMPANY } from "@/lib/invoice";
import type { Quote } from "@/lib/types";

import { PublicQuote } from "./public-quote";

export const metadata = { title: "Quotation — ARC AI" };

/**
 * Public quotation page (share link). No auth — access is the unguessable
 * token. Marks the quote as viewed on first open.
 */
export default async function QuotePublicPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("*")
    .eq("share_token", token)
    .maybeSingle();
  if (!quote) notFound();

  // First open by the client: draft/sent → viewed.
  if (["sent", "draft"].includes(quote.status)) {
    await supabase
      .from("quotes")
      .update({
        status: "viewed",
        viewed_at: quote.viewed_at ?? new Date().toISOString(),
      })
      .eq("id", quote.id);
    quote.status = "viewed";
  }

  return <PublicQuote quote={quote as Quote} company={INVOICE_COMPANY} />;
}
