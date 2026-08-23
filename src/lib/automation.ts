import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AssetCategory,
  AutomationTrigger,
  Database,
  ProjectStatus,
} from "@/lib/database.types";
import { appLink } from "@/lib/app-url";
import { DELIVERY_STAGES } from "@/lib/constants";
import { sendGenericEmail } from "@/lib/email";
import { sendPushToUser } from "@/lib/push";
import { sendSmsToUser } from "@/lib/sms-alerts";
import { sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;
type Automation = Database["public"]["Tables"]["automations"]["Row"];
type Step = Database["public"]["Tables"]["automation_steps"]["Row"];
type Run = Database["public"]["Tables"]["automation_runs"]["Row"];
type Lead = Database["public"]["Tables"]["leads"]["Row"];

/** How many due runs one tick processes. */
const MAX_RUNS_PER_TICK = 50;
/** Hard cap of steps executed in one advance, so loops can't run away. */
const MAX_STEPS_PER_ADVANCE = 30;

// ---------------------------------------------------------------------------
// Trigger events
// ---------------------------------------------------------------------------

export type TriggerEvent = {
  trigger: AutomationTrigger;
  /** The lead this event is about, when there is one. */
  lead?: Pick<
    Lead,
    | "id"
    | "pipeline_id"
    | "stage_id"
    | "title"
    | "contact_name"
    | "contact_email"
    | "contact_phone"
    | "value"
    | "tags"
    | "source"
    | "status"
    | "score"
    | "assigned_to"
    | "client_id"
  > | null;
  client?: {
    id: string;
    name: string;
    email?: string | null;
    phone?: string | null;
  } | null;
  /** The project this event is about (0085 — delivery triggers). */
  project?: {
    id: string;
    name: string;
  } | null;
  /** Extra values exposed to message tokens as {{key}}. */
  payload?: Record<string, unknown>;
  /** De-dup key; when set, the same automation won't enroll it twice. */
  triggerKey?: string;
};

/**
 * Fire an event trigger: enroll the subject into every active automation
 * listening for it (whose filters + conditions pass) and immediately execute
 * the first steps. Never throws — automations must not break the write path
 * that fired them.
 */
export async function fireAutomationTrigger(
  supabase: DB,
  event: TriggerEvent,
): Promise<void> {
  try {
    const { data: automations } = await supabase
      .from("automations")
      .select("*")
      .eq("trigger", event.trigger)
      .eq("is_active", true);
    if (!automations?.length) return;

    // AUTO-7 (0096) — one project can be stood down without pausing the
    // automation for every other job it runs on. Checked here rather than in
    // each caller so it holds for delivery stage moves and payments too.
    if (event.project && (await isProjectAutomationPaused(supabase, event.project.id)))
      return;

    for (const automation of automations) {
      if (!matchesTriggerConfig(automation, event)) continue;
      if (event.lead && !passesConditions(automation, event.lead)) continue;
      await enrollRun(supabase, automation, event);
    }
  } catch (e) {
    console.error("[automation] fireAutomationTrigger failed:", e);
  }
}

/** AUTO-7 — is every automation stood down for this project? */
async function isProjectAutomationPaused(
  supabase: DB,
  projectId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("projects")
    .select("automation_paused")
    .eq("id", projectId)
    .maybeSingle();
  return Boolean(data?.automation_paused);
}

function matchesTriggerConfig(automation: Automation, event: TriggerEvent): boolean {
  const cfg = (automation.trigger_config ?? {}) as Record<string, unknown>;
  const lead = event.lead;
  if (cfg.pipeline_id && lead && lead.pipeline_id !== cfg.pipeline_id) return false;

  switch (automation.trigger) {
    case "stage_changed":
      // No stage filter = any stage move.
      return !cfg.stage_id || lead?.stage_id === cfg.stage_id;
    case "tag_added":
      return (
        !cfg.tag ||
        String(cfg.tag).toLowerCase() ===
          String(event.payload?.tag ?? "").toLowerCase()
      );
    case "webhook":
      return !cfg.endpoint_id || cfg.endpoint_id === event.payload?.endpoint_id;
    case "wa_message_received": {
      // Optional keyword filter — "any WhatsApp message containing X".
      const keyword = String(cfg.keyword ?? "").trim().toLowerCase();
      if (!keyword) return true;
      return String(event.payload?.message ?? "")
        .toLowerCase()
        .includes(keyword);
    }
    case "payment_received":
      // Optional installment filter — seq 1 = "the deposit landed" — and the
      // 0085 "first payment on the project" filter for delivery kickoffs.
      if (cfg.seq && Number(event.payload?.seq ?? 0) !== Number(cfg.seq))
        return false;
      if (cfg.first_payment && !event.payload?.first_payment) return false;
      return true;
    case "project_stage_changed":
      // No stage filter = any delivery-stage move.
      return !cfg.stage || event.payload?.new_stage === cfg.stage;

    // 0096 — project triggers. Every filter is optional: blank fires on all.
    case "project_created":
    case "project_completed": {
      const service = String(cfg.service_type ?? "").trim().toLowerCase();
      if (!service) return true;
      return String(event.payload?.service_type ?? "").toLowerCase() === service;
    }
    case "expense_added": {
      const category = String(cfg.category ?? "").trim().toLowerCase();
      if (category && String(event.payload?.category ?? "").toLowerCase() !== category)
        return false;
      const min = Number(cfg.min_amount ?? 0);
      if (min > 0 && Number(event.payload?.amount ?? 0) < min) return false;
      return true;
    }
    case "milestone_completed": {
      const keyword = String(cfg.keyword ?? "").trim().toLowerCase();
      if (!keyword) return true;
      return String(event.payload?.milestone ?? "")
        .toLowerCase()
        .includes(keyword);
    }
    default:
      return true;
  }
}

type Condition = { field?: string; op?: string; value?: unknown };

/** All conditions must pass. Unknown fields/ops fail safe (block the run). */
export function passesConditions(
  automation: Automation,
  lead: NonNullable<TriggerEvent["lead"]>,
): boolean {
  const conditions = (automation.conditions ?? []) as Condition[];
  if (!Array.isArray(conditions) || conditions.length === 0) return true;

  return conditions.every((c) => {
    if (!c?.field || !c?.op) return true;
    const actual = (lead as unknown as Record<string, unknown>)[c.field];
    const expected = c.value;

    switch (c.op) {
      case "eq":
        return String(actual ?? "") === String(expected ?? "");
      case "neq":
        return String(actual ?? "") !== String(expected ?? "");
      case "contains":
        if (Array.isArray(actual))
          return actual.map(String).some(
            (v) => v.toLowerCase() === String(expected).toLowerCase(),
          );
        return String(actual ?? "")
          .toLowerCase()
          .includes(String(expected ?? "").toLowerCase());
      case "not_contains":
        if (Array.isArray(actual))
          return !actual.map(String).some(
            (v) => v.toLowerCase() === String(expected).toLowerCase(),
          );
        return !String(actual ?? "")
          .toLowerCase()
          .includes(String(expected ?? "").toLowerCase());
      case "gt":
        return Number(actual ?? 0) > Number(expected ?? 0);
      case "lt":
        return Number(actual ?? 0) < Number(expected ?? 0);
      case "is_set":
        return actual !== null && actual !== undefined && actual !== "";
      case "not_set":
        return actual === null || actual === undefined || actual === "";
      default:
        return false;
    }
  });
}

/** Enroll a subject into one specific automation, bypassing trigger matching
 *  (used by inbound webhook endpoints wired to an automation). */
export async function enrollAutomationRun(
  supabase: DB,
  automation: Automation,
  event: TriggerEvent,
): Promise<void> {
  await enrollRun(supabase, automation, event);
}

async function enrollRun(
  supabase: DB,
  automation: Automation,
  event: TriggerEvent,
): Promise<void> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const payloadName = payload.name != null ? String(payload.name) : "";
  const payloadPhone = payload.phone != null ? String(payload.phone) : null;
  const payloadEmail = payload.email != null ? String(payload.email) : null;
  const subjectName =
    event.lead?.contact_name ||
    event.lead?.title ||
    event.client?.name ||
    payloadName;

  // Project id/name ride in context too, so {{project_name}} works as a
  // token everywhere without renderTokens learning anything new.
  const context = { ...(event.payload ?? {}) } as Record<string, unknown>;
  if (event.project) {
    context.project_id = event.project.id;
    context.project_name = event.project.name;
  }

  const { data: run, error } = await supabase
    .from("automation_runs")
    .insert({
      automation_id: automation.id,
      lead_id: event.lead?.id ?? null,
      client_id: event.client?.id || event.lead?.client_id || null,
      project_id: event.project?.id ?? null,
      subject_name: subjectName,
      subject_phone:
        event.lead?.contact_phone ?? event.client?.phone ?? payloadPhone,
      subject_email:
        event.lead?.contact_email ?? event.client?.email ?? payloadEmail,
      context,
      trigger_key: event.triggerKey ?? null,
    })
    .select("*")
    .single();

  // Unique violation on trigger_key = already enrolled for this occurrence.
  if (error || !run) return;

  await supabase
    .from("automations")
    .update({
      runs_started: (automation.runs_started ?? 0) + 1,
      last_run_at: new Date().toISOString(),
    })
    .eq("id", automation.id);

  if (run.lead_id) {
    await supabase.from("lead_activities").insert({
      lead_id: run.lead_id,
      kind: "automation",
      title: `Automation "${automation.name}" started`,
      meta: { automation_id: automation.id, run_id: run.id },
      actor_id: null,
    });
  }

  // Execute leading instant steps right away for a snappy experience.
  const { data: steps } = await supabase
    .from("automation_steps")
    .select("*")
    .eq("automation_id", automation.id)
    .order("position", { ascending: true });
  await advanceRun(supabase, run, steps ?? [], automation.trigger);
}

// ---------------------------------------------------------------------------
// Tick — timers + time-based trigger scanning
// ---------------------------------------------------------------------------

export type AutomationTickResult = {
  processed: number;
  enrolled: number;
  failed: number;
};

/** Advance all due runs; called from the tick route and opportunistically. */
export async function processDueAutomationRuns(
  supabase: DB,
): Promise<AutomationTickResult> {
  const result: AutomationTickResult = { processed: 0, enrolled: 0, failed: 0 };

  const { data: dueRuns } = await supabase
    .from("automation_runs")
    .select("*")
    .eq("status", "running")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(MAX_RUNS_PER_TICK);
  if (!dueRuns?.length) return result;

  const automationIds = Array.from(new Set(dueRuns.map((r) => r.automation_id)));
  const [{ data: automations }, { data: allSteps }] = await Promise.all([
    supabase
      .from("automations")
      .select("id, is_active, trigger")
      .in("id", automationIds),
    supabase
      .from("automation_steps")
      .select("*")
      .in("automation_id", automationIds)
      .order("position", { ascending: true }),
  ]);

  const activeIds = new Set(
    (automations ?? []).filter((a) => a.is_active).map((a) => a.id),
  );

  // AUTO-7 (0096) — a paused project's in-flight runs stand still too, or a
  // pause would only stop new enrolments while yesterday's chase ladder kept
  // firing. They resume from the same step the moment it is un-paused.
  const projectIds = Array.from(
    new Set(dueRuns.map((r) => r.project_id).filter((id): id is string => !!id)),
  );
  const pausedProjects = new Set<string>();
  if (projectIds.length) {
    const { data: paused } = await supabase
      .from("projects")
      .select("id")
      .in("id", projectIds)
      .eq("automation_paused", true);
    for (const row of paused ?? []) pausedProjects.add(row.id);
  }

  const triggerById = new Map(
    (automations ?? []).map((a) => [a.id, a.trigger]),
  );
  const stepsByAutomation = new Map<string, Step[]>();
  for (const step of allSteps ?? []) {
    const list = stepsByAutomation.get(step.automation_id) ?? [];
    list.push(step);
    stepsByAutomation.set(step.automation_id, list);
  }

  for (const run of dueRuns) {
    if (!activeIds.has(run.automation_id)) continue; // paused automation
    if (run.project_id && pausedProjects.has(run.project_id)) continue; // paused project
    result.processed++;
    const ok = await advanceRun(
      supabase,
      run,
      stepsByAutomation.get(run.automation_id) ?? [],
      triggerById.get(run.automation_id) ?? null,
    );
    if (!ok) result.failed++;
  }
  return result;
}

/**
 * Scan for time-based trigger matches (inactivity, close dates, unpaid
 * invoices, installments, cheques) and enroll them. Dedup handled via
 * trigger_key, so re-scanning is harmless.
 */
export async function scanTimeBasedTriggers(supabase: DB): Promise<number> {
  let enrolled = 0;
  const { data: automations } = await supabase
    .from("automations")
    .select("*")
    .eq("is_active", true)
    .in("trigger", [
      "lead_created",
      "lead_inactive",
      "date_reached",
      "invoice_unpaid",
      "installment_due",
      "cheque_due",
      // 0096 — project timers
      "project_due_soon",
      "project_overdue",
      "balance_overdue",
    ]);
  if (!automations?.length) return 0;

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  for (const automation of automations) {
    const cfg = (automation.trigger_config ?? {}) as Record<string, unknown>;
    try {
      switch (automation.trigger) {
        // Safety net: leads created in the last 24h that slipped past the
        // in-process hook (imports, API, assistant). trigger_key dedupes.
        case "lead_created": {
          const since = new Date(now - 24 * 3600_000).toISOString();
          let q = supabase
            .from("leads")
            .select("*")
            .gte("created_at", since)
            .is("deleted_at", null);
          if (cfg.pipeline_id) q = q.eq("pipeline_id", String(cfg.pipeline_id));
          const { data: leads } = await q;
          for (const lead of leads ?? []) {
            if (!passesConditions(automation, lead)) continue;
            await enrollRun(supabase, automation, {
              trigger: "lead_created",
              lead,
              triggerKey: `${lead.id}:created`,
            });
            enrolled++;
          }
          break;
        }
        case "lead_inactive": {
          const days = Math.max(1, Number(cfg.days ?? 7));
          const cutoff = new Date(now - days * 24 * 3600_000).toISOString();
          let q = supabase
            .from("leads")
            .select("*")
            .eq("status", "open")
            .is("deleted_at", null)
            .lt("last_activity_at", cutoff);
          if (cfg.pipeline_id) q = q.eq("pipeline_id", String(cfg.pipeline_id));
          const { data: leads } = await q;
          for (const lead of leads ?? []) {
            if (!passesConditions(automation, lead)) continue;
            await enrollRun(supabase, automation, {
              trigger: "lead_inactive",
              lead,
              payload: { days },
              // Re-fires only after fresh activity goes stale again.
              triggerKey: `${lead.id}:inactive:${lead.last_activity_at}`,
            });
            enrolled++;
          }
          break;
        }
        case "date_reached": {
          const daysBefore = Math.max(0, Number(cfg.days_before ?? 0));
          const target = new Date(now + daysBefore * 24 * 3600_000)
            .toISOString()
            .slice(0, 10);
          let q = supabase
            .from("leads")
            .select("*")
            .eq("status", "open")
            .is("deleted_at", null)
            .lte("expected_close_date", target)
            .gte("expected_close_date", today);
          if (cfg.pipeline_id) q = q.eq("pipeline_id", String(cfg.pipeline_id));
          const { data: leads } = await q;
          for (const lead of leads ?? []) {
            if (!passesConditions(automation, lead)) continue;
            await enrollRun(supabase, automation, {
              trigger: "date_reached",
              lead,
              payload: { expected_close_date: lead.expected_close_date },
              triggerKey: `${lead.id}:close:${lead.expected_close_date}`,
            });
            enrolled++;
          }
          break;
        }
        case "invoice_unpaid": {
          const days = Math.max(1, Number(cfg.days ?? 3));
          const cutoff = new Date(now - days * 24 * 3600_000).toISOString();
          const { data: invoices } = await supabase
            .from("invoices")
            .select("*")
            .is("stamp", null)
            .not("sent_at", "is", null)
            .lt("sent_at", cutoff);
          for (const inv of invoices ?? []) {
            await enrollRun(supabase, automation, {
              trigger: "invoice_unpaid",
              payload: {
                invoice_number: inv.invoice_number,
                amount: inv.grand_total,
                name: inv.bill_to_name,
                email: inv.recipient_email,
              },
              triggerKey: `${inv.id}:unpaid:${days}`,
            });
            enrolled++;
          }
          break;
        }
        case "installment_due": {
          const daysBefore = Math.max(0, Number(cfg.days_before ?? 2));
          const target = new Date(now + daysBefore * 24 * 3600_000)
            .toISOString()
            .slice(0, 10);
          const { data: due } = await supabase
            .from("payment_installments")
            .select("*, plan:payment_plans(*)")
            .eq("status", "pending")
            .lte("due_date", target)
            .gte("due_date", today);
          for (const inst of due ?? []) {
            const plan = (inst as unknown as {
              plan: Database["public"]["Tables"]["payment_plans"]["Row"] | null;
            }).plan;
            if (!plan || plan.status !== "active") continue;
            await enrollRun(supabase, automation, {
              trigger: "installment_due",
              client: plan.client_id
                ? { id: plan.client_id, name: plan.contact_name, phone: plan.phone }
                : null,
              payload: {
                name: plan.contact_name,
                phone: plan.phone,
                amount: inst.amount,
                due_date: inst.due_date,
                plan_title: plan.title,
              },
              triggerKey: `${inst.id}:due`,
            });
            enrolled++;
          }
          break;
        }
        // -------------------------------------------------------------
        // 0096 — project timers (AUTO-1)
        //
        // All three resolve the project through projectEventBase(), so a
        // paused project (AUTO-7) is skipped and every run carries the same
        // client + portal_link tokens the event triggers do.
        // -------------------------------------------------------------
        case "project_due_soon":
        case "project_overdue": {
          const overdue = automation.trigger === "project_overdue";
          const days = Math.max(0, Number(cfg.days ?? (overdue ? 0 : 3)));
          const boundary = new Date(
            now + (overdue ? -days : days) * 24 * 3600_000,
          )
            .toISOString()
            .slice(0, 10);

          let q = supabase
            .from("projects")
            .select("id, due_date")
            .is("deleted_at", null)
            .eq("automation_paused", false)
            .in("status", ["planning", "active", "on_hold"])
            .not("due_date", "is", null);
          // due_soon: from today up to the horizon.
          // overdue: at or before the boundary AND strictly before today —
          // the second guard matters at days = 0, where the boundary IS
          // today and a project due this afternoon is not yet late.
          q = overdue
            ? q.lte("due_date", boundary).lt("due_date", today)
            : q.gte("due_date", today).lte("due_date", boundary);

          const { data: projects } = await q.limit(100);
          if (!projects?.length) break;

          const { projectEventBase } = await import("@/lib/project-events");
          for (const row of projects) {
            const base = await projectEventBase(supabase, row.id);
            if (!base) continue;
            // Whole calendar days, both sides read as UTC midnight. Comparing
            // the due date against `now` instead would report a project due
            // yesterday as two days overdue by mid-afternoon.
            const diff = Math.round(
              (Date.parse(`${row.due_date}T00:00:00Z`) -
                Date.parse(`${today}T00:00:00Z`)) /
                (24 * 3600_000),
            );
            await enrollRun(supabase, automation, {
              trigger: automation.trigger,
              project: base.project,
              client: base.client,
              payload: {
                ...base.payload,
                days_left: Math.max(0, diff),
                days_overdue: Math.max(0, -diff),
              },
              // Keyed on the deadline: moving the date re-arms the trigger,
              // and leaving it alone never fires twice.
              triggerKey: `${row.id}:${automation.trigger}:${row.due_date}`,
            });
            enrolled++;
          }
          break;
        }
        case "balance_overdue": {
          const days = Math.max(0, Number(cfg.days ?? 7));
          const cutoff = new Date(now - days * 24 * 3600_000).toISOString();
          const { data: projects } = await supabase
            .from("projects")
            .select("id, currency, total_value, deposit_paid")
            .is("deleted_at", null)
            .eq("automation_paused", false)
            .eq("delivery_stage", "delivered")
            .gt("total_value", 0)
            .lt("delivery_stage_changed_at", cutoff)
            .limit(100);
          if (!projects?.length) break;

          // One round-trip for the money, not one per project. Both ledgers,
          // because settledAmount() reconciles across them.
          const ids = projects.map((p) => p.id);
          const [{ data: own }, { data: linked }] = await Promise.all([
            supabase
              .from("payments")
              .select("project_id, amount, status")
              .in("project_id", ids),
            supabase
              .from("company_payments")
              .select("project_id, price_lkr, is_paid")
              .in("project_id", ids),
          ]);

          const { balanceDue } = await import("@/lib/projects");
          const { projectEventBase } = await import("@/lib/project-events");
          for (const row of projects) {
            const balance = balanceDue({
              total_value: row.total_value,
              deposit_paid: row.deposit_paid,
              payments: (own ?? []).filter((p) => p.project_id === row.id),
              company_payments: (linked ?? []).filter(
                (p) => p.project_id === row.id,
              ),
            });
            if (balance <= 0) continue;
            const base = await projectEventBase(supabase, row.id);
            if (!base) continue;
            await enrollRun(supabase, automation, {
              trigger: "balance_overdue",
              project: base.project,
              client: base.client,
              payload: {
                ...base.payload,
                balance,
                amount: `${row.currency} ${balance.toLocaleString()}`,
                days_since_delivery: days,
              },
              // Re-fires when the ladder is widened, not every tick.
              triggerKey: `${row.id}:balance_overdue:${days}`,
            });
            enrolled++;
          }
          break;
        }
        case "cheque_due": {
          const daysBefore = Math.max(0, Number(cfg.days_before ?? 1));
          const target = new Date(now + daysBefore * 24 * 3600_000)
            .toISOString()
            .slice(0, 10);
          const { data: cheques } = await supabase
            .from("cheques")
            .select("*")
            .eq("status", "pending")
            .lte("due_date", target);
          for (const cheque of cheques ?? []) {
            await enrollRun(supabase, automation, {
              trigger: "cheque_due",
              payload: {
                name: cheque.party_name,
                amount: cheque.amount,
                due_date: cheque.due_date,
                bank: cheque.bank,
                cheque_number: cheque.cheque_number,
              },
              triggerKey: `${cheque.id}:due:${cheque.due_date}`,
            });
            enrolled++;
          }
          break;
        }
      }
    } catch (e) {
      console.error(`[automation] scan failed for ${automation.id}:`, e);
    }
  }
  return enrolled;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/** Replace {{tokens}} with subject/context values. */
export function renderTokens(
  text: string,
  run: Pick<Run, "subject_name" | "subject_phone" | "subject_email" | "context">,
  lead?: Lead | null,
): string {
  const fullName = (run.subject_name || "").trim();
  const firstName = fullName.split(/\s+/)[0] || "there";
  const ctx = (run.context ?? {}) as Record<string, unknown>;

  let out = text
    .replaceAll("{{name}}", firstName)
    .replaceAll("{{full_name}}", fullName || "there")
    .replaceAll("{{phone}}", run.subject_phone ?? "")
    .replaceAll("{{email}}", run.subject_email ?? "");

  if (lead) {
    out = out
      .replaceAll("{{title}}", lead.title ?? "")
      .replaceAll("{{company}}", lead.company ?? "")
      .replaceAll("{{value}}", lead.value != null ? String(lead.value) : "");
  }
  for (const [key, value] of Object.entries(ctx)) {
    out = out.replaceAll(`{{${key}}}`, value == null ? "" : String(value));
  }
  return out;
}

/** Nudge-class = the automation fires on a timer, not on a customer action.
 * Cold outreach (a prospected lead's first touch) is unprompted too. */
function isNudgeTrigger(
  trigger: string | null,
  lead: { source?: string | null } | null,
): boolean {
  if (!trigger) return false;
  if (
    [
      "lead_inactive",
      "invoice_unpaid",
      "installment_due",
      "cheque_due",
      "date_reached",
      // 0085 — post-delivery recipes are wait-then-message chains (review
      // ask, testimonial, aftercare); by send time the client did nothing
      // recent, so they must respect quiet hours like any other nudge.
      "project_delivered",
      // 0096 — every project timer is unprompted by definition: nobody did
      // anything, a date passed. Chasing a deadline at 2am is still a chase.
      "project_due_soon",
      "project_overdue",
      "balance_overdue",
      "project_stalled",
      "expenses_over_budget",
    ].includes(trigger)
  ) {
    return true;
  }
  return trigger === "lead_created" && lead?.source === "prospecting";
}

/**
 * Execute steps from run.step_index until a wait pushes the run forward,
 * a step fails, or the run completes. Returns false when the run failed.
 */
async function advanceRun(
  supabase: DB,
  run: Run,
  steps: Step[],
  trigger: string | null = null,
): Promise<boolean> {
  let index = run.step_index;
  const log = Array.isArray(run.log) ? [...run.log] : [];

  const lead = run.lead_id
    ? (await supabase.from("leads").select("*").eq("id", run.lead_id).single())
        .data
    : null;

  for (let guard = 0; guard < MAX_STEPS_PER_ADVANCE; guard++) {
    if (index >= steps.length) {
      await supabase
        .from("automation_runs")
        .update({
          step_index: index,
          status: "completed",
          log,
          completed_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      return true;
    }

    const step = steps[index];
    const cfg = (step.config ?? {}) as Record<string, unknown>;

    // Quiet hours: nudge-class WhatsApp sends (inactivity chases, unpaid
    // reminders, cold outreach) wait for morning. Event-response sends
    // (quote signed, payment received, inbound message) go out immediately
    // whatever the hour — the customer is actively in the flow.
    if (step.kind === "send_whatsapp" && isNudgeTrigger(trigger, lead)) {
      const { getWaAgentConfig, isQuietHours, nextQuietHoursEnd } =
        await import("@/lib/wa-agent");
      const waConfig = await getWaAgentConfig(supabase);
      if (isQuietHours(waConfig)) {
        const resume = nextQuietHoursEnd(waConfig).toISOString();
        log.push({
          step: "send_whatsapp",
          at: new Date().toISOString(),
          ok: true,
          detail: `Deferred to ${resume} — quiet hours`,
        });
        // Step index stays put: the run resumes at this exact send.
        await supabase
          .from("automation_runs")
          .update({ next_run_at: resume, log })
          .eq("id", run.id);
        return true;
      }
    }

    if (step.kind === "wait") {
      const minutes = Math.max(0, Number(cfg.minutes ?? 0));
      log.push({ step: "wait", at: new Date().toISOString(), ok: true, detail: `${minutes} min` });
      await supabase
        .from("automation_runs")
        .update({
          step_index: index + 1,
          next_run_at: new Date(Date.now() + minutes * 60_000).toISOString(),
          log,
        })
        .eq("id", run.id);
      return true;
    }

    let outcome: { ok: boolean; detail: string };
    try {
      outcome = await executeStep(supabase, run, step, cfg, lead);
    } catch (e) {
      outcome = { ok: false, detail: e instanceof Error ? e.message : "Step crashed." };
    }
    log.push({
      step: step.kind,
      at: new Date().toISOString(),
      ok: outcome.ok,
      detail: outcome.detail,
    });

    if (!outcome.ok) {
      await supabase
        .from("automation_runs")
        .update({ step_index: index, status: "failed", error: outcome.detail, log })
        .eq("id", run.id);
      return false;
    }

    index++;
    await supabase
      .from("automation_runs")
      .update({ step_index: index, log })
      .eq("id", run.id);
  }

  // Guard tripped — mark failed so it doesn't spin forever.
  await supabase
    .from("automation_runs")
    .update({ status: "failed", error: "Too many steps in one run.", log })
    .eq("id", run.id);
  return false;
}

async function executeStep(
  supabase: DB,
  run: Run,
  step: Step,
  cfg: Record<string, unknown>,
  lead: Lead | null,
): Promise<{ ok: boolean; detail: string }> {
  switch (step.kind) {
    case "send_sms": {
      const raw = run.subject_phone ?? "";
      const phone = normalizePhone(raw);
      if (!phone.ok) return { ok: false, detail: `No valid phone (${raw || "empty"}).` };
      const message = renderTokens(String(cfg.message ?? ""), run, lead).trim();
      if (!message) return { ok: false, detail: "SMS step has no message." };

      const sent = await sendSms({
        to: phone.value,
        message,
        contactName: run.subject_name || undefined,
      });
      await supabase.from("sms_messages").insert({
        to_number: phone.value,
        message,
        client_id: run.client_id,
        client_name: run.subject_name,
        kind: "automation",
        status: sent.ok ? "sent" : "failed",
        error: sent.ok ? null : sent.error,
        segments: countSmsSegments(message),
        created_by: null,
      });
      if (run.lead_id) {
        await supabase.from("lead_activities").insert({
          lead_id: run.lead_id,
          kind: "sms",
          title: sent.ok ? "Automated SMS sent" : "Automated SMS failed",
          body: message,
          actor_id: null,
        });
      }
      return sent.ok
        ? { ok: true, detail: `SMS to ${phone.value}` }
        : { ok: false, detail: sent.error };
    }

    case "send_email": {
      const to = run.subject_email?.trim();
      if (!to) return { ok: false, detail: "Subject has no email address." };
      const subject = renderTokens(String(cfg.subject ?? ""), run, lead).trim();
      const body = renderTokens(String(cfg.body ?? ""), run, lead).trim();
      if (!subject || !body) return { ok: false, detail: "Email step needs a subject and body." };
      const sent = await sendGenericEmail({ to, subject, body });
      if (run.lead_id) {
        await supabase.from("lead_activities").insert({
          lead_id: run.lead_id,
          kind: "email",
          title: sent.sent ? `Automated email: ${subject}` : "Automated email failed",
          body,
          actor_id: null,
        });
      }
      return sent.sent
        ? { ok: true, detail: `Email to ${to}` }
        : { ok: false, detail: sent.error ?? "Email failed." };
    }

    case "create_task": {
      const title = renderTokens(String(cfg.title ?? "Follow up"), run, lead).trim();
      const dueInDays = Number(cfg.due_in_days ?? 1);
      const { error } = await supabase.from("crm_tasks").insert({
        lead_id: run.lead_id,
        title,
        notes: cfg.notes ? renderTokens(String(cfg.notes), run, lead) : null,
        due_at: new Date(Date.now() + dueInDays * 24 * 3600_000).toISOString(),
        assigned_to: (cfg.assigned_to as string) || null,
        created_by: null,
      });
      return error
        ? { ok: false, detail: error.message }
        : { ok: true, detail: `Task "${title}"` };
    }

    case "add_tag":
    case "remove_tag": {
      if (!lead) return { ok: false, detail: "No lead on this run." };
      const tag = String(cfg.tag ?? "").trim();
      if (!tag) return { ok: false, detail: "No tag configured." };
      const tags = new Set(lead.tags ?? []);
      if (step.kind === "add_tag") tags.add(tag);
      else tags.delete(tag);
      const { error } = await supabase
        .from("leads")
        .update({ tags: Array.from(tags) })
        .eq("id", lead.id);
      lead.tags = Array.from(tags);
      return error
        ? { ok: false, detail: error.message }
        : { ok: true, detail: `${step.kind === "add_tag" ? "+" : "-"}${tag}` };
    }

    case "assign_user": {
      if (!lead) return { ok: false, detail: "No lead on this run." };
      const userId = String(cfg.user_id ?? "");
      if (!userId) return { ok: false, detail: "No user configured." };
      const { error } = await supabase
        .from("leads")
        .update({ assigned_to: userId })
        .eq("id", lead.id);
      if (error) return { ok: false, detail: error.message };
      await supabase.from("notifications").insert({
        user_id: userId,
        type: "assignment",
        title: "Automation assigned you a lead",
        body: lead.title,
        link: `/crm/lead/${lead.id}`,
      });
      await sendPushToUser({
        userId,
        title: "Automation assigned you a lead",
        body: lead.title,
        link: `/crm/lead/${lead.id}`,
      });
      await sendSmsToUser({
        userId,
        message: `ARC AI: you were assigned a lead — "${lead.title}". Check the CRM pipeline.`,
      });
      return { ok: true, detail: "Lead assigned" };
    }

    case "move_stage": {
      if (!lead) return { ok: false, detail: "No lead on this run." };
      const stageId = String(cfg.stage_id ?? "");
      if (!stageId) return { ok: false, detail: "No stage configured." };
      const { error } = await supabase
        .from("leads")
        .update({ stage_id: stageId })
        .eq("id", lead.id);
      return error
        ? { ok: false, detail: error.message }
        : { ok: true, detail: "Stage moved" };
    }

    case "update_field": {
      if (!lead) return { ok: false, detail: "No lead on this run." };
      const field = String(cfg.field ?? "");
      const value = renderTokens(String(cfg.value ?? ""), run, lead);
      if (!field) return { ok: false, detail: "No field configured." };
      let patch: Record<string, unknown>;
      if (field.startsWith("custom.")) {
        patch = {
          custom: { ...(lead.custom ?? {}), [field.slice(7)]: value },
        };
      } else {
        const allowed = new Set([
          "notes", "source", "value", "probability", "expected_close_date",
          "contact_email", "contact_phone", "contact_name", "company",
        ]);
        if (!allowed.has(field)) return { ok: false, detail: `Field "${field}" not allowed.` };
        patch = {
          [field]:
            field === "value" || field === "probability" ? Number(value) : value,
        };
      }
      const { error } = await supabase
        .from("leads")
        .update(patch as Database["public"]["Tables"]["leads"]["Update"])
        .eq("id", lead.id);
      return error
        ? { ok: false, detail: error.message }
        : { ok: true, detail: `Set ${field}` };
    }

    case "update_score": {
      if (!lead) return { ok: false, detail: "No lead on this run." };
      const score = String(cfg.score ?? "");
      if (!["hot", "warm", "cold"].includes(score))
        return { ok: false, detail: "Score must be hot/warm/cold." };
      const { error } = await supabase
        .from("leads")
        .update({ score: score as "hot" | "warm" | "cold", score_reason: "Set by automation" })
        .eq("id", lead.id);
      return error
        ? { ok: false, detail: error.message }
        : { ok: true, detail: `Scored ${score}` };
    }

    case "notify": {
      const title = renderTokens(String(cfg.title ?? "Automation"), run, lead);
      const body = renderTokens(String(cfg.body ?? ""), run, lead);
      const link = run.project_id
        ? `/projects/${run.project_id}`
        : run.lead_id
          ? `/crm/lead/${run.lead_id}`
          : "/automation";
      let userIds: string[] = [];
      if (cfg.user_id && cfg.user_id !== "all") {
        userIds = [String(cfg.user_id)];
      } else {
        const { data: profiles } = await supabase.from("profiles").select("id");
        userIds = (profiles ?? []).map((p) => p.id);
      }
      for (const userId of userIds) {
        await supabase.from("notifications").insert({
          user_id: userId,
          type: "system",
          title,
          body: body || null,
          link,
        });
        await sendPushToUser({ userId, title, body: body || title, link });
      }
      return { ok: true, detail: `Notified ${userIds.length} member(s)` };
    }

    case "webhook": {
      const url = String(cfg.url ?? "");
      if (!/^https?:\/\//.test(url)) return { ok: false, detail: "Webhook needs an http(s) URL." };
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "automation.step",
            run_id: run.id,
            subject: {
              name: run.subject_name,
              phone: run.subject_phone,
              email: run.subject_email,
            },
            lead_id: run.lead_id,
            context: run.context,
            payload: cfg.payload ?? null,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok
          ? { ok: true, detail: `POST ${url} → ${res.status}` }
          : { ok: false, detail: `Webhook returned HTTP ${res.status}.` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : "Webhook failed." };
      }
    }

    case "ai_agent": {
      const { isOpenAIConfigured, openaiChat } = await import("@/lib/ai/openai");
      if (!isOpenAIConfigured())
        return { ok: false, detail: "OPENAI_API_KEY is not configured." };
      const instruction = renderTokens(String(cfg.instruction ?? ""), run, lead);
      if (!instruction) return { ok: false, detail: "No instruction configured." };

      let history = "";
      if (lead) {
        const { data: activities } = await supabase
          .from("lead_activities")
          .select("kind, title, body, created_at")
          .eq("lead_id", lead.id)
          .order("created_at", { ascending: false })
          .limit(20);
        history = (activities ?? [])
          .map((a) => `${a.created_at.slice(0, 10)} [${a.kind}] ${a.title}${a.body ? ` — ${a.body}` : ""}`)
          .join("\n");
      }

      const reply = await openaiChat([
        {
          role: "system",
          content:
            "You are the AI sales assistant inside ARC AI's CRM. Reply with plain text only — no markdown headers. Be concise and practical.",
        },
        {
          role: "user",
          content: `${instruction}\n\nLead: ${lead ? JSON.stringify({ title: lead.title, contact: lead.contact_name, value: lead.value, status: lead.status, score: lead.score, source: lead.source, notes: lead.notes }) : run.subject_name}\n\nRecent history:\n${history || "(none)"}`,
        },
      ]);
      const text = (reply.content ?? "").trim();
      if (!text) return { ok: false, detail: "AI returned nothing." };

      const saveTo = String(cfg.save_to ?? "note");
      if (lead && saveTo === "ai_summary") {
        await supabase.from("leads").update({ ai_summary: text }).eq("id", lead.id);
      } else if (lead && saveTo === "ai_next_action") {
        await supabase.from("leads").update({ ai_next_action: text }).eq("id", lead.id);
      } else if (run.lead_id) {
        await supabase.from("lead_activities").insert({
          lead_id: run.lead_id,
          kind: "automation",
          title: "AI agent output",
          body: text,
          actor_id: null,
        });
      }
      return { ok: true, detail: `AI → ${saveTo}` };
    }

    case "send_whatsapp": {
      const {
        isWhatsAppConfigured,
        normalizeWaPhone,
        sendWhatsAppTemplate,
        sendWhatsAppText,
      } = await import("@/lib/whatsapp");
      if (!isWhatsAppConfigured())
        return { ok: false, detail: "WhatsApp isn't configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)." };

      const raw = run.subject_phone ?? "";
      const phone = normalizeWaPhone(raw);
      if (!phone.ok) return { ok: false, detail: `No valid phone (${raw || "empty"}).` };

      const templateName = String(cfg.template_name ?? "").trim();
      const message = renderTokens(String(cfg.message ?? ""), run, lead).trim();
      if (!templateName && !message)
        return { ok: false, detail: "WhatsApp step has no message." };

      // Template = deliverable outside the 24h window; free text otherwise.
      // template_params fill {{1}}, {{2}}… in order; each renders {{tokens}}
      // first, so "{{business}}" or "{{audit_score}}" work as variables.
      const bodyParams = (Array.isArray(cfg.template_params) ? cfg.template_params : [])
        .map((p) => renderTokens(String(p ?? ""), run, lead).trim());
      const sent = templateName
        ? await sendWhatsAppTemplate({
            to: phone.value,
            template: templateName,
            language: String(cfg.template_lang ?? "").trim() || "en",
            bodyParams: bodyParams.some(Boolean) ? bodyParams : undefined,
          })
        : await sendWhatsAppText({ to: phone.value, body: message });

      // Log the send into the WhatsApp inbox thread (create the contact if new).
      let { data: contact } = await supabase
        .from("wa_contacts")
        .select("id, wa_id")
        .eq("wa_id", phone.value)
        .maybeSingle();
      if (!contact) {
        const { data: created } = await supabase
          .from("wa_contacts")
          .upsert(
            {
              wa_id: phone.value,
              display_name: run.subject_name || null,
              lead_id: run.lead_id,
              client_id: run.client_id,
            },
            { onConflict: "wa_id" },
          )
          .select("id, wa_id")
          .single();
        contact = created;
      }
      if (contact) {
        const bodyText = templateName ? `[template: ${templateName}]` : message;
        await supabase.from("wa_messages").insert({
          contact_id: contact.id,
          wa_message_id: sent.ok ? sent.waMessageId : null,
          direction: "out",
          body: bodyText,
          status: sent.ok ? "sent" : "failed",
          error: sent.ok ? null : sent.error,
          sent_by: "automation",
        });
        await supabase
          .from("wa_contacts")
          .update({
            last_message_at: new Date().toISOString(),
            last_message_preview: bodyText.slice(0, 160),
            last_direction: "out",
          })
          .eq("id", contact.id);
      }

      if (run.lead_id) {
        await supabase.from("lead_activities").insert({
          lead_id: run.lead_id,
          kind: "automation",
          title: sent.ok ? "Automated WhatsApp sent" : "Automated WhatsApp failed",
          body: templateName ? `Template "${templateName}"` : message,
          actor_id: null,
        });
      }
      return sent.ok
        ? { ok: true, detail: `WhatsApp to +${phone.value}` }
        : { ok: false, detail: sent.error };
    }

    case "enroll_sms_workflow": {
      const workflowId = String(cfg.workflow_id ?? "");
      if (!workflowId) return { ok: false, detail: "No SMS workflow configured." };
      const raw = run.subject_phone ?? "";
      const phone = normalizePhone(raw);
      if (!phone.ok) return { ok: false, detail: `No valid phone (${raw || "empty"}).` };
      const { error } = await supabase.from("sms_workflow_runs").insert({
        workflow_id: workflowId,
        client_id: run.client_id,
        client_name: run.subject_name,
        to_number: phone.value,
        created_by: null,
      });
      return error
        ? { ok: false, detail: error.message }
        : { ok: true, detail: "Enrolled in SMS workflow" };
    }

    case "convert_quote_to_invoice": {
      const ctx = (run.context ?? {}) as Record<string, unknown>;
      const quoteId = String(ctx.quote_id ?? "");
      if (!quoteId)
        return { ok: false, detail: "No quote_id in the trigger context (fired by an old quote link?)." };
      const { data: quote } = await supabase
        .from("quotes")
        .select("*")
        .eq("id", quoteId)
        .maybeSingle();
      if (!quote) return { ok: false, detail: "Quote not found." };
      if (quote.invoice_id)
        return { ok: true, detail: "Quote is already invoiced — skipped." };

      // Same numbering style the AI invoice tool uses (#00201, #00202…).
      const { count } = await supabase
        .from("invoices")
        .select("*", { count: "exact", head: true });
      const invoiceNumber = "#" + String(200 + (count ?? 0) + 1).padStart(5, "0");
      const grandTotal = Number(quote.grand_total) || 0;
      const deposit = Math.round(grandTotal / 2);
      const today = new Date().toISOString().slice(0, 10);

      const { data: invoice, error } = await supabase
        .from("invoices")
        .insert({
          invoice_number: invoiceNumber,
          invoice_date: today,
          bill_to_name: quote.customer_name,
          bill_to_details: [quote.customer_phone, quote.customer_email]
            .filter(Boolean)
            .join("\n"),
          items: quote.items,
          grand_total: grandTotal,
          due_today: deposit,
          created_by: null,
        })
        .select("id")
        .single();
      if (error || !invoice)
        return { ok: false, detail: error?.message ?? "Invoice insert failed." };

      await supabase.from("quotes").update({ invoice_id: invoice.id }).eq("id", quoteId);

      // Payment plan (deposit + balance) so the money is trackable in
      // Finance — and marking the deposit paid fires `payment_received`.
      const { data: plan } = await supabase
        .from("payment_plans")
        .insert({
          title: quote.title || `Quote ${quote.quote_number}`,
          client_id: quote.client_id,
          lead_id: quote.lead_id,
          invoice_id: invoice.id,
          contact_name: quote.customer_name,
          phone: quote.customer_phone,
          total: grandTotal,
          currency: quote.currency,
          notes: `Created automatically from accepted quote ${quote.quote_number}.`,
          created_by: null,
        })
        .select("id")
        .single();
      if (plan) {
        await supabase.from("payment_installments").insert([
          { plan_id: plan.id, seq: 1, amount: deposit, due_date: today },
          {
            plan_id: plan.id,
            seq: 2,
            amount: grandTotal - deposit,
            due_date: new Date(Date.now() + 30 * 24 * 3600_000).toISOString().slice(0, 10),
          },
        ]);
      }

      // Expose the results to later steps' {{tokens}}.
      const fmt = (n: number) => `${quote.currency} ${n.toLocaleString()}`;
      const newContext = {
        ...ctx,
        invoice_number: invoiceNumber,
        deposit_amount: fmt(deposit),
        balance_amount: fmt(grandTotal - deposit),
        total_amount: fmt(grandTotal),
      };
      await supabase
        .from("automation_runs")
        .update({ context: newContext })
        .eq("id", run.id);
      run.context = newContext;

      if (run.lead_id) {
        await supabase.from("lead_activities").insert({
          lead_id: run.lead_id,
          kind: "automation",
          title: `Quote ${quote.quote_number} → invoice ${invoiceNumber}`,
          body: `Total ${fmt(grandTotal)}, deposit ${fmt(deposit)} due now. Payment plan created.`,
          actor_id: null,
        });
      }
      return { ok: true, detail: `Invoice ${invoiceNumber} + payment plan created` };
    }

    case "create_project": {
      const ctx = (run.context ?? {}) as Record<string, unknown>;
      const name =
        renderTokens(String(cfg.name ?? ""), run, lead).trim() ||
        String(ctx.plan_title ?? "").trim() ||
        `${run.subject_name || "New client"} — Website project`;
      const budget = Number(String(ctx.total ?? "")) || lead?.value || null;
      const deliveryStage = String(cfg.delivery_stage ?? "");
      const { data: project, error } = await supabase
        .from("projects")
        .insert({
          name,
          description: `Created automatically when the deposit landed${run.subject_name ? ` — client: ${run.subject_name}` : ""}.`,
          client_id: run.client_id,
          // BIG-2 (0099) — the run already knows where it came from, so record
          // it. A project created by automation is exactly the case where
          // nobody will ever go back and link it by hand.
          lead_id: run.lead_id,
          quote_id: ctx.quote_id ? String(ctx.quote_id) : null,
          status: "planning",
          budget,
          total_value: Number(String(ctx.total ?? "")) || null,
          service_type:
            String(cfg.service_type ?? "").trim() ||
            String(ctx.service_type ?? "").trim() ||
            null,
          delivery_stage: (DELIVERY_STAGES as readonly string[]).includes(
            deliveryStage,
          )
            ? (deliveryStage as (typeof DELIVERY_STAGES)[number])
            : null,
          currency: "LKR",
          start_date: new Date().toISOString().slice(0, 10),
          created_by: null,
        })
        .select("id, name, share_token, service_type")
        .single();
      if (error || !project)
        return { ok: false, detail: error?.message ?? "Project insert failed." };

      // Seed the asset checklist from the service-type template right away,
      // so a following start_wa_onboarding step has items to ask for.
      if (cfg.seed_checklist) {
        const { seedProjectChecklist } = await import("@/lib/wa-onboarding");
        await seedProjectChecklist(supabase, project.id, project.service_type);
      }

      // Expose the project to later steps (start_wa_onboarding,
      // set_delivery_stage) and to {{project_name}}/{{portal_link}} tokens.
      const portalLink = project.share_token
        ? appLink(`/public/project/${project.share_token}`)
        : null;
      const newContext = {
        ...ctx,
        project_id: project.id,
        project_name: project.name,
        ...(portalLink ? { portal_link: portalLink } : {}),
      };
      await supabase
        .from("automation_runs")
        .update({ context: newContext, project_id: project.id })
        .eq("id", run.id);
      run.context = newContext;
      run.project_id = project.id;

      if (run.lead_id) {
        await supabase.from("lead_activities").insert({
          lead_id: run.lead_id,
          kind: "automation",
          title: `Project "${name}" created`,
          body: "Kickoff project created automatically after the deposit was received.",
          actor_id: null,
        });
      }
      return { ok: true, detail: `Project "${name}"` };
    }

    case "start_wa_onboarding": {
      const ctx = (run.context ?? {}) as Record<string, unknown>;
      const projectId = run.project_id || String(ctx.project_id ?? "");
      // Soft outcomes on purpose: this step usually sits mid-recipe, and the
      // create_task/notify steps after it are exactly what should still run
      // when the kickoff can't go out (no phone, no template…) — the human
      // fallback. startWaOnboarding files its own crm_tasks in those cases.
      if (!projectId)
        return {
          ok: true,
          detail:
            "Skipped — run has no project. Put a create_project step before this one, or fire from a project event.",
        };
      const { startWaOnboarding } = await import("@/lib/wa-onboarding");
      const res = await startWaOnboarding(supabase, projectId);
      return { ok: true, detail: res.detail };
    }

    case "set_delivery_stage": {
      const ctx = (run.context ?? {}) as Record<string, unknown>;
      const projectId = run.project_id || String(ctx.project_id ?? "");
      if (!projectId) return { ok: true, detail: "Skipped — run has no project." };
      const stage = String(cfg.stage ?? "");
      if (!(DELIVERY_STAGES as readonly string[]).includes(stage))
        return { ok: false, detail: `"${stage}" is not a delivery stage.` };
      const { setProjectDeliveryStage } = await import("@/lib/delivery");
      const res = await setProjectDeliveryStage(
        supabase,
        projectId,
        stage as (typeof DELIVERY_STAGES)[number],
        { actor: "automation" },
      );
      return { ok: res.ok, detail: res.detail };
    }

    // -----------------------------------------------------------------
    // 0096 — Projects theme 6 (AUTO-2).
    //
    // All ten work on the run's project. A run with no project is a
    // configuration mistake, not a failure: they say so and let the rest of
    // the flow (the create_task / notify fallbacks) still run, exactly like
    // start_wa_onboarding does.
    // -----------------------------------------------------------------

    case "create_project_invoice": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const { generateProjectInvoice } = await import("@/lib/project-automation");
      const res = await generateProjectInvoice(supabase, projectId);

      // Nothing outstanding is a perfectly good outcome for a recipe that
      // bills on delivery — the client already paid in full. The tokens are
      // written EITHER WAY, blank when there is no invoice: renderTokens
      // leaves an unknown {{token}} standing in the text, so a message that
      // mentions the invoice would otherwise go out to the client reading
      // "Your invoice {{invoice_number}} is here: {{invoice_link}}".
      if (!res.ok) {
        await patchRunContext(supabase, run, {
          invoice_id: "",
          invoice_number: "",
          invoice_total: "",
          invoice_link: "",
          invoice_line: "",
        });
        return { ok: true, detail: `No invoice raised — ${res.detail}` };
      }

      const { data: invoice } = await supabase
        .from("invoices")
        .select("share_token")
        .eq("id", res.invoiceId)
        .maybeSingle();
      const link = invoice?.share_token
        ? appLink(`/public/invoice/${invoice.share_token}`)
        : null;
      await patchRunContext(supabase, run, {
        invoice_id: res.invoiceId,
        invoice_number: res.invoiceNumber,
        invoice_total: res.total,
        invoice_link: link ?? "",
        // A whole clause rather than a bare value, so one message template
        // reads correctly whether or not there was anything left to bill.
        invoice_line: link
          ? `Your invoice ${res.invoiceNumber} is here: ${link} `
          : `Your invoice ${res.invoiceNumber} is on its way. `,
      });
      return {
        ok: true,
        detail: `Invoice ${res.invoiceNumber} — ${res.total.toLocaleString()} due`,
      };
    }

    case "send_portal_link": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const { data: project } = await supabase
        .from("projects")
        .select("share_token, portal_passcode, portal_revoked_at")
        .eq("id", projectId)
        .maybeSingle();
      if (!project?.share_token)
        return { ok: false, detail: "This project has no portal link yet." };
      if (project.portal_revoked_at)
        return { ok: false, detail: "The portal link is revoked." };

      const link = appLink(`/public/project/${project.share_token}`);
      if (!link)
        return { ok: false, detail: "NEXT_PUBLIC_APP_URL isn't set — no link to send." };

      const { projectClientContact, sendClientSms, firstName } = await import(
        "@/lib/project-sms"
      );
      const contact = await projectClientContact(supabase, projectId);
      if ("error" in contact) return { ok: false, detail: contact.error };

      const { portalMessage } = await import("@/lib/portal-copy");
      const note = renderTokens(String(cfg.note ?? ""), run, lead).trim();
      const message = portalMessage({
        name: firstName(contact.clientName),
        projectName: contact.projectName,
        link,
        passcode: project.portal_passcode,
        note: note || undefined,
      });

      const sent = await sendClientSms(supabase, {
        contact,
        message,
        kind: "custom",
        actorId: null,
        eventDetail: "Portal link texted by an automation",
      });
      if (!sent.ok) return { ok: false, detail: sent.error };

      await supabase
        .from("projects")
        .update({ portal_last_sent_at: new Date().toISOString() })
        .eq("id", projectId);
      return { ok: true, detail: `Portal link to ${sent.to}` };
    }

    case "seed_task_template": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };

      // A named template wins; otherwise fall back to the one matching the
      // project's service type, so one recipe covers every service.
      let templateId = String(cfg.template_id ?? "").trim();
      if (!templateId) {
        const { data: project } = await supabase
          .from("projects")
          .select("service_type")
          .eq("id", projectId)
          .maybeSingle();
        const service = (project?.service_type ?? "").trim();
        if (!service)
          return { ok: true, detail: "Skipped — no template picked and no service type to match." };
        const { data: match } = await supabase
          .from("project_templates")
          .select("id")
          .ilike("service_type", service)
          .limit(1)
          .maybeSingle();
        if (!match)
          return { ok: true, detail: `Skipped — no template for "${service}".` };
        templateId = match.id;
      }

      const { applyProjectTemplate } = await import("@/lib/project-templates");
      const res = await applyProjectTemplate(supabase, projectId, templateId);
      if (!res.ok) return { ok: false, detail: res.error };
      return {
        ok: true,
        detail: `Seeded ${res.tasks} task(s), ${res.milestones} milestone(s), ${res.checks} check(s), ${res.assets} asset(s)`,
      };
    }

    case "assign_member": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const userId = String(cfg.user_id ?? "").trim();
      // Soft: this step ships inside recipes that can't know your team, so an
      // unconfigured one has to say so without killing the rest of the flow.
      if (!userId)
        return {
          ok: true,
          detail: "Skipped — no teammate picked yet. Open this step and choose one.",
        };
      const role = String(cfg.role ?? "").trim() || null;
      const isOwner = Boolean(cfg.is_owner);

      // One row per person per project — the same guard the Team card uses.
      const { data: existing } = await supabase
        .from("project_members")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .maybeSingle();
      if (existing) {
        await supabase
          .from("project_members")
          .update({ role, is_owner: isOwner })
          .eq("id", existing.id);
      } else {
        const { error } = await supabase
          .from("project_members")
          .insert({ project_id: projectId, user_id: userId, role, is_owner: isOwner });
        if (error) return { ok: false, detail: error.message };
      }
      // Only one owner at a time.
      if (isOwner) {
        await supabase
          .from("project_members")
          .update({ is_owner: false })
          .eq("project_id", projectId)
          .neq("user_id", userId);
      }

      const projectName = String(
        (run.context as Record<string, unknown>)?.project_name ?? "a project",
      );
      const title = isOwner ? "You now own a project" : "You're on a project";
      await supabase.from("notifications").insert({
        user_id: userId,
        type: "assignment",
        title,
        body: projectName,
        link: `/projects/${projectId}`,
      });
      await sendPushToUser({
        userId,
        title,
        body: projectName,
        link: `/projects/${projectId}`,
      });
      return { ok: true, detail: `Assigned${role ? ` as ${role}` : ""}` };
    }

    case "request_asset": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const title = renderTokens(String(cfg.title ?? ""), run, lead).trim();
      if (!title) return { ok: false, detail: "The asset request needs a title." };

      // Asking twice for the same thing is how a checklist loses its meaning.
      const { data: already } = await supabase
        .from("project_document_requests")
        .select("id")
        .eq("project_id", projectId)
        .ilike("title", title)
        .limit(1)
        .maybeSingle();
      if (already) return { ok: true, detail: `"${title}" is already on the checklist.` };

      const category = String(cfg.category ?? "").trim().toLowerCase();
      const { error } = await supabase.from("project_document_requests").insert({
        project_id: projectId,
        title,
        description:
          renderTokens(String(cfg.description ?? ""), run, lead).trim() || null,
        category: (ASSET_CATEGORIES as string[]).includes(category)
          ? (category as AssetCategory)
          : null,
        required: cfg.required !== false,
        source: "team",
      });
      if (error) return { ok: false, detail: error.message };
      return { ok: true, detail: `Asked for "${title}"` };
    }

    case "add_expense": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const description = renderTokens(
        String(cfg.description ?? ""),
        run,
        lead,
      ).trim();
      const unitAmount = Number(cfg.amount ?? 0);
      if (!description) return { ok: false, detail: "The expense needs a description." };
      if (!Number.isFinite(unitAmount) || unitAmount <= 0)
        return { ok: false, detail: "The expense needs a positive amount." };

      const { data: project } = await supabase
        .from("projects")
        .select("currency")
        .eq("id", projectId)
        .maybeSingle();
      const { error } = await supabase.from("project_expenses").insert({
        project_id: projectId,
        description,
        detail: renderTokens(String(cfg.detail ?? ""), run, lead).trim() || null,
        category: String(cfg.category ?? "").trim() || null,
        vendor: String(cfg.vendor ?? "").trim() || null,
        qty: 1,
        unit_amount: unitAmount,
        currency: project?.currency || "LKR",
        billable: cfg.billable !== false,
        created_by: null,
      });
      if (error) return { ok: false, detail: error.message };
      return { ok: true, detail: `${description} — ${unitAmount.toLocaleString()}` };
    }

    case "set_project_status": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const status = String(cfg.status ?? "");
      if (!(PROJECT_STATUSES as string[]).includes(status))
        return { ok: false, detail: `"${status}" is not a project status.` };

      const { data: before } = await supabase
        .from("projects")
        .select("status")
        .eq("id", projectId)
        .maybeSingle();
      if (before?.status === status)
        return { ok: true, detail: `Already ${status}.` };

      const { error } = await supabase
        .from("projects")
        .update({ status: status as ProjectStatus })
        .eq("id", projectId);
      if (error) return { ok: false, detail: error.message };

      // Closing a project this way must fire project_completed, or a status
      // set by a recipe would be invisible to the recipes listening for it.
      if (status === "completed") {
        const { fireProjectCompleted } = await import("@/lib/project-events");
        await fireProjectCompleted(supabase, projectId);
      }
      return { ok: true, detail: `Status → ${status}` };
    }

    case "create_payment_plan": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const { data: project } = await supabase
        .from("projects")
        .select("id, name, currency, client_id, total_value, deposit_paid")
        .eq("id", projectId)
        .maybeSingle();
      if (!project) return { ok: false, detail: "Project not found." };

      // One plan per project: a second schedule for the same money is how a
      // client ends up chased twice for one instalment.
      const { data: existingPlan } = await supabase
        .from("payment_plans")
        .select("id")
        .eq("project_id", projectId)
        .neq("status", "cancelled")
        .limit(1)
        .maybeSingle();
      if (existingPlan)
        return { ok: true, detail: "This project already has a payment plan." };

      const [{ data: own }, { data: linked }] = await Promise.all([
        supabase.from("payments").select("amount, status").eq("project_id", projectId),
        supabase
          .from("company_payments")
          .select("price_lkr, is_paid")
          .eq("project_id", projectId),
      ]);
      const { balanceDue } = await import("@/lib/projects");
      const outstanding = balanceDue({
        total_value: project.total_value,
        deposit_paid: project.deposit_paid,
        payments: own ?? [],
        company_payments: linked ?? [],
      });
      if (outstanding <= 0)
        return { ok: true, detail: "Nothing left to schedule — fully paid." };

      const count = Math.min(12, Math.max(1, Number(cfg.installments ?? 2)));
      const everyDays = Math.max(1, Number(cfg.every_days ?? 30));
      const startInDays = Math.max(0, Number(cfg.start_in_days ?? everyDays));

      const { data: plan, error } = await supabase
        .from("payment_plans")
        .insert({
          title: `${project.name} — balance`,
          client_id: project.client_id,
          project_id: projectId,
          contact_name: run.subject_name || "",
          phone: run.subject_phone,
          total: outstanding,
          currency: project.currency,
          status: "active",
          remind_days_before: Number(cfg.remind_days_before ?? 2),
          created_by: null,
        })
        .select("id")
        .single();
      if (error || !plan)
        return { ok: false, detail: error?.message ?? "Payment plan insert failed." };

      // Rounded to whole rupees, with the rounding dust on the last one so
      // the instalments always add back up to the balance exactly.
      const each = Math.floor(outstanding / count);
      const rows = Array.from({ length: count }, (_, i) => {
        const due = new Date(Date.now() + (startInDays + i * everyDays) * 24 * 3600_000);
        return {
          plan_id: plan.id,
          seq: i + 1,
          amount: i === count - 1 ? outstanding - each * (count - 1) : each,
          due_date: due.toISOString().slice(0, 10),
        };
      });
      const { error: instError } = await supabase
        .from("payment_installments")
        .insert(rows);
      if (instError) return { ok: false, detail: instError.message };

      await patchRunContext(supabase, run, { plan_id: plan.id, plan_total: outstanding });
      return {
        ok: true,
        detail: `${count} instalment(s) of ~${each.toLocaleString()} ${project.currency}`,
      };
    }

    case "schedule_meeting": {
      const projectId = runProjectId(run);
      const title =
        renderTokens(String(cfg.title ?? ""), run, lead).trim() ||
        `Call — ${String((run.context as Record<string, unknown>)?.project_name ?? run.subject_name ?? "client")}`;
      const inDays = Math.max(0, Number(cfg.in_days ?? 1));
      const hour = Math.min(23, Math.max(0, Number(cfg.hour ?? 10)));

      const when = new Date(Date.now() + inDays * 24 * 3600_000);
      when.setHours(hour, 0, 0, 0);

      const { data: project } = projectId
        ? await supabase
            .from("projects")
            .select("client_id")
            .eq("id", projectId)
            .maybeSingle()
        : { data: null };

      const { data: meeting, error } = await supabase
        .from("meetings")
        .insert({
          title,
          description:
            renderTokens(String(cfg.description ?? ""), run, lead).trim() || null,
          meeting_at: when.toISOString(),
          duration_minutes: Math.max(5, Number(cfg.duration_minutes ?? 30)),
          location_type: cfg.location_type === "in_person" ? "in_person" : "online",
          location: String(cfg.location ?? "").trim() || null,
          meeting_url: String(cfg.meeting_url ?? "").trim() || null,
          reminder_hours: Math.min(5, Math.max(1, Number(cfg.reminder_hours ?? 2))),
          client_id: project?.client_id ?? run.client_id,
          created_by: null,
        })
        .select("id")
        .single();
      if (error || !meeting)
        return { ok: false, detail: error?.message ?? "Meeting insert failed." };

      await patchRunContext(supabase, run, {
        meeting_id: meeting.id,
        meeting_at: when.toISOString(),
      });
      return { ok: true, detail: `${title} — ${when.toLocaleString()}` };
    }

    case "draft_client_update": {
      const projectId = runProjectId(run);
      if (!projectId) return { ok: true, detail: NO_PROJECT };
      const { isOpenAIConfigured, openaiChat } = await import("@/lib/ai/openai");
      if (!isOpenAIConfigured())
        return { ok: false, detail: "OPENAI_API_KEY is not configured." };

      // Everything the update should be grounded in: where the project is,
      // what has actually been finished, and what is still outstanding.
      const [projectRes, milestonesRes, assetsRes, eventsRes] = await Promise.all([
        supabase
          .from("projects")
          .select("name, status, delivery_stage, due_date, description")
          .eq("id", projectId)
          .maybeSingle(),
        supabase
          .from("project_milestones")
          .select("title, status, due_date")
          .eq("project_id", projectId)
          .eq("kind", "milestone")
          .order("position", { ascending: true })
          .limit(20),
        supabase
          .from("project_document_requests")
          .select("title, status, required")
          .eq("project_id", projectId)
          .limit(20),
        supabase
          .from("delivery_events")
          .select("kind, detail, created_at")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);
      const project = projectRes.data;
      if (!project) return { ok: false, detail: "Project not found." };

      const done = (milestonesRes.data ?? []).filter((m) => m.status === "done");
      const open = (milestonesRes.data ?? []).filter((m) => m.status !== "done");
      const waiting = (assetsRes.data ?? []).filter(
        (a) => a.status === "pending" && a.required,
      );

      const reply = await openaiChat([
        {
          role: "system",
          content:
            "You write short client progress updates for ARC AI, a Sri Lankan digital agency. Plain text, no markdown, no headings, no emoji. 3-5 sentences, warm and specific. Say what is done, what is next, and what (if anything) you need from them. Never invent work that isn't in the facts. Never mention money, margin or internal costs.",
        },
        {
          role: "user",
          content: [
            `Project: ${project.name}`,
            project.description ? `Brief: ${project.description}` : "",
            `Delivery stage: ${project.delivery_stage ?? "not started"}`,
            project.due_date ? `Due: ${project.due_date}` : "",
            `Completed: ${done.map((m) => m.title).join(", ") || "(nothing yet)"}`,
            `Still to do: ${open.map((m) => m.title).join(", ") || "(nothing listed)"}`,
            `Waiting on the client for: ${waiting.map((a) => a.title).join(", ") || "(nothing)"}`,
            `Recent activity:\n${(eventsRes.data ?? []).map((e) => `- ${e.created_at.slice(0, 10)} ${e.kind}: ${e.detail ?? ""}`).join("\n") || "(none)"}`,
            cfg.instruction
              ? `\nExtra instruction: ${renderTokens(String(cfg.instruction), run, lead)}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ]);
      const text = (reply.content ?? "").trim();
      if (!text) return { ok: false, detail: "AI returned nothing." };

      // Filed as an internal note, never sent. A message to a client is a
      // decision a person makes; this step only removes the blank page.
      const { error } = await supabase.from("project_comments").insert({
        project_id: projectId,
        author_type: "team",
        author_id: null,
        author_name: "AI draft",
        body: text,
      });
      if (error) return { ok: false, detail: error.message };

      await patchRunContext(supabase, run, { client_update: text });
      return { ok: true, detail: `Drafted ${text.length} chars — filed as a team note` };
    }

    default:
      return { ok: false, detail: `Unknown step kind "${step.kind}".` };
  }
}

// ---------------------------------------------------------------------------
// 0096 step helpers
// ---------------------------------------------------------------------------

const NO_PROJECT =
  "Skipped — this run has no project. Fire it from a project trigger, or put a Create project step before it.";

const PROJECT_STATUSES: ProjectStatus[] = [
  "planning",
  "active",
  "on_hold",
  "completed",
  "cancelled",
];

const ASSET_CATEGORIES: AssetCategory[] = ["brand", "content", "photos", "access"];

/** The project this run is about, from the run row or its context. */
function runProjectId(run: Run): string {
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  return run.project_id || String(ctx.project_id ?? "");
}

/**
 * Merge values into the run's context so LATER steps can use them as
 * {{tokens}} — an invoice number in the SMS that follows the invoice, a
 * meeting time in the confirmation.
 */
async function patchRunContext(
  supabase: DB,
  run: Run,
  patch: Record<string, unknown>,
): Promise<void> {
  const next = { ...((run.context ?? {}) as Record<string, unknown>), ...patch };
  await supabase.from("automation_runs").update({ context: next }).eq("id", run.id);
  run.context = next;
}
