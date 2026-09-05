"use server";

import { revalidatePath } from "next/cache";

import { allocateDocumentNumber } from "@/lib/document-number";
import { nextInvoiceNumber } from "@/lib/invoice";
import { reissueInvoice, updateInvoice, voidInvoice } from "@/lib/invoices";
import { createClient } from "@/lib/supabase/server";
import type { InvoiceItem } from "@/lib/database.types";
import type { ActionResult } from "@/lib/types";

/** Two weeks, unless the invoice says otherwise. */
const DEFAULT_DUE_DAYS = 14;

function dueDateFor(invoiceDate: string): string {
  const d = new Date(`${invoiceDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + DEFAULT_DUE_DAYS);
  return d.toISOString().slice(0, 10);
}

export type SaveInvoiceInput = {
  /** 0120 — set when editing a saved invoice: the same row, the same number. */
  id?: string | null;
  invoice_number: string;
  invoice_date: string; // ISO YYYY-MM-DD
  bill_to_name: string;
  bill_to_details: string;
  items: InvoiceItem[];
  grand_total: number;
  due_today: number;
  /** Amount already paid — subtracted from the total to give what's due. */
  amount_paid?: number;
  stamp?: string | null;
  /** Bank account id from INVOICE_BANKS — which account to be paid into. */
  bank_account?: string | null;
  /** 0120 — when it falls due. Defaults to two weeks after the invoice date. */
  due_date?: string | null;
  currency?: string | null;
};

export type SaveInvoiceResult =
  | { ok: true; id: string; invoice_number: string }
  | { ok: false; error: string };

/**
 * Save an invoice (0120: once).
 *
 * With an `id` this edits the saved row in place — the same number, the
 * stamp and paid figures honoured only while nothing is linked to it. Without
 * one it is a NEW invoice, numbered by the counter at insert; the number the
 * form previewed is only used when the counter isn't there yet. Re-stamping
 * used to insert a second row under the same number; that is what the two
 * paths exist to prevent.
 */
export async function saveInvoice(
  input: SaveInvoiceInput,
): Promise<SaveInvoiceResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.invoice_number?.trim()) {
    return { ok: false, error: "Invoice number is required." };
  }
  if (!input.invoice_date) {
    return { ok: false, error: "Invoice date is required." };
  }

  if (input.id) {
    const res = await updateInvoice(supabase, input.id, {
      invoice_date: input.invoice_date,
      bill_to_name: input.bill_to_name.trim(),
      bill_to_details: input.bill_to_details,
      items: input.items,
      grand_total: input.grand_total,
      due_today: input.due_today,
      bank_account: input.bank_account ?? null,
      ...(input.due_date !== undefined ? { due_date: input.due_date } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      stamp: input.stamp ?? null,
      amount_paid:
        typeof input.amount_paid === "number" && input.amount_paid > 0 ? input.amount_paid : null,
    });
    if (!res.ok) return res;
    const { data: row } = await supabase
      .from("invoices")
      .select("invoice_number")
      .eq("id", input.id)
      .maybeSingle();
    revalidatePath("/invoices");
    return { ok: true, id: input.id, invoice_number: row?.invoice_number ?? input.invoice_number };
  }

  const invoiceNumber = await allocateDocumentNumber(supabase, "invoice", async () => {
    // The previewed number, unless something already holds it.
    const typed = input.invoice_number.trim();
    const { data: clash } = await supabase
      .from("invoices")
      .select("id")
      .eq("invoice_number", typed)
      .limit(1);
    if (!clash?.length) return typed;
    const { data } = await supabase.from("invoices").select("invoice_number");
    return nextInvoiceNumber((data ?? []).map((r) => r.invoice_number));
  });

  const { data: inserted, error } = await supabase
    .from("invoices")
    .insert({
      invoice_number: invoiceNumber,
      invoice_date: input.invoice_date,
      bill_to_name: input.bill_to_name.trim(),
      bill_to_details: input.bill_to_details,
      items: input.items,
      grand_total: input.grand_total,
      due_today: input.due_today,
      due_date: input.due_date ?? dueDateFor(input.invoice_date),
      currency: input.currency ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  // Best-effort: persist the "paid" stamp so the saved invoice re-downloads
  // with it. Kept separate from the insert so saving still works if the
  // 0024 migration (which adds the `stamp` column) hasn't been applied yet.
  if (input.stamp && inserted?.id) {
    try {
      await supabase
        .from("invoices")
        .update({ stamp: input.stamp })
        .eq("id", inserted.id);
    } catch {
      // ignore — stamping the saved copy is non-critical
    }
  }

  // Same deal for the chosen bank account (migration 0061). Written on its own
  // so a missing column can't take the stamp down with it — and so an invoice
  // still saves on a database that hasn't run the migration yet.
  if (input.bank_account && inserted?.id) {
    try {
      await supabase
        .from("invoices")
        .update({ bank_account: input.bank_account })
        .eq("id", inserted.id);
    } catch {
      // ignore — the PDF the user just downloaded already has the right bank
    }
  }

  // And the amount already paid (migration 0062). Same best-effort write so a
  // database without the column still saves the invoice; the just-downloaded
  // PDF already shows the deduction regardless.
  if (typeof input.amount_paid === "number" && input.amount_paid > 0 && inserted?.id) {
    try {
      await supabase
        .from("invoices")
        .update({ amount_paid: input.amount_paid })
        .eq("id", inserted.id);
    } catch {
      // ignore — persisting the paid amount is non-critical
    }
  }

  // 0120 — the stamp and the paid figure become a state, once.
  if (inserted?.id) {
    const { reconcileInvoice } = await import("@/lib/invoices");
    await reconcileInvoice(supabase, inserted.id).catch(() => null);
  }

  revalidatePath("/invoices");
  return { ok: true, id: inserted.id, invoice_number: invoiceNumber };
}

/**
 * 0120 — money against a saved invoice, from the Past invoices list.
 * Through recordPayment(), so the payment row, the invoice state, the
 * project's History and the single payment_received all happen at once.
 */
export async function markInvoicePaid(input: {
  id: string;
  amount?: number | null;
  paid_at?: string | null;
  method?: string | null;
  notes?: string | null;
}): Promise<ActionResult<{ status: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, grand_total, paid_amount, status, project_id, currency")
    .eq("id", input.id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "That invoice no longer exists." };
  if (invoice.status === "void") return { ok: false, error: "That invoice is void." };
  if (invoice.status === "paid") return { ok: false, error: "This invoice is already paid." };

  const balance = Math.max(0, Number(invoice.grand_total) - Number(invoice.paid_amount));
  const amount = typeof input.amount === "number" && input.amount > 0 ? input.amount : balance;
  if (amount <= 0) return { ok: false, error: "Nothing is owed on this invoice." };

  const { recordPayment } = await import("@/lib/payments");
  const res = await recordPayment(supabase, {
    source: "team",
    invoiceId: invoice.id,
    projectId: invoice.project_id,
    amount,
    currency: invoice.currency,
    paidAt: input.paid_at,
    method: input.method,
    notes: input.notes,
    actorId: user.id,
  });
  if (!res.ok) return res;

  revalidatePath("/invoices");
  if (invoice.project_id) revalidatePath(`/projects/${invoice.project_id}`);
  return { ok: true, status: res.invoiceStatus ?? "partially_paid" };
}

/** 0120 — withdraw an invoice. Its number stays in history. */
export async function voidInvoiceAction(
  id: string,
  reason: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  const res = await voidInvoice(supabase, id, reason);
  if (!res.ok) return res;
  revalidatePath("/invoices");
  return { ok: true };
}

/** 0120 — the same bill under a fresh number; the old one is voided. */
export async function reissueInvoiceAction(
  id: string,
): Promise<ActionResult<{ invoiceId: string; invoiceNumber: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  const res = await reissueInvoice(supabase, id, { actorId: user.id });
  if (!res.ok) return res;
  revalidatePath("/invoices");
  return { ok: true, invoiceId: res.invoiceId, invoiceNumber: res.invoiceNumber };
}

export async function deleteInvoice(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase.from("invoices").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/invoices");
  return { ok: true };
}
