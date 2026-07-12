import { notFound } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { fireAutomationTrigger } from "@/lib/automation";
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

    // The hottest moment in any deal — they're reading the quote right now.
    const lead = quote.lead_id
      ? (await supabase.from("leads").select("*").eq("id", quote.lead_id).maybeSingle()).data
      : null;
    await fireAutomationTrigger(supabase, {
      trigger: "quote_viewed",
      lead,
      payload: {
        name: quote.customer_name,
        phone: quote.customer_phone,
        email: quote.customer_email,
        quote_id: quote.id,
        quote_number: quote.quote_number,
        amount: `${quote.currency} ${Number(quote.grand_total).toLocaleString()}`,
      },
      triggerKey: `${quote.id}:viewed`,
    });

    // Arm the WhatsApp agent's hot follow-up (~15 min) so it asks "any
    // questions?" while they're still looking — unless an earlier touch
    // is already scheduled.
    if (quote.lead_id) {
      const { data: contact } = await supabase
        .from("wa_contacts")
        .select("id, agent_enabled, do_not_contact, needs_attention, next_followup_at")
        .eq("lead_id", quote.lead_id)
        .maybeSingle();
      if (contact?.agent_enabled && !contact.do_not_contact && !contact.needs_attention) {
        const hot = new Date();
        hot.setMinutes(hot.getMinutes() + 15);
        const hotAt = hot.toISOString();
        if (!contact.next_followup_at || contact.next_followup_at > hotAt) {
          await supabase
            .from("wa_contacts")
            .update({ next_followup_at: hotAt })
            .eq("id", contact.id);
        }
      }
    }
  }

  return <PublicQuote quote={quote as Quote} company={INVOICE_COMPANY} />;
}
