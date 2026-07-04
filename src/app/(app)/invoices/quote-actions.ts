"use server";

import { revalidatePath } from "next/cache";

import { sendGenericEmail } from "@/lib/email";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, Quote } from "@/lib/types";
import type { InvoiceItem } from "@/lib/database.types";

export type QuoteInput = {
  id?: string;
  title: string;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  lead_id?: string | null;
  client_id?: string | null;
  items: InvoiceItem[];
  discount: number;
  tax_rate: number;
  currency: string;
  valid_until?: string | null;
  notes?: string | null;
  terms?: string | null;
};

function computeTotals(input: Pick<QuoteInput, "items" | "discount" | "tax_rate">) {
  const subtotal = input.items.reduce((sum, it) => sum + (Number(it.total) || 0), 0);
  const discounted = Math.max(0, subtotal - (Number(input.discount) || 0));
  const taxAmount = (discounted * (Number(input.tax_rate) || 0)) / 100;
  return {
    subtotal,
    tax_amount: taxAmount,
    grand_total: discounted + taxAmount,
  };
}

export async function saveQuote(
  input: QuoteInput,
): Promise<ActionResult<{ quote: Quote }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.customer_name.trim())
    return { ok: false, error: "Customer name is required." };
  if (input.items.length === 0)
    return { ok: false, error: "Add at least one line item." };

  const totals = computeTotals(input);
  const base = {
    title: input.title.trim(),
    customer_name: input.customer_name.trim(),
    customer_email: input.customer_email?.trim() || null,
    customer_phone: input.customer_phone?.trim() || null,
    lead_id: input.lead_id || null,
    client_id: input.client_id || null,
    items: input.items,
    discount: Number(input.discount) || 0,
    tax_rate: Number(input.tax_rate) || 0,
    currency: input.currency || "LKR",
    valid_until: input.valid_until || null,
    notes: input.notes?.trim() || null,
    terms: input.terms?.trim() || null,
    ...totals,
  };

  if (input.id) {
    const { data, error } = await supabase
      .from("quotes")
      .update(base)
      .eq("id", input.id)
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };
    revalidatePath("/invoices");
    return { ok: true, quote: data as Quote };
  }

  const { count } = await supabase
    .from("quotes")
    .select("*", { count: "exact", head: true });
  const quoteNumber = `Q-${new Date().getFullYear()}-${String((count ?? 0) + 1).padStart(3, "0")}`;

  const { data, error } = await supabase
    .from("quotes")
    .insert({ ...base, quote_number: quoteNumber })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/invoices");
  return { ok: true, quote: data as Quote };
}

export async function deleteQuote(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("quotes").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/invoices");
  return { ok: true };
}

/** Mark sent and (when the customer has an email) send the share link. */
export async function sendQuote(
  id: string,
  shareUrl: string,
): Promise<ActionResult<{ emailed: boolean }>> {
  const supabase = await createClient();
  const { data: quote } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", id)
    .single();
  if (!quote) return { ok: false, error: "Quote not found." };

  let emailed = false;
  if (quote.customer_email) {
    const res = await sendGenericEmail({
      to: quote.customer_email,
      subject: `Quotation ${quote.quote_number} from ARC AI`,
      body: `Hi ${quote.customer_name},\nHere is your quotation${quote.title ? ` for ${quote.title}` : ""} — total ${quote.currency} ${Number(quote.grand_total).toLocaleString()}.\nOpen the link below to review and accept it online. It only takes a minute.`,
      cta: { href: shareUrl, label: "View & accept quotation" },
    });
    emailed = res.sent;
    if (!res.sent && res.error && !res.error.includes("not configured")) {
      return { ok: false, error: res.error };
    }
  }

  const { error } = await supabase
    .from("quotes")
    .update({
      status: quote.status === "draft" ? "sent" : quote.status,
      sent_at: quote.sent_at ?? new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/invoices");
  return { ok: true, emailed };
}

/** Convert an accepted quote into an invoice (once). */
export async function convertQuoteToInvoice(
  id: string,
): Promise<ActionResult<{ invoiceId: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: quote } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", id)
    .single();
  if (!quote) return { ok: false, error: "Quote not found." };
  if (quote.invoice_id)
    return { ok: false, error: "This quote was already converted to an invoice." };

  const { count } = await supabase
    .from("invoices")
    .select("*", { count: "exact", head: true });
  const invoiceNumber = `${String((count ?? 0) + 1).padStart(4, "0")}`;

  const billToDetails = [
    quote.customer_name,
    quote.customer_email,
    quote.customer_phone,
  ]
    .filter(Boolean)
    .join("\n");

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      invoice_number: invoiceNumber,
      invoice_date: new Date().toISOString().slice(0, 10),
      bill_to_name: quote.customer_name,
      bill_to_details: billToDetails,
      items: quote.items,
      grand_total: quote.grand_total,
      due_today: quote.grand_total,
      recipient_email: quote.customer_email,
    })
    .select("id")
    .single();
  if (error || !invoice) {
    return { ok: false, error: error?.message ?? "Could not create the invoice." };
  }

  await supabase.from("quotes").update({ invoice_id: invoice.id }).eq("id", id);

  revalidatePath("/invoices");
  return { ok: true, invoiceId: invoice.id };
}
