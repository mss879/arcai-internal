import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fireAutomationTrigger } from "@/lib/automation";
import type { Database, InvoiceStatus, PaymentSource } from "@/lib/database.types";
import { buildPaymentEvent, logDeliveryEvent } from "@/lib/delivery";
import { openInvoicesForProject, reconcileInvoice } from "@/lib/invoices";
import { notifyUsers } from "@/lib/notify";
import { allocatePayment } from "@/lib/projects";

type DB = SupabaseClient<Database>;

/**
 * One core for every payment (0120).
 *
 * Five screens used to write payments — the project page, the Payments
 * board, Finance's instalments, the deposit button and the assistant — each
 * firing its own `payment_received`, and none of them touching an invoice.
 * Now every one of them comes through here, and so does a verified bank
 * slip, a WhatsApp slip and (one day) a gateway webhook:
 *
 *   1. write the money — a `payments` row, or, when the money already IS a
 *      Payments-board row or an instalment, link that row instead;
 *   2. resolve the invoice it settles (given, or the project's open invoices
 *      oldest first) and reconcile it;
 *   3. mark an instalment paid and complete its plan when it was the last;
 *   4. fire ONE payment_received, write ONE History line, tell finance.
 *
 * Never writes `deposit_paid`: settledAmount() reconciles that against the
 * payment rows, and writing both is how "Received" doubled once already.
 */

export type RecordPaymentInput = {
  source: PaymentSource;
  amount: number;
  currency?: string | null;
  /** ISO date the money arrived. Defaults to today. */
  paidAt?: string | null;
  method?: string | null;
  notes?: string | null;
  receiptPath?: string | null;
  projectId?: string | null;
  /** The invoice this settles. When absent and the project has open invoices, they are settled oldest first. */
  invoiceId?: string | null;
  installmentId?: string | null;
  /** The Payments-board row this money already is. Links it rather than inserting a second row. */
  companyPaymentId?: string | null;
  /** A recurring month received: the entry IS the money, so no payments row is written. */
  recurringEntryId?: string | null;
  slipId?: string | null;
  providerRef?: string | null;
  actorId: string | null;
  /** Shown on the History line and the notification. */
  actorLabel?: string | null;
  /** Skip the automation trigger — for a backfill or a migration, never for live money. */
  silent?: boolean;
};

export type RecordPaymentResult =
  | {
      ok: true;
      /** The payments row written, or null when a board row / instalment was linked instead. */
      paymentId: string | null;
      invoiceIds: string[];
      invoiceStatus: InvoiceStatus | null;
      firstPayment: boolean;
    }
  | { ok: false; error: string };

export async function recordPayment(db: DB, input: RecordPaymentInput): Promise<RecordPaymentResult> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid amount." };
  }
  if (
    !input.projectId &&
    !input.invoiceId &&
    !input.installmentId &&
    !input.companyPaymentId &&
    !input.recurringEntryId
  ) {
    return { ok: false, error: "A payment has to settle something — a project, an invoice or an instalment." };
  }

  const paidAt = (input.paidAt ?? new Date().toISOString()).slice(0, 10);

  // --- Resolve the project and currency from whatever was given ---------
  let projectId = input.projectId ?? null;
  let currency = input.currency ?? null;

  let invoiceIds: string[] = [];
  if (input.invoiceId) {
    const { data: inv } = await db
      .from("invoices")
      .select("id, project_id, currency, status")
      .eq("id", input.invoiceId)
      .maybeSingle();
    if (!inv) return { ok: false, error: "That invoice no longer exists." };
    if (inv.status === "void") return { ok: false, error: "That invoice is void." };
    invoiceIds = [inv.id];
    projectId = projectId ?? inv.project_id;
    currency = currency ?? inv.currency;
  }

  let installment: { id: string; plan_id: string; seq: number; invoice_id: string | null } | null = null;
  if (input.installmentId) {
    const { data: inst } = await db
      .from("payment_installments")
      .select("id, plan_id, seq, invoice_id, plan:payment_plans(project_id, currency, invoice_id)")
      .eq("id", input.installmentId)
      .maybeSingle();
    if (!inst) return { ok: false, error: "That instalment no longer exists." };
    const plan = inst.plan as unknown as {
      project_id: string | null;
      currency: string;
      invoice_id: string | null;
    } | null;
    installment = { id: inst.id, plan_id: inst.plan_id, seq: inst.seq, invoice_id: inst.invoice_id };
    projectId = projectId ?? plan?.project_id ?? null;
    currency = currency ?? plan?.currency ?? null;
    const linkedInvoice = inst.invoice_id ?? plan?.invoice_id ?? null;
    if (linkedInvoice && !invoiceIds.length) invoiceIds = [linkedInvoice];
  }

  // --- A recurring month: mark it received and settle its invoice ---------
  if (input.recurringEntryId) {
    const { data: entry } = await db
      .from("recurring_income_entries")
      .select("id, invoice_id, currency, status")
      .eq("id", input.recurringEntryId)
      .maybeSingle();
    if (!entry) return { ok: false, error: "That month no longer exists." };
    await db
      .from("recurring_income_entries")
      .update({
        status: "received",
        amount,
        received_on: paidAt,
        received_by: input.actorId,
        ...(input.notes !== undefined ? { note: input.notes?.trim() || null } : {}),
      })
      .eq("id", entry.id);
    let status: InvoiceStatus | null = null;
    if (entry.invoice_id) {
      const r = await reconcileInvoice(db, entry.invoice_id);
      status = r?.status ?? null;
    }
    await notifyFinance(db, {
      title: `${entry.currency || currency || "LKR"} ${amount.toLocaleString()} received (recurring)`,
      body: status ? `Invoice ${status === "paid" ? "settled" : "part-paid"}.` : "Marked received on the Recurring tab.",
      link: "/finance",
      actorId: input.actorId,
    });
    return {
      ok: true,
      paymentId: null,
      invoiceIds: entry.invoice_id ? [entry.invoice_id] : [],
      invoiceStatus: status,
      firstPayment: false,
    };
  }

  if (projectId && !currency) {
    const { data: project } = await db.from("projects").select("currency").eq("id", projectId).maybeSingle();
    currency = project?.currency ?? null;
  }
  currency = currency || "LKR";

  // --- 1. Write the money ------------------------------------------------
  let paymentId: string | null = null;
  if (input.companyPaymentId) {
    // The money already exists as a Payments-board row; link it.
    const { error } = await db
      .from("company_payments")
      .update({
        is_paid: true,
        ...(projectId ? { project_id: projectId } : {}),
        ...(invoiceIds[0] ? { invoice_id: invoiceIds[0] } : {}),
      })
      .eq("id", input.companyPaymentId);
    if (error) return { ok: false, error: error.message };
  } else if (installment && !input.projectId && !input.invoiceId) {
    // An instalment ticked off on its own: the instalment row IS the money
    // for monthlyInflows(); a payments row as well would count it twice.
  } else {
    const { data: row, error } = await db
      .from("payments")
      .insert({
        project_id: projectId,
        amount,
        currency,
        status: "paid",
        paid_at: paidAt,
        method: input.method?.trim() || null,
        notes: input.notes?.trim() || null,
        receipt_path: input.receiptPath ?? null,
        invoice_id: invoiceIds[0] ?? null,
        installment_id: installment?.id ?? null,
        slip_id: input.slipId ?? null,
        source: input.source,
        provider_ref: input.providerRef ?? null,
        created_by: input.actorId,
      })
      .select("id")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Could not record the payment." };
    paymentId = row.id;
  }

  // --- 2. The invoice(s) it settles ---------------------------------------
  if (!invoiceIds.length && projectId) {
    const open = await openInvoicesForProject(db, projectId);
    const { allocations } = allocatePayment(amount, open);
    invoiceIds = allocations.map((a) => a.invoiceId);
    // Without a per-invoice split on the payments row, the money is linked
    // to the first invoice it settles; the rest reconcile from their own
    // links. One payment, one invoice — the split is reported, not stored.
    if (paymentId && invoiceIds[0]) {
      await db.from("payments").update({ invoice_id: invoiceIds[0] }).eq("id", paymentId);
      invoiceIds = [invoiceIds[0]];
    }
  }
  let invoiceStatus: InvoiceStatus | null = null;
  for (const id of invoiceIds) {
    const r = await reconcileInvoice(db, id);
    if (r) invoiceStatus = r.status;
  }

  // --- 3. The instalment -------------------------------------------------
  if (installment) {
    await db
      .from("payment_installments")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", installment.id);
    const { data: siblings } = await db
      .from("payment_installments")
      .select("status")
      .eq("plan_id", installment.plan_id);
    const allPaid = (siblings ?? []).every((s) => s.status === "paid");
    await db
      .from("payment_plans")
      .update({ status: allPaid ? "completed" : "active" })
      .eq("id", installment.plan_id);
  }

  // --- 4. One event, one History line, one notification -------------------
  const amountText = `${currency} ${amount.toLocaleString()}`;
  let firstPayment = false;
  if (projectId) {
    if (!input.silent) {
      const event = await buildPaymentEvent(db, {
        projectId,
        amountText,
        source: input.source,
        triggerKey: `payment:${paymentId ?? input.companyPaymentId ?? installment?.id ?? invoiceIds[0] ?? paidAt}:paid`,
      });
      if (event) {
        firstPayment = Boolean(event.payload?.first_payment);
        await fireAutomationTrigger(db, event);
      }
    }
    await logDeliveryEvent(
      db,
      projectId,
      "payment_received",
      `${amountText} received${input.method ? ` by ${input.method}` : ""}${input.source === "slip" ? " (bank slip verified)" : ""}`,
      input.actorLabel ?? (input.actorId ? "team" : input.source),
      { payment_id: paymentId, invoice_ids: invoiceIds, source: input.source },
    );
  } else if (installment && !input.silent) {
    // A plan with no project still fires the trigger the Finance page did.
    const { data: plan } = await db.from("payment_plans").select("*").eq("id", installment.plan_id).maybeSingle();
    if (plan) {
      const lead = plan.lead_id
        ? (await db.from("leads").select("*").eq("id", plan.lead_id).maybeSingle()).data
        : null;
      await fireAutomationTrigger(db, {
        trigger: "payment_received",
        lead,
        client: plan.client_id ? { id: plan.client_id, name: plan.contact_name, phone: plan.phone } : null,
        payload: {
          name: plan.contact_name,
          phone: plan.phone,
          amount: amountText,
          seq: installment.seq,
          plan_title: plan.title,
          total: Number(plan.total) || 0,
          total_amount: `${plan.currency} ${Number(plan.total).toLocaleString()}`,
          source: input.source,
        },
        triggerKey: `${installment.id}:paid`,
      });
    }
  }

  // Tell the people who watch the money. Never the person who recorded it.
  await notifyFinance(db, {
    title: `${amountText} received`,
    body: invoiceStatus
      ? `Invoice ${invoiceStatus === "paid" ? "settled" : "part-paid"}${input.source === "slip" ? " — bank slip verified" : ""}.`
      : `Recorded via ${input.source.replace("_", " ")}.`,
    link: projectId ? `/projects/${projectId}?tab=money` : "/finance",
    actorId: input.actorId,
  });

  return { ok: true, paymentId, invoiceIds, invoiceStatus, firstPayment };
}

/** Admins, until capabilities (0121) name a finance group. */
async function notifyFinance(
  db: DB,
  input: { title: string; body: string; link: string; actorId: string | null },
): Promise<void> {
  try {
    const { data: admins } = await db.from("profiles").select("id").eq("role", "admin");
    const ids = (admins ?? []).map((a) => a.id).filter((id) => id !== input.actorId);
    if (!ids.length) return;
    await notifyUsers(db, {
      userIds: ids,
      type: "system",
      title: input.title,
      body: input.body,
      link: input.link,
      actorId: input.actorId,
      push: false,
    });
  } catch {
    // A notification must never fail a payment.
  }
}
