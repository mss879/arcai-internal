"use server";

import { revalidatePath } from "next/cache";

import { fireAutomationTrigger } from "@/lib/automation";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import type {
  ChequeDirection,
  ChequeStatus,
  ExpenseCategory,
  RecurringIncomeCategory,
  RecurringIncomeStatus,
} from "@/lib/database.types";

// --- Payment plans ---------------------------------------------

export type PlanInput = {
  title: string;
  client_id?: string | null;
  lead_id?: string | null;
  /** 0091 — the project this schedule bills. NULL = a standalone plan. */
  project_id?: string | null;
  contact_name: string;
  phone?: string | null;
  total: number;
  remind_days_before: number | null;
  notes?: string | null;
  installments: { amount: number; due_date: string }[];
};

export async function createPaymentPlan(input: PlanInput): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title.trim()) return { ok: false, error: "Give the plan a title." };
  if (input.installments.length === 0)
    return { ok: false, error: "Add at least one installment." };
  if (input.installments.some((i) => !i.due_date || i.amount <= 0))
    return { ok: false, error: "Every installment needs an amount and a due date." };

  const { data: plan, error } = await supabase
    .from("payment_plans")
    .insert({
      title: input.title.trim(),
      client_id: input.client_id || null,
      lead_id: input.lead_id || null,
      project_id: input.project_id || null,
      contact_name: input.contact_name.trim(),
      phone: input.phone?.trim() || null,
      total: input.total,
      remind_days_before: input.remind_days_before,
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (error || !plan) return { ok: false, error: error?.message ?? "Failed." };

  const { error: instError } = await supabase.from("payment_installments").insert(
    input.installments.map((inst, i) => ({
      plan_id: plan.id,
      seq: i + 1,
      amount: inst.amount,
      due_date: inst.due_date,
    })),
  );
  if (instError) return { ok: false, error: instError.message };

  revalidatePath("/finance");
  // A schedule attached to a project shows on that project too.
  if (input.project_id) revalidatePath(`/projects/${input.project_id}`);
  return { ok: true };
}

export async function setInstallmentPaid(
  id: string,
  paid: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 0120 — money landing goes through recordPayment(): it marks the
  // instalment, completes the plan when it was the last one, settles the
  // linked invoice and fires the ONE payment_received (trigger_key dedupes,
  // so paid → unpaid → paid never spams the customer).
  if (paid) {
    const { data: inst } = await supabase
      .from("payment_installments")
      .select("id, amount, status")
      .eq("id", id)
      .maybeSingle();
    if (!inst) return { ok: false, error: "That instalment no longer exists." };
    if (inst.status === "paid") return { ok: true };
    const { recordPayment } = await import("@/lib/payments");
    const res = await recordPayment(supabase, {
      source: "finance",
      installmentId: id,
      amount: Number(inst.amount) || 0,
      actorId: user?.id ?? null,
    });
    if (!res.ok) return res;
    revalidatePath("/finance");
    revalidatePath("/invoices");
    return { ok: true };
  }

  const { data: inst, error } = await supabase
    .from("payment_installments")
    .update({ status: "pending", paid_at: null })
    .eq("id", id)
    .select("plan_id, invoice_id")
    .single();
  if (error) return { ok: false, error: error.message };

  // The plan is no longer complete, and the invoice has received less.
  if (inst) {
    await supabase
      .from("payment_plans")
      .update({ status: "active" })
      .eq("id", inst.plan_id);
    if (inst.invoice_id) {
      const { reconcileInvoice } = await import("@/lib/invoices");
      await reconcileInvoice(supabase, inst.invoice_id);
    }
  }

  revalidatePath("/finance");
  return { ok: true };
}

export async function deletePaymentPlan(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("payment_plans").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

// --- Cheques ----------------------------------------------------

export type ChequeInput = {
  id?: string;
  direction: ChequeDirection;
  party_name: string;
  client_id?: string | null;
  bank?: string | null;
  cheque_number?: string | null;
  amount: number;
  due_date: string;
  notes?: string | null;
};

export async function saveCheque(input: ChequeInput): Promise<ActionResult> {
  const supabase = await createClient();
  if (!input.party_name.trim()) return { ok: false, error: "Who is the cheque from/to?" };
  if (!input.due_date) return { ok: false, error: "Set the cheque date." };

  const base = {
    direction: input.direction,
    party_name: input.party_name.trim(),
    client_id: input.client_id || null,
    bank: input.bank?.trim() || null,
    cheque_number: input.cheque_number?.trim() || null,
    amount: input.amount,
    due_date: input.due_date,
    notes: input.notes?.trim() || null,
  };

  const { error } = input.id
    ? await supabase.from("cheques").update(base).eq("id", input.id)
    : await supabase.from("cheques").insert(base);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

export async function setChequeStatus(
  id: string,
  status: ChequeStatus,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("cheques").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

export async function deleteCheque(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("cheques").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

// --- Expenses ----------------------------------------------------

export type ExpenseInput = {
  id?: string;
  expense_date: string;
  category: ExpenseCategory;
  description: string;
  vendor?: string | null;
  amount: number;
  tax_amount: number;
  payment_method?: string | null;
  /** 0100 — the project this cost belongs to. NULL = general overhead. */
  project_id?: string | null;
};

export async function saveExpense(input: ExpenseInput): Promise<ActionResult> {
  const supabase = await createClient();
  if (!input.description.trim()) return { ok: false, error: "Describe the expense." };
  if (!(input.amount > 0)) return { ok: false, error: "Enter the amount." };

  const base = {
    expense_date: input.expense_date,
    category: input.category,
    description: input.description.trim(),
    vendor: input.vendor?.trim() || null,
    amount: input.amount,
    tax_amount: input.tax_amount || 0,
    payment_method: input.payment_method?.trim() || null,
    project_id: input.project_id || null,
  };

  const { error } = input.id
    ? await supabase.from("expenses").update(base).eq("id", input.id)
    : await supabase.from("expenses").insert(base);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  // The cost lands on that project's margin the moment it is saved, so the
  // project's own pages have to be re-rendered too.
  if (base.project_id) {
    revalidatePath(`/projects/${base.project_id}`);
    revalidatePath("/projects");
  }
  return { ok: true };
}

export async function deleteExpense(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

// --- Recurring income (0100) -------------------------------------
//
// The standing arrangement, not the money: each month's actual receipt is a
// recurring_income_entries row the tick generates and a person marks off.

export type RecurringIncomeInput = {
  id?: string;
  label: string;
  client_id?: string | null;
  project_id?: string | null;
  amount: number;
  currency?: string;
  day_of_month: number;
  category: RecurringIncomeCategory;
  started_on?: string;
  ended_on?: string | null;
  notes?: string | null;
  is_active?: boolean;
};

export async function saveRecurringIncome(
  input: RecurringIncomeInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!input.label.trim()) return { ok: false, error: "Give it a name." };
  if (!(input.amount > 0)) return { ok: false, error: "Enter the monthly amount." };
  if (input.day_of_month < 1 || input.day_of_month > 28)
    return {
      ok: false,
      error: "Pick a day between 1 and 28 — later days don't exist in every month.",
    };

  const base = {
    label: input.label.trim(),
    client_id: input.client_id || null,
    project_id: input.project_id || null,
    amount: input.amount,
    currency: input.currency || "LKR",
    day_of_month: input.day_of_month,
    category: input.category,
    started_on: input.started_on || new Date().toISOString().slice(0, 10),
    ended_on: input.ended_on || null,
    notes: input.notes?.trim() || null,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };

  const { error } = input.id
    ? await supabase.from("recurring_income").update(base).eq("id", input.id)
    : await supabase
        .from("recurring_income")
        .insert({ ...base, created_by: user.id });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

export async function setRecurringIncomeActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("recurring_income")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

/**
 * Delete an arrangement.
 *
 * Cascades its entries, which is right: they are the record of a promise that
 * no longer exists. Ending it (`ended_on`) is the move that keeps the history —
 * the UI offers that first.
 */
export async function deleteRecurringIncome(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("recurring_income").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

export async function setIncomeEntryStatus(
  id: string,
  status: RecurringIncomeStatus,
  opts?: { amount?: number; note?: string | null },
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const received = status === "received";
  const { error } = await supabase
    .from("recurring_income_entries")
    .update({
      status,
      // A month can land short or late; the entry records what actually
      // arrived rather than what was promised.
      ...(opts?.amount !== undefined && opts.amount > 0
        ? { amount: opts.amount }
        : {}),
      received_on: received ? new Date().toISOString().slice(0, 10) : null,
      received_by: received ? user.id : null,
      note: opts?.note?.trim() || null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}
