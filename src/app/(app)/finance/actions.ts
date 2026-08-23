"use server";

import { revalidatePath } from "next/cache";

import { fireAutomationTrigger } from "@/lib/automation";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import type {
  ChequeDirection,
  ChequeStatus,
  ExpenseCategory,
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
  const { data: inst, error } = await supabase
    .from("payment_installments")
    .update({
      status: paid ? "paid" : "pending",
      paid_at: paid ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .select("plan_id, seq, amount")
    .single();
  if (error) return { ok: false, error: error.message };

  // Complete the plan when its last installment is settled.
  if (inst) {
    const { data: siblings } = await supabase
      .from("payment_installments")
      .select("status")
      .eq("plan_id", inst.plan_id);
    const allPaid = (siblings ?? []).every((s) => s.status === "paid");
    await supabase
      .from("payment_plans")
      .update({ status: allPaid ? "completed" : "active" })
      .eq("id", inst.plan_id);
  }

  // Money landed → fire the payment_received automations (e.g. the
  // "Deposit received 🚀" kickoff when seq = 1). trigger_key dedupes, so
  // toggling paid → unpaid → paid never spams the customer.
  if (paid && inst) {
    const { data: plan } = await supabase
      .from("payment_plans")
      .select("*")
      .eq("id", inst.plan_id)
      .maybeSingle();
    if (plan) {
      const lead = plan.lead_id
        ? (await supabase.from("leads").select("*").eq("id", plan.lead_id).maybeSingle()).data
        : null;
      await fireAutomationTrigger(supabase, {
        trigger: "payment_received",
        lead,
        client: plan.client_id
          ? { id: plan.client_id, name: plan.contact_name, phone: plan.phone }
          : null,
        payload: {
          name: plan.contact_name,
          phone: plan.phone,
          amount: `${plan.currency} ${Number(inst.amount).toLocaleString()}`,
          seq: inst.seq,
          plan_title: plan.title,
          total: Number(plan.total) || 0,
          total_amount: `${plan.currency} ${Number(plan.total).toLocaleString()}`,
          // 0085 — which surface recorded the money. Plans carry no project
          // link, so first_payment stays unset here and the delivery-kickoff
          // recipe (which filters on it) never fires from Finance; the
          // legacy seq-1 deposit recipe still covers this path.
          source: "finance",
        },
        triggerKey: `${id}:paid`,
      });
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
  };

  const { error } = input.id
    ? await supabase.from("expenses").update(base).eq("id", input.id)
    : await supabase.from("expenses").insert(base);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}

export async function deleteExpense(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/finance");
  return { ok: true };
}
