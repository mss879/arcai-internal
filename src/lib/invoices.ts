import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, InvoiceItem, InvoiceStatus } from "@/lib/database.types";
import { allocateDocumentNumber } from "@/lib/document-number";
import { nextInvoiceNumber } from "@/lib/invoice";
import { invoiceStatusFor } from "@/lib/projects";
import { logSystemWrite } from "@/lib/system-audit";

type DB = SupabaseClient<Database>;

/**
 * An invoice's state, owned here (0120).
 *
 * Until now "paid" was a stamp image somebody picked from a dropdown, and
 * saving an invoice always INSERTed — so adding the stamp made a second row
 * with the same number. This module is the only writer of `status`,
 * `paid_amount`, `paid_at`, `voided_at` and `reissued_from_id`:
 *
 *   reconcileInvoice()  reads what has been paid against the invoice and
 *                       writes the state. Called by recordPayment() and by
 *                       anything that changes a linked payment.
 *   updateInvoice()     edits the words and figures of a live invoice in
 *                       place — the same row, the same number.
 *   voidInvoice()       withdraws one, with a reason. Its number is kept in
 *                       history and never reused.
 *   reissueInvoice()    raises a fresh number for the same bill and voids
 *                       the old one as "re-issued as #…".
 *
 * The stamp is kept in step for the PDF, which still prints it; the status
 * is what everything else reads.
 */

export type ReconcileResult = {
  status: InvoiceStatus;
  paidAmount: number;
  grandTotal: number;
  balance: number;
};

/**
 * Work out what an invoice has received and write its state.
 *
 * Three ledgers can settle an invoice — the project's own payments, Payments-
 * board rows and instalments — through their `invoice_id`. When nothing is
 * linked, the legacy `amount_paid` snapshot (or a PAYMENT RECEIVED stamp)
 * stands in, so an invoice from before 0120 keeps reading the way it did.
 */
export async function reconcileInvoice(db: DB, invoiceId: string): Promise<ReconcileResult | null> {
  const { data: invoice } = await db
    .from("invoices")
    .select("id, grand_total, amount_paid, stamp, status, sent_at, shared_at, paid_at")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return null;
  const grandTotal = Number(invoice.grand_total) || 0;

  if (invoice.status === "void") {
    return { status: "void", paidAmount: Number(invoice.amount_paid) || 0, grandTotal, balance: 0 };
  }

  const [ownRes, boardRes, instRes, recurRes] = await Promise.all([
    db.from("payments").select("amount, status").eq("invoice_id", invoiceId),
    db.from("company_payments").select("price_lkr, is_paid").eq("invoice_id", invoiceId),
    db.from("payment_installments").select("amount, status").eq("invoice_id", invoiceId),
    // A recurring month IS the money for monthlyInflows(); it settles its
    // own invoice the same way an instalment does, with no payments row.
    db
      .from("recurring_income_entries")
      .select("amount, status")
      .eq("invoice_id", invoiceId)
      .then((r) => r, () => ({ data: null })),
  ]);

  const linked =
    (ownRes.data ?? []).length +
    (boardRes.data ?? []).length +
    (instRes.data ?? []).length +
    (recurRes.data ?? []).length;

  let paid: number;
  if (linked > 0) {
    paid =
      (ownRes.data ?? [])
        .filter((p) => (p.status ?? "paid") === "paid")
        .reduce((s, p) => s + (Number(p.amount) || 0), 0) +
      (boardRes.data ?? [])
        .filter((p) => p.is_paid)
        .reduce((s, p) => s + (Number(p.price_lkr) || 0), 0) +
      (instRes.data ?? [])
        .filter((i) => i.status === "paid")
        .reduce((s, i) => s + (Number(i.amount) || 0), 0) +
      (recurRes.data ?? [])
        .filter((e) => e.status === "received")
        .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  } else if (invoice.stamp === "payment_received") {
    paid = grandTotal;
  } else {
    paid = Number(invoice.amount_paid) || 0;
  }

  const unpaid = invoice.status === "sent" || invoice.sent_at || invoice.shared_at ? "sent" : "issued";
  const status = invoiceStatusFor(paid, grandTotal, unpaid);
  const now = new Date().toISOString();

  // The stamp follows the state, but only its two automatic values: a stamp
  // somebody chose by hand on an invoice with nothing linked is left alone.
  const stamp =
    status === "paid"
      ? "payment_received"
      : status === "partially_paid"
        ? "deposit_paid"
        : invoice.stamp === "payment_received" || invoice.stamp === "deposit_paid"
          ? null
          : invoice.stamp;

  await db
    .from("invoices")
    .update({
      status,
      paid_amount: paid,
      paid_at: status === "paid" ? (invoice.paid_at ?? now) : status === "partially_paid" ? (invoice.paid_at ?? now) : null,
      // The legacy snapshot the PDF's "paid" line reads.
      amount_paid: paid > 0 ? paid : null,
      stamp,
    })
    .eq("id", invoiceId);

  return { status, paidAmount: paid, grandTotal, balance: Math.max(0, grandTotal - paid) };
}

export type InvoicePatch = {
  invoice_date?: string;
  bill_to_name?: string;
  bill_to_details?: string;
  items?: InvoiceItem[];
  grand_total?: number;
  due_today?: number;
  bank_account?: string | null;
  due_date?: string | null;
  currency?: string | null;
  recipient_email?: string | null;
  /** A hand-picked stamp; honoured only when nothing is linked. */
  stamp?: string | null;
  /** The legacy "already paid" figure from the form; honoured only when nothing is linked. */
  amount_paid?: number | null;
};

/** Edit a live invoice in place. The number never changes here. */
export async function updateInvoice(
  db: DB,
  invoiceId: string,
  patch: InvoicePatch,
): Promise<{ ok: true; status: InvoiceStatus } | { ok: false; error: string }> {
  const { data: existing } = await db
    .from("invoices")
    .select("id, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "That invoice no longer exists." };
  if (existing.status === "void") {
    return { ok: false, error: "This invoice is void — re-issue it instead of editing it." };
  }

  const { error } = await db
    .from("invoices")
    .update({
      ...(patch.invoice_date !== undefined ? { invoice_date: patch.invoice_date } : {}),
      ...(patch.bill_to_name !== undefined ? { bill_to_name: patch.bill_to_name } : {}),
      ...(patch.bill_to_details !== undefined ? { bill_to_details: patch.bill_to_details } : {}),
      ...(patch.items !== undefined ? { items: patch.items } : {}),
      ...(patch.grand_total !== undefined ? { grand_total: patch.grand_total } : {}),
      ...(patch.due_today !== undefined ? { due_today: patch.due_today } : {}),
      ...(patch.bank_account !== undefined ? { bank_account: patch.bank_account } : {}),
      ...(patch.due_date !== undefined ? { due_date: patch.due_date } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.recipient_email !== undefined ? { recipient_email: patch.recipient_email } : {}),
      ...(patch.stamp !== undefined ? { stamp: patch.stamp } : {}),
      ...(patch.amount_paid !== undefined ? { amount_paid: patch.amount_paid } : {}),
    })
    .eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };

  const reconciled = await reconcileInvoice(db, invoiceId);
  return { ok: true, status: reconciled?.status ?? existing.status };
}

/** Withdraw an invoice. Its number stays in history. */
export async function voidInvoice(
  db: DB,
  invoiceId: string,
  reason: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: existing } = await db
    .from("invoices")
    .select("id, status, paid_amount")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "That invoice no longer exists." };
  if (existing.status === "void") return { ok: true };
  if (Number(existing.paid_amount) > 0) {
    return {
      ok: false,
      error: "Money has been recorded against this invoice. Re-issue it, or move the payments first.",
    };
  }
  const { error } = await db
    .from("invoices")
    .update({
      status: "void",
      voided_at: new Date().toISOString(),
      void_reason: reason?.trim() || null,
    })
    .eq("id", invoiceId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Raise the same bill again under a new number, and void the old one.
 *
 * Linked payments move to the new invoice, so nothing already received is
 * lost; the old row keeps its number, its date and a note saying what
 * replaced it.
 */
export async function reissueInvoice(
  db: DB,
  invoiceId: string,
  opts: { actorId: string | null; patch?: InvoicePatch },
): Promise<{ ok: true; invoiceId: string; invoiceNumber: string } | { ok: false; error: string }> {
  const { data: old } = await db.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  if (!old) return { ok: false, error: "That invoice no longer exists." };
  if (old.status === "void" && old.void_reason?.startsWith("Re-issued as")) {
    return { ok: false, error: "This invoice was already re-issued." };
  }

  const number = await allocateDocumentNumber(db, "invoice", async () => {
    const { data } = await db.from("invoices").select("invoice_number");
    return nextInvoiceNumber((data ?? []).map((r) => r.invoice_number));
  });

  const patch = opts.patch ?? {};
  const { data: created, error } = await db
    .from("invoices")
    .insert({
      invoice_number: number,
      invoice_date: patch.invoice_date ?? new Date().toISOString().slice(0, 10),
      bill_to_name: patch.bill_to_name ?? old.bill_to_name,
      bill_to_details: patch.bill_to_details ?? old.bill_to_details,
      items: patch.items ?? old.items,
      grand_total: patch.grand_total ?? Number(old.grand_total),
      due_today: patch.due_today ?? Number(old.due_today),
      bank_account: patch.bank_account !== undefined ? patch.bank_account : old.bank_account,
      recipient_email: old.recipient_email,
      project_id: old.project_id,
      client_id: old.client_id,
      lead_id: old.lead_id,
      currency: patch.currency !== undefined ? patch.currency : old.currency,
      due_date: patch.due_date !== undefined ? patch.due_date : old.due_date,
      reissued_from_id: old.id,
      created_by: opts.actorId,
    })
    .select("id")
    .single();
  if (error || !created) return { ok: false, error: error?.message ?? "Could not re-issue." };

  // Money follows the bill.
  await Promise.all([
    db.from("payments").update({ invoice_id: created.id }).eq("invoice_id", old.id),
    db.from("company_payments").update({ invoice_id: created.id }).eq("invoice_id", old.id),
    db.from("payment_installments").update({ invoice_id: created.id }).eq("invoice_id", old.id),
  ]);

  await db
    .from("invoices")
    .update({
      status: "void",
      voided_at: new Date().toISOString(),
      void_reason: `Re-issued as ${number}`,
    })
    .eq("id", old.id);

  await reconcileInvoice(db, created.id);
  return { ok: true, invoiceId: created.id, invoiceNumber: number };
}

/** The open invoices on a project, oldest first — what a payment settles. */
export async function openInvoicesForProject(
  db: DB,
  projectId: string,
): Promise<{ id: string; grand_total: number; paid_amount: number; invoice_date: string }[]> {
  const { data } = await db
    .from("invoices")
    .select("id, grand_total, paid_amount, invoice_date, status")
    .eq("project_id", projectId)
    .in("status", ["issued", "sent", "partially_paid"])
    .order("invoice_date", { ascending: true })
    .limit(50);
  return (data ?? []).map((i) => ({
    id: i.id,
    grand_total: Number(i.grand_total) || 0,
    paid_amount: Number(i.paid_amount) || 0,
    invoice_date: i.invoice_date,
  }));
}

/**
 * Raise the invoice for one recurring month (0120).
 *
 * A standing arrangement used to generate a row on the Recurring tab and
 * nothing the client could pay against. With `auto_invoice` on, each month's
 * entry raises its own numbered invoice — the label (or the arrangement's own
 * line item), the month's amount, due on the entry's date — and emails it
 * when the client has an address. Idempotent: an entry that already has an
 * invoice returns it.
 */
export async function createRecurringInvoice(
  db: DB,
  entryId: string,
  opts: { actorId?: string | null; email?: boolean } = {},
): Promise<
  | { ok: true; invoiceId: string; invoiceNumber: string; emailed: boolean; created: boolean }
  | { ok: false; error: string }
> {
  const { data: entry } = await db
    .from("recurring_income_entries")
    .select("id, income_id, period, due_date, amount, currency, status, invoice_id")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) return { ok: false, error: "That month no longer exists." };
  if (entry.invoice_id) {
    const { data: existing } = await db
      .from("invoices")
      .select("id, invoice_number")
      .eq("id", entry.invoice_id)
      .maybeSingle();
    if (existing) {
      return { ok: true, invoiceId: existing.id, invoiceNumber: existing.invoice_number, emailed: false, created: false };
    }
  }

  const { data: income } = await db
    .from("recurring_income")
    .select("id, label, client_id, project_id, category, invoice_item, client:clients(name, company, email, phone)")
    .eq("id", entry.income_id)
    .maybeSingle();
  if (!income) return { ok: false, error: "The arrangement no longer exists." };
  const client = income.client as unknown as {
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
  } | null;

  const monthLabel = new Date(`${entry.period}T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const amount = Number(entry.amount) || 0;
  const item = income.invoice_item;
  const items: InvoiceItem[] = [
    {
      item: item?.item?.trim() || income.label,
      description: item?.description?.trim() || `${monthLabel} — ${income.category}`,
      qty: "1",
      rate: String(amount),
      total: amount,
    },
  ];

  const number = await allocateDocumentNumber(db, "invoice", async () => {
    const { data } = await db.from("invoices").select("invoice_number");
    return nextInvoiceNumber((data ?? []).map((r) => r.invoice_number));
  });

  const { data: invoice, error } = await db
    .from("invoices")
    .insert({
      invoice_number: number,
      invoice_date: new Date().toISOString().slice(0, 10),
      bill_to_name: client?.name ?? income.label,
      bill_to_details: [client?.company, client?.email, client?.phone].filter(Boolean).join("\n"),
      items,
      grand_total: amount,
      due_today: amount,
      due_date: entry.due_date,
      currency: entry.currency || null,
      client_id: income.client_id,
      // Attribution only, like the arrangement itself: the project's
      // received figure never counts a hosting month.
      project_id: null,
      recipient_email: client?.email ?? null,
      created_by: opts.actorId ?? null,
    })
    .select("id")
    .single();
  if (error || !invoice) return { ok: false, error: error?.message ?? "Could not raise the invoice." };

  await db
    .from("recurring_income_entries")
    .update({ invoice_id: invoice.id })
    .eq("id", entry.id);

  // T5.3 — an invoice the tick raised is exactly the kind of write that
  // needs a line to point at.
  await logSystemWrite(db, {
    job: "recurringIncome",
    actor: opts.actorId ? `user:${opts.actorId}` : null,
    table: "invoices",
    rowId: invoice.id,
    action: "created",
    summary: `Invoice ${number} raised for ${income.label} — ${monthLabel}${client?.name ? ` (${client.name})` : ""}`,
    meta: { entry_id: entry.id, income_id: income.id, amount, currency: entry.currency || null },
  });

  let emailed = false;
  if (opts.email !== false && client?.email) {
    try {
      const { sendAndLogEmail } = await import("@/lib/email-outbox");
      const { invoiceEmailData } = await import("@/lib/invoice");
      const { data: row } = await db.from("invoices").select("*").eq("id", invoice.id).single();
      if (row) {
        const res = await sendAndLogEmail(db, {
          to: client.email,
          kind: "invoice",
          actor: opts.actorId ? "team" : "system",
          sentBy: opts.actorId ?? null,
          invoiceId: invoice.id,
          clientId: income.client_id,
          message: {
            transport: "invoice",
            note: `Your ${income.label} invoice for ${monthLabel} is attached. It's due on ${entry.due_date}.`,
            invoice: invoiceEmailData(row),
          },
        });
        emailed = res.sent;
        if (res.sent) {
          await db
            .from("invoices")
            .update({ recipient_email: client.email, sent_at: new Date().toISOString(), status: "sent" })
            .eq("id", invoice.id);
        }
      }
    } catch (e) {
      console.error("[invoices] recurring invoice email failed:", e);
    }
  }

  return { ok: true, invoiceId: invoice.id, invoiceNumber: number, emailed, created: true };
}
