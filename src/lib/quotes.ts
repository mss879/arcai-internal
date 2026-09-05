import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;
type QuoteRow = Database["public"]["Tables"]["quotes"]["Row"];

export type InvoiceFromQuote =
  | {
      ok: true;
      invoiceId: string;
      invoiceNumber: string;
      dueToday: number;
      projectId: string | null;
    }
  | { ok: false; error: string };

/**
 * A quote becomes an invoice (0112).
 *
 * Two places did this — the Quotes tab's button and the
 * `convert_quote_to_invoice` automation step — and both dropped the client,
 * the lead and the currency on the floor, so an invoice never knew who it
 * billed beyond a name. Both now come through here. The caller still owns
 * the invoice NUMBER (the two paths number differently, on purpose) and may
 * dictate what is due today; otherwise it is the project's deposit share
 * when a project with a deposit gate already exists for this quote, else
 * the whole amount.
 */
export async function createInvoiceFromQuote(
  supabase: DB,
  quote: QuoteRow,
  opts: { invoiceNumber: string; actorId: string | null; dueToday?: number },
): Promise<InvoiceFromQuote> {
  if (quote.invoice_id) {
    return { ok: false, error: "This quote was already converted to an invoice." };
  }
  const grandTotal = Number(quote.grand_total) || 0;

  // The project this quote produced, if the chain already reached one.
  const { data: project } = await supabase
    .from("projects")
    .select("id, deposit_required_percent")
    .eq("quote_id", quote.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const percent = Number(project?.deposit_required_percent) || 0;
  const dueToday =
    typeof opts.dueToday === "number"
      ? opts.dueToday
      : percent > 0
        ? Math.round((grandTotal * percent) / 100)
        : grandTotal;

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      invoice_number: opts.invoiceNumber,
      invoice_date: new Date().toISOString().slice(0, 10),
      bill_to_name: quote.customer_name,
      bill_to_details: [quote.customer_email, quote.customer_phone]
        .filter(Boolean)
        .join("\n"),
      items: quote.items,
      grand_total: grandTotal,
      due_today: dueToday,
      recipient_email: quote.customer_email,
      // 0112 — who this invoice bills, and in what.
      client_id: quote.client_id,
      lead_id: quote.lead_id,
      currency: quote.currency || null,
      project_id: project?.id ?? null,
      created_by: opts.actorId,
    })
    .select("id")
    .single();
  if (error || !invoice) {
    return { ok: false, error: error?.message ?? "Could not create the invoice." };
  }

  await supabase.from("quotes").update({ invoice_id: invoice.id }).eq("id", quote.id);

  return {
    ok: true,
    invoiceId: invoice.id,
    invoiceNumber: opts.invoiceNumber,
    dueToday,
    projectId: project?.id ?? null,
  };
}

/**
 * A signed proposal becomes a quote (0117).
 *
 * The chain used to stop at the proposal: somebody read the signed document
 * and retyped its total into a quote, which is both a delay and a place for a
 * figure to change. The proposal already carries a priced selection, so the
 * quote is one line — the agreed total — with the proposal's own line items
 * carried across where it has them.
 *
 * Idempotent: a proposal that already has a quote returns the existing one
 * rather than making a second.
 */
export async function createQuoteFromProposal(
  supabase: DB,
  proposalId: string,
  opts: { actorId?: string | null } = {},
): Promise<{ ok: true; quoteId: string } | { ok: false; error: string }> {
  const { data: proposal } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", proposalId)
    .maybeSingle();
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.quote_id) {
    return { ok: true, quoteId: proposal.quote_id };
  }

  const lead = proposal.lead_id
    ? (
        await supabase
          .from("leads")
          .select("contact_name, contact_email, contact_phone")
          .eq("id", proposal.lead_id)
          .maybeSingle()
      ).data
    : null;

  const quoteNumber = await nextQuoteNumber(supabase);

  const grandTotal = Number(proposal.grand_total) || 0;
  const { data: quote, error } = await supabase
    .from("quotes")
    .insert({
      quote_number: quoteNumber,
      title: proposal.project_name,
      customer_name: proposal.client_name,
      customer_email: lead?.contact_email ?? null,
      customer_phone: lead?.contact_phone ?? null,
      currency: proposal.currency || "LKR",
      grand_total: grandTotal,
      items: [
        {
          item: proposal.project_name,
          description: "As set out in the signed proposal.",
          qty: "1",
          rate: String(grandTotal),
          total: grandTotal,
        },
      ],
      // The proposal was the thing that was signed, so the quote inherits
      // that state rather than pretending to be a fresh draft awaiting an
      // answer somebody has already given.
      status: "accepted",
      accepted_at: proposal.accepted_at ?? new Date().toISOString(),
      signed_name: proposal.signed_name,
      client_id: proposal.client_id,
      lead_id: proposal.lead_id,
      created_by: opts.actorId ?? null,
    })
    .select("id")
    .single();
  if (error || !quote) {
    return { ok: false, error: error?.message ?? "Could not create the quote." };
  }

  await supabase
    .from("proposals")
    .update({ quote_id: quote.id })
    .eq("id", proposal.id);

  return { ok: true, quoteId: quote.id };
}

/**
 * The next quote number, Q-YYYY-NNN (0120).
 *
 * Allocated by next_document_number() under a row lock; the year rolls the
 * count over. Before the counter exists it falls back to the old rule —
 * row count plus one — which is the rule that once produced two Q-2026-014s.
 */
export async function nextQuoteNumber(supabase: DB): Promise<string> {
  const { allocateDocumentNumber } = await import("@/lib/document-number");
  return allocateDocumentNumber(supabase, "quote", async () => {
    const { count } = await supabase
      .from("quotes")
      .select("*", { count: "exact", head: true });
    return `Q-${new Date().getFullYear()}-${String((count ?? 0) + 1).padStart(3, "0")}`;
  });
}

/**
 * The next invoice number, "#00205" (0120). Same contract as nextQuoteNumber.
 */
export async function nextInvoiceNumberFor(supabase: DB): Promise<string> {
  const { allocateDocumentNumber } = await import("@/lib/document-number");
  const { nextInvoiceNumber } = await import("@/lib/invoice");
  return allocateDocumentNumber(supabase, "invoice", async () => {
    const { data } = await supabase.from("invoices").select("invoice_number");
    return nextInvoiceNumber((data ?? []).map((r) => r.invoice_number));
  });
}
