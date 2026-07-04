import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AutomationTrigger,
  Database,
} from "@/lib/database.types";
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

    for (const automation of automations) {
      if (!matchesTriggerConfig(automation, event)) continue;
      if (event.lead && !passesConditions(automation, event.lead)) continue;
      await enrollRun(supabase, automation, event);
    }
  } catch (e) {
    console.error("[automation] fireAutomationTrigger failed:", e);
  }
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

  const { data: run, error } = await supabase
    .from("automation_runs")
    .insert({
      automation_id: automation.id,
      lead_id: event.lead?.id ?? null,
      client_id: event.client?.id || event.lead?.client_id || null,
      subject_name: subjectName,
      subject_phone:
        event.lead?.contact_phone ?? event.client?.phone ?? payloadPhone,
      subject_email:
        event.lead?.contact_email ?? event.client?.email ?? payloadEmail,
      context: (event.payload ?? {}) as Record<string, unknown>,
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
  await advanceRun(supabase, run, steps ?? []);
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
    supabase.from("automations").select("id, is_active").in("id", automationIds),
    supabase
      .from("automation_steps")
      .select("*")
      .in("automation_id", automationIds)
      .order("position", { ascending: true }),
  ]);

  const activeIds = new Set(
    (automations ?? []).filter((a) => a.is_active).map((a) => a.id),
  );
  const stepsByAutomation = new Map<string, Step[]>();
  for (const step of allSteps ?? []) {
    const list = stepsByAutomation.get(step.automation_id) ?? [];
    list.push(step);
    stepsByAutomation.set(step.automation_id, list);
  }

  for (const run of dueRuns) {
    if (!activeIds.has(run.automation_id)) continue; // paused automation
    result.processed++;
    const ok = await advanceRun(
      supabase,
      run,
      stepsByAutomation.get(run.automation_id) ?? [],
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

/**
 * Execute steps from run.step_index until a wait pushes the run forward,
 * a step fails, or the run completes. Returns false when the run failed.
 */
async function advanceRun(supabase: DB, run: Run, steps: Step[]): Promise<boolean> {
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
      const link = run.lead_id ? `/crm/lead/${run.lead_id}` : "/automation";
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

    default:
      return { ok: false, detail: `Unknown step kind "${step.kind}".` };
  }
}
