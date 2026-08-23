import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { appLink } from "@/lib/app-url";
import { fireAutomationTrigger, type TriggerEvent } from "@/lib/automation";
import type { AutomationTrigger, Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * The project automation triggers (AUTO-1, 0096).
 *
 * Every one of them needs the same three things before it can be useful: the
 * project, the client behind it (so a send_sms / send_whatsapp step has a
 * number to write to) and the portal link (so the message can carry one).
 * Resolving that in eight different call sites is how they drift apart, so
 * they all come through here.
 *
 * Nothing in this file throws. A trigger that can't be built is a trigger
 * that doesn't fire — never a failed save on the write path that fired it.
 */

export type ProjectEventBase = {
  project: { id: string; name: string };
  client: { id: string; name: string; email?: string | null; phone?: string | null } | null;
  payload: Record<string, unknown>;
};

/**
 * Load the project + client + portal link for a trigger.
 *
 * Returns null for a project that is gone, archived, or has automation paused
 * (AUTO-7) — the pause has to bite here as well as in fireAutomationTrigger,
 * because these helpers are the only path most project triggers take.
 */
export async function projectEventBase(
  supabase: DB,
  projectId: string,
): Promise<ProjectEventBase | null> {
  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, name, client_id, share_token, service_type, currency, total_value, due_date, status, delivery_stage, deleted_at, automation_paused",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.deleted_at || project.automation_paused) return null;

  const client = project.client_id
    ? (
        await supabase
          .from("clients")
          .select("id, name, phone, email")
          .eq("id", project.client_id)
          .maybeSingle()
      ).data
    : null;

  const portalLink = project.share_token
    ? appLink(`/public/project/${project.share_token}`)
    : null;

  return {
    project: { id: project.id, name: project.name },
    client: client ?? null,
    payload: {
      name: client?.name ?? "",
      phone: client?.phone ?? null,
      email: client?.email ?? null,
      service_type: project.service_type,
      currency: project.currency,
      total_value: project.total_value,
      due_date: project.due_date,
      status: project.status,
      delivery_stage: project.delivery_stage,
      ...(portalLink ? { portal_link: portalLink } : {}),
    },
  };
}

/** Build and fire one project trigger. Extra payload wins over the base. */
export async function fireProjectTrigger(
  supabase: DB,
  trigger: AutomationTrigger,
  projectId: string,
  opts?: { payload?: Record<string, unknown>; triggerKey?: string },
): Promise<void> {
  try {
    const base = await projectEventBase(supabase, projectId);
    if (!base) return;
    const event: TriggerEvent = {
      trigger,
      project: base.project,
      client: base.client,
      payload: { ...base.payload, ...(opts?.payload ?? {}) },
      triggerKey: opts?.triggerKey,
    };
    await fireAutomationTrigger(supabase, event);
  } catch (e) {
    console.error(`[project-events] ${trigger} failed:`, e);
  }
}

// ---------------------------------------------------------------------------
// The named events — one per write path that can fire one.
// ---------------------------------------------------------------------------

/**
 * A project record was born.
 *
 * Called from the paths a HUMAN (or the assistant, or the retainer generator)
 * creates a project through — never from the `create_project` automation step.
 * A kickoff flow that both listens for project_created and creates a project
 * would otherwise hatch a new project on every tick forever.
 */
export async function fireProjectCreated(
  supabase: DB,
  projectId: string,
  source: "team" | "assistant" | "retainer" = "team",
): Promise<void> {
  await fireProjectTrigger(supabase, "project_created", projectId, {
    payload: { source },
    triggerKey: `${projectId}:created`,
  });
}

/** The job is closed — whatever its delivery stage says. */
export async function fireProjectCompleted(
  supabase: DB,
  projectId: string,
): Promise<void> {
  await fireProjectTrigger(supabase, "project_completed", projectId, {
    triggerKey: `${projectId}:completed`,
  });
}

/** A cost landed on a project. */
export async function fireExpenseAdded(
  supabase: DB,
  projectId: string,
  expense: {
    id: string;
    description: string;
    amount: number;
    category?: string | null;
    vendor?: string | null;
    billable?: boolean;
  },
): Promise<void> {
  await fireProjectTrigger(supabase, "expense_added", projectId, {
    payload: {
      expense_id: expense.id,
      expense: expense.description,
      // Message-facing name; {{amount}} is what every other trigger calls it.
      amount: expense.amount,
      category: expense.category ?? "",
      vendor: expense.vendor ?? "",
      billable: expense.billable ?? true,
    },
    triggerKey: `${expense.id}:expense_added`,
  });
}

/** Recorded costs passed the cap. Once per project — same guard as the alert. */
export async function fireExpensesOverBudget(
  supabase: DB,
  projectId: string,
  detail: { spent: number; cap: number; currency: string },
): Promise<void> {
  await fireProjectTrigger(supabase, "expenses_over_budget", projectId, {
    payload: {
      spent: detail.spent,
      cap: detail.cap,
      over_by: Math.max(0, detail.spent - detail.cap),
      currency: detail.currency,
    },
    triggerKey: `${projectId}:over_budget`,
  });
}

/** A milestone was ticked off. */
export async function fireMilestoneCompleted(
  supabase: DB,
  projectId: string,
  milestone: { id: string; title: string; kind: string },
): Promise<void> {
  await fireProjectTrigger(supabase, "milestone_completed", projectId, {
    payload: {
      milestone_id: milestone.id,
      milestone: milestone.title,
      milestone_kind: milestone.kind,
    },
    // Keyed on the milestone, so un-ticking and re-ticking can't re-fire it.
    triggerKey: `${milestone.id}:milestone_done`,
  });
}

/** The client signed something off on the portal. */
export async function fireClientApproved(
  supabase: DB,
  projectId: string,
  approval: { id: string; title: string; signerName: string | null },
): Promise<void> {
  await fireProjectTrigger(supabase, "client_approved", projectId, {
    payload: {
      approval_id: approval.id,
      approval: approval.title,
      signer_name: approval.signerName ?? "",
    },
    triggerKey: `${approval.id}:approved`,
  });
}

/**
 * The project has sat untouched past the Delivery stalled threshold.
 *
 * Carries what is still owed on it, because the escalation that finally gets
 * a stalled job moving is the one that names the money at stake.
 */
export async function fireProjectStalled(
  supabase: DB,
  projectId: string,
  detail: { days: number; stage: string | null },
): Promise<void> {
  const money = await projectOutstanding(supabase, projectId);
  await fireProjectTrigger(supabase, "project_stalled", projectId, {
    payload: {
      idle_days: detail.days,
      stage: detail.stage ?? "",
      balance: money.balance,
      amount: money.text,
      // A whole clause, so an escalation message reads correctly on a
      // project that happens to be fully paid as well as one that isn't.
      money_line: money.text ? `${money.text} is still outstanding. ` : "",
    },
    // The alert stamp is what re-arms; key on it so a project that stalls
    // again months later enrolls again.
    triggerKey: `${projectId}:stalled:${new Date().toISOString().slice(0, 10)}`,
  });
}

// ---------------------------------------------------------------------------

/**
 * What a project is still owed, formatted for a message.
 *
 * Goes through balanceDue() like everything else — deposit_paid and the
 * payment rows are the same money, and adding them would overstate what has
 * been received on nine projects out of ten.
 */
async function projectOutstanding(
  supabase: DB,
  projectId: string,
): Promise<{ balance: number; text: string }> {
  const [{ data: project }, { data: own }, { data: linked }] = await Promise.all([
    supabase
      .from("projects")
      .select("currency, total_value, deposit_paid")
      .eq("id", projectId)
      .maybeSingle(),
    supabase.from("payments").select("amount, status").eq("project_id", projectId),
    supabase
      .from("company_payments")
      .select("price_lkr, is_paid")
      .eq("project_id", projectId),
  ]);
  if (!project) return { balance: 0, text: "" };

  const { balanceDue } = await import("@/lib/projects");
  const balance = balanceDue({
    total_value: project.total_value,
    deposit_paid: project.deposit_paid,
    payments: own ?? [],
    company_payments: linked ?? [],
  });
  return {
    balance,
    text: balance > 0 ? `${project.currency} ${balance.toLocaleString()}` : "",
  };
}
