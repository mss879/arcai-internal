"use server";

import { revalidatePath } from "next/cache";

import { fireAutomationTrigger } from "@/lib/automation";
import { buildPaymentEvent } from "@/lib/delivery";
import { createClient } from "@/lib/supabase/server";
import type {
  ActionResult,
  CommissionStatus,
  PaymentStatus,
  ProjectStatus,
} from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// --- Projects --------------------------------------------------
export type ProjectInput = {
  id?: string;
  name: string;
  description?: string;
  client_id?: string | null;
  status?: ProjectStatus;
  budget?: number | null;
  currency?: string;
  start_date?: string | null;
  due_date?: string | null;
  total_value?: number | null;
  deposit_paid?: number | null;
  service_type?: string | null;
  /** Uploaded documents (0083). Undefined = leave whatever is stored alone. */
  proposal_url?: string | null;
  proposal_name?: string | null;
  proposal_path?: string | null;
  invoice_url?: string | null;
  invoice_name?: string | null;
  invoice_path?: string | null;
};

export async function saveProject(input: ProjectInput): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.name?.trim()) return { ok: false, error: "Project name is required." };

  const payload = {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    client_id: input.client_id || null,
    status: input.status ?? "planning",
    budget: input.budget ?? null,
    currency: input.currency || "LKR",
    start_date: input.start_date || null,
    due_date: input.due_date || null,
    total_value: input.total_value ?? 0.00,
    deposit_paid: input.deposit_paid ?? 0.00,
    service_type: input.service_type || null,
    // Documents are only written when the form actually passed them, so an
    // edit that doesn't touch the uploads can never blank an existing file.
    ...(input.proposal_url !== undefined
      ? {
          proposal_url: input.proposal_url,
          proposal_name: input.proposal_name ?? null,
          proposal_path: input.proposal_path ?? null,
        }
      : {}),
    ...(input.invoice_url !== undefined
      ? {
          invoice_url: input.invoice_url,
          invoice_name: input.invoice_name ?? null,
          invoice_path: input.invoice_path ?? null,
        }
      : {}),
  };

  const { error } = input.id
    ? await supabase.from("projects").update(payload).eq("id", input.id)
    : await supabase.from("projects").insert(payload);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects");
  return { ok: true };
}

export async function deleteProject(id: string): Promise<ActionResult> {
  const { supabase } = await authed();
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects");
  return { ok: true };
}

// --- Payments --------------------------------------------------
export type PaymentInput = {
  id?: string;
  project_id: string;
  amount: number;
  currency?: string;
  status?: PaymentStatus;
  paid_at?: string | null;
  method?: string;
  notes?: string;
  receipt_path?: string | null;
};

export async function savePayment(input: PaymentInput): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a valid amount." };

  const payload = {
    project_id: input.project_id,
    amount: input.amount,
    currency: input.currency || "LKR",
    status: input.status ?? "paid",
    paid_at: input.paid_at || null,
    method: input.method?.trim() || null,
    notes: input.notes?.trim() || null,
    receipt_path: input.receipt_path || null,
  };

  // For an edit, know whether it was ALREADY paid — only a transition to
  // paid (or a new paid row) is a payment event.
  const { data: prior } = input.id
    ? await supabase.from("payments").select("status").eq("id", input.id).maybeSingle()
    : { data: null };

  const saved = input.id
    ? await supabase
        .from("payments")
        .update(payload)
        .eq("id", input.id)
        .select("id")
        .single()
    : await supabase.from("payments").insert(payload).select("id").single();

  if (saved.error) return { ok: false, error: saved.error.message };

  // 0085 — same cue as the Payments board: money landed on a project.
  const becamePaid =
    payload.status === "paid" && (!input.id || prior?.status !== "paid");
  if (becamePaid && saved.data) {
    const event = await buildPaymentEvent(supabase, {
      projectId: input.project_id,
      amountText: `${payload.currency} ${Number(input.amount).toLocaleString()}`,
      source: "project_detail",
      triggerKey: `project_payment:${saved.data.id}:paid`,
    });
    if (event) await fireAutomationTrigger(supabase, event);
  }

  revalidatePath(`/projects/${input.project_id}`);
  revalidatePath("/projects");
  return { ok: true };
}

export async function deletePayment(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase } = await authed();
  const { error } = await supabase.from("payments").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// --- Commissions (admin only) ---------------------------------
export type CommissionInput = {
  id?: string;
  project_id: string;
  user_id: string;
  amount: number;
  percentage?: number | null;
  status?: CommissionStatus;
  note?: string;
};

export async function saveCommission(
  input: CommissionInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role, full_name, username")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { ok: false, error: "Only an admin can allocate commissions." };
  }
  if (!input.user_id) return { ok: false, error: "Choose a recipient." };
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a valid amount." };

  const payload = {
    project_id: input.project_id,
    user_id: input.user_id,
    amount: input.amount,
    percentage: input.percentage ?? null,
    status: input.status ?? "pending",
    note: input.note?.trim() || null,
    allocated_by: user.id,
  };

  let error;
  if (input.id) {
    ({ error } = await supabase
      .from("commissions")
      .update(payload)
      .eq("id", input.id));
  } else {
    ({ error } = await supabase.from("commissions").insert(payload));
    if (!error && input.user_id !== user.id) {
      await supabase.from("notifications").insert({
        user_id: input.user_id,
        actor_id: user.id,
        type: "commission",
        title: "You were allocated a commission",
        body: input.note?.trim() || "Check your profile for details.",
        link: "/profile",
      });
    }
  }

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${input.project_id}`);
  revalidatePath("/profile");
  return { ok: true };
}

export async function deleteCommission(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase } = await authed();
  const { error } = await supabase.from("commissions").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/profile");
  return { ok: true };
}

// --- Month carry-forward (0087) --------------------------------
/**
 * Whether an unfinished project also shows under the current month.
 *
 * Its card in the month it was created never moves — that month stays a
 * record of what was booked. This controls the extra, tinted copy the board
 * puts under the CURRENT month so work in progress isn't buried in a
 * collapsed month from six months ago. Turning it off leaves the project
 * visible only in its own month, for something long-running that shouldn't
 * crowd the board.
 */
export async function setProjectCarryForward(
  id: string,
  carryForward: boolean,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("projects")
    .update({ carry_forward: carryForward })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
  return { ok: true };
}

// --- Additional expenses (0087) --------------------------------
export type ProjectExpenseInput = {
  id?: string;
  project_id: string;
  description: string;
  detail?: string | null;
  category?: string | null;
  vendor?: string | null;
  qty?: number | null;
  unit_amount: number;
  currency?: string;
  incurred_on?: string | null;
  billable?: boolean;
  notes?: string | null;
  receipt_path?: string | null;
  receipt_url?: string | null;
};

export async function saveProjectExpense(
  input: ProjectExpenseInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.description?.trim())
    return { ok: false, error: "Describe what the expense was for." };
  if (!Number.isFinite(input.unit_amount) || input.unit_amount <= 0)
    return { ok: false, error: "Enter a valid amount." };

  const qty = input.qty && input.qty > 0 ? input.qty : 1;
  const payload = {
    project_id: input.project_id,
    description: input.description.trim(),
    detail: input.detail?.trim() || null,
    category: input.category?.trim() || null,
    vendor: input.vendor?.trim() || null,
    qty,
    unit_amount: input.unit_amount,
    currency: input.currency || "LKR",
    incurred_on: input.incurred_on || new Date().toISOString().slice(0, 10),
    billable: input.billable ?? true,
    notes: input.notes?.trim() || null,
    // Only written when the form actually uploaded something, so editing an
    // expense can't blank a receipt attached earlier.
    ...(input.receipt_path !== undefined && input.receipt_path !== null
      ? { receipt_path: input.receipt_path, receipt_url: input.receipt_url ?? null }
      : {}),
  };

  const { error } = input.id
    ? await supabase.from("project_expenses").update(payload).eq("id", input.id)
    : await supabase.from("project_expenses").insert(payload);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${input.project_id}`);
  revalidatePath("/projects");
  return { ok: true };
}

export async function deleteProjectExpense(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase.from("project_expenses").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Stamp expenses as billed (or clear the stamp).
 *
 * "Generate invoice" calls this for every expense it puts on the invoice, so
 * the same extra cost can never be billed twice. It's reversible from the row
 * menu — an invoice abandoned before download is undone with one click.
 */
export async function setProjectExpensesInvoiced(
  ids: string[],
  projectId: string,
  invoiced: boolean,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (ids.length === 0) return { ok: true };

  const { error } = await supabase
    .from("project_expenses")
    .update(
      invoiced
        ? { invoiced_at: new Date().toISOString(), invoiced_by: user.id }
        : { invoiced_at: null, invoiced_by: null },
    )
    .in("id", ids);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { ok: true };
}
