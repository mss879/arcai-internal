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
