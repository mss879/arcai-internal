"use server";

import { revalidatePath } from "next/cache";

import { fireAutomationTrigger } from "@/lib/automation";
import { buildPaymentEvent } from "@/lib/delivery";
import { createClient } from "@/lib/supabase/server";
import type {
  ActionResult,
  CommissionBasis,
  CommissionStatus,
  DeliveryStage,
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
  /** 0099 — BIG-2: where this project came from. */
  lead_id?: string | null;
  quote_id?: string | null;
  proposal_id?: string | null;
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
    // BIG-2 — only written when passed, so an edit that doesn't touch the
    // chain can never unlink a project from the deal that produced it.
    ...(input.lead_id !== undefined ? { lead_id: input.lead_id } : {}),
    ...(input.quote_id !== undefined ? { quote_id: input.quote_id } : {}),
    ...(input.proposal_id !== undefined ? { proposal_id: input.proposal_id } : {}),
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

  // 0096 — only a REAL transition into completed fires project_completed, so
  // re-saving a finished project doesn't re-run its close-out flow.
  const { data: before } = input.id
    ? await supabase.from("projects").select("status").eq("id", input.id).maybeSingle()
    : { data: null };

  const saved = input.id
    ? await supabase
        .from("projects")
        .update(payload)
        .eq("id", input.id)
        .select("id")
        .single()
    : await supabase.from("projects").insert(payload).select("id").single();

  if (saved.error) return { ok: false, error: saved.error.message };

  if (saved.data) {
    const { fireProjectCompleted, fireProjectCreated } = await import(
      "@/lib/project-events"
    );
    if (!input.id) await fireProjectCreated(supabase, saved.data.id, "team");
    if (payload.status === "completed" && before?.status !== "completed")
      await fireProjectCompleted(supabase, saved.data.id);
  }

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
  /**
   * 0091 — 'fixed' keeps the historic behaviour (the amount is owed in full).
   * 'percent_of_received' makes the stored amount a snapshot and the real
   * figure `percentage` of what the client has actually paid.
   */
  basis?: CommissionBasis;
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

  const basis: CommissionBasis = input.basis ?? "fixed";
  if (basis === "percent_of_received") {
    if (!input.percentage || input.percentage <= 0 || input.percentage > 100)
      return { ok: false, error: "Enter a percentage between 1 and 100." };
  } else if (!input.amount || input.amount <= 0) {
    return { ok: false, error: "Enter a valid amount." };
  }

  const payload = {
    project_id: input.project_id,
    user_id: input.user_id,
    // For a percentage commission this is the figure as at today — the real
    // owed amount is recomputed from money received every time it's read.
    amount: input.amount,
    percentage: input.percentage ?? null,
    status: input.status ?? "pending",
    note: input.note?.trim() || null,
    basis,
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

  const saved = input.id
    ? await supabase
        .from("project_expenses")
        .update(payload)
        .eq("id", input.id)
        .select("id")
        .single()
    : await supabase.from("project_expenses").insert(payload).select("id").single();

  if (saved.error) return { ok: false, error: saved.error.message };

  // 0096 — a NEW cost is the event; editing one already recorded isn't.
  if (!input.id && saved.data) {
    const { fireExpenseAdded } = await import("@/lib/project-events");
    await fireExpenseAdded(supabase, input.project_id, {
      id: saved.data.id,
      description: payload.description,
      amount: qty * input.unit_amount,
      category: payload.category,
      vendor: payload.vendor,
      billable: payload.billable,
    });
  }

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

// ---------------------------------------------------------------------------
// Archive / restore (LOOP-8, 0090)
// ---------------------------------------------------------------------------

/**
 * Archive a project instead of destroying it.
 *
 * `deleteProject` above cascades every payment, expense, asset request and
 * delivery event the project owns, and orphans its commissions — that is the
 * financial record of a job, one confirm dialog away from gone. Archiving
 * hides it from every board, picker, count and automation scan while leaving
 * all of that in place.
 */
export async function archiveProject(id: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("projects")
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/projects");
  revalidatePath("/delivery");
  return { ok: true };
}

export async function restoreProject(id: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("projects")
    .update({ deleted_at: null, deleted_by: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/projects");
  revalidatePath("/delivery");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Delivery stage from the project page (LOOP-3) + the deposit gate (MON-5)
// ---------------------------------------------------------------------------

export type StageMoveResult = ActionResult & {
  /** Set when a gate stopped the move; re-call with force to go ahead. */
  gate?: { kind: "deposit" | "launch_checks"; message: string };
};

/**
 * Move a project's delivery stage from the project page.
 *
 * Delegates to the same mutator the delivery board and the automation step
 * use, so milestone messages and triggers fire identically however the stage
 * moved. Two gates sit in front of it:
 *
 *   • the DEPOSIT GATE (MON-5) — a project with `deposit_required_percent`
 *     set can't slide into Build on a promise;
 *   • the LAUNCH CHECKLIST (PLAN-10) — a project can't be called Delivered
 *     while its own pre-delivery checks are still open.
 *
 * Both warn and ask rather than refuse: the team can always confirm and
 * proceed, because a rule that can't be overridden just gets worked around.
 */
export async function setProjectStage(
  projectId: string,
  stage: DeliveryStage,
  opts?: { force?: boolean },
): Promise<StageMoveResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const [projectRes, linkedRes, ownRes] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, total_value, deposit_paid, deposit_required_percent, currency")
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("company_payments")
      .select("price_lkr, is_paid")
      .eq("project_id", projectId),
    supabase.from("payments").select("amount, status").eq("project_id", projectId),
  ]);
  const project = projectRes.data;
  if (!project) return { ok: false, error: "Project not found." };

  if (!opts?.force) {
    const gate = await checkStageGates(
      supabase,
      {
        ...project,
        company_payments: linkedRes.data ?? [],
        payments: ownRes.data ?? [],
      },
      stage,
    );
    if (gate) return { ok: false, error: gate.message, gate };
  }

  const { setProjectDeliveryStage } = await import("@/lib/delivery");
  const res = await setProjectDeliveryStage(supabase, projectId, stage, {
    actor: "team",
  });
  if (!res.ok) return { ok: false, error: res.detail };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  revalidatePath("/delivery");
  return { ok: true };
}

type GateProject = {
  total_value: number | null;
  deposit_paid: number | null;
  deposit_required_percent: number | null;
  currency: string;
  company_payments?: { price_lkr: number; is_paid: boolean }[] | null;
  payments?: { amount: number; status: string }[] | null;
};

async function checkStageGates(
  supabase: Awaited<ReturnType<typeof authed>>["supabase"],
  project: GateProject & { id: string },
  stage: DeliveryStage,
): Promise<StageMoveResult["gate"] | null> {
  const { settledAmount } = await import("@/lib/projects");

  // Deposit gate: only on the way INTO build (or anything past it).
  const gatedStages: DeliveryStage[] = ["build", "review", "delivered", "aftercare"];
  const required = Number(project.deposit_required_percent) || 0;
  if (required > 0 && gatedStages.includes(stage)) {
    const total = Number(project.total_value) || 0;
    const received = settledAmount(project);
    const needed = (total * required) / 100;
    if (total > 0 && received < needed) {
      return {
        kind: "deposit",
        message: `Only ${Math.round((received / total) * 100)}% received — this project asks for ${required}% before work starts.`,
      };
    }
  }

  // Launch checklist: only on the way into delivered.
  if (stage === "delivered") {
    const { count } = await supabase
      .from("project_milestones")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("kind", "launch_check")
      .neq("status", "done");
    if ((count ?? 0) > 0) {
      return {
        kind: "launch_checks",
        message: `${count} launch check${count === 1 ? "" : "s"} still open.`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Blocked on the client (PLAN-7)
// ---------------------------------------------------------------------------

/**
 * Mark a project as blocked, or unblock it.
 *
 * While blocked the delivery chaser and the stalled-project alert stand down —
 * a project waiting on someone else isn't stalled, and nagging the team about
 * it trains them to ignore the alerts. The days lost are kept so they can be
 * quoted back when a deadline slips.
 */
export async function setProjectBlocked(
  projectId: string,
  reason: string | null,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const clean = reason?.trim() || null;
  const { error } = await supabase
    .from("projects")
    .update({
      blocked_reason: clean,
      blocked_since: clean ? new Date().toISOString() : null,
      // Leaving a block on also clears the stalled stamp, so the alert can
      // fire again cleanly once the project is moving.
      ...(clean ? {} : { stalled_alerted_at: null }),
    })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "stage_changed",
    clean ? `Blocked — ${clean}` : "Unblocked",
    "team",
    { blocked: Boolean(clean) },
  );

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Per-project automation pause (AUTO-7, 0096)
// ---------------------------------------------------------------------------

/**
 * Stand every automation down for ONE project.
 *
 * The alternative when a job goes sideways is pausing the automation itself,
 * which stops it for every other client too. This is the smaller hammer: new
 * triggers stop enrolling this project and its in-flight runs stand still at
 * the step they reached, resuming from there when it is switched back on.
 */
export async function setProjectAutomationPaused(
  projectId: string,
  paused: boolean,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("projects")
    .update({ automation_paused: paused })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "stage_changed",
    paused ? "Automations paused for this project" : "Automations resumed",
    "team",
    { automation_paused: paused },
  );

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Project settings that drive the automations (MON-2/5/6, PLAN-12)
// ---------------------------------------------------------------------------

export type ProjectAutomationSettings = {
  expense_cap?: number | null;
  deposit_required_percent?: number | null;
  is_retainer?: boolean;
  retainer_day?: number | null;
  auto_invoice_on_delivery?: boolean;
  aftercare_enabled?: boolean;
  balance_chase_paused?: boolean;
};

/** The switches on the project's Money tab. Only writes what was passed. */
export async function saveProjectAutomationSettings(
  projectId: string,
  input: ProjectAutomationSettings,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (
    input.deposit_required_percent != null &&
    (input.deposit_required_percent < 0 || input.deposit_required_percent > 100)
  ) {
    return { ok: false, error: "Deposit percentage must be between 0 and 100." };
  }
  if (
    input.retainer_day != null &&
    (input.retainer_day < 1 || input.retainer_day > 28)
  ) {
    return {
      ok: false,
      error: "Pick a day between 1 and 28 — later days don't exist in every month.",
    };
  }

  const payload: ProjectAutomationSettings & { budget_alerted_at?: null } = {};
  for (const key of [
    "expense_cap",
    "deposit_required_percent",
    "is_retainer",
    "retainer_day",
    "auto_invoice_on_delivery",
    "aftercare_enabled",
    "balance_chase_paused",
  ] as const) {
    if (input[key] !== undefined) {
      // Narrowed one key at a time so the union of value types stays honest.
      Object.assign(payload, { [key]: input[key] });
    }
  }
  if (Object.keys(payload).length === 0) return { ok: true };

  // Re-arm the budget alert whenever the cap changes, so raising a cap that
  // has already alerted can alert again when the new one is passed.
  if (payload.expense_cap !== undefined) payload.budget_alerted_at = null;

  const { error } = await supabase
    .from("projects")
    .update(payload)
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Read a supplier receipt (MON-8)
// ---------------------------------------------------------------------------

export type ReadReceiptResult =
  | { ok: true; parsed: import("@/lib/ai/receipt").ParsedReceipt }
  | { ok: false; error: string };

/**
 * Turn a photographed bill into a draft expense.
 *
 * Takes a data: URL straight from the file input rather than an uploaded
 * object, so a receipt the model can't read never leaves anything behind in
 * storage. Nothing is saved — the parsed fields land in the form for a human
 * to confirm.
 */
export async function readReceipt(dataUrl: string): Promise<ReadReceiptResult> {
  const { user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!dataUrl.startsWith("data:image/")) {
    return {
      ok: false,
      error: "Reading works on photos and screenshots. Type a PDF bill in by hand.",
    };
  }
  // ~8MB of base64 ≈ 6MB of image. Past that the vision call times out more
  // often than it succeeds, and the error is unhelpful.
  if (dataUrl.length > 8_000_000) {
    return { ok: false, error: "That image is too large — take a smaller photo." };
  }

  const { parseReceipt } = await import("@/lib/ai/receipt");
  const parsed = await parseReceipt(dataUrl);
  if (!parsed) {
    return {
      ok: false,
      error: "Couldn't read that one — fill it in by hand.",
    };
  }
  if (!parsed.amount && !parsed.vendor) {
    return {
      ok: false,
      error: "That doesn't look like a receipt. Fill it in by hand.",
    };
  }
  return { ok: true, parsed };
}
