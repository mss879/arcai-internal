/**
 * The automation engine's pure core.
 *
 * `src/lib/automation.ts` is `server-only` — it holds a Supabase client, sends
 * email, SMS and WhatsApp, and writes rows. But four of the decisions it makes
 * are pure functions of their arguments: does this event match an automation's
 * trigger filter, do its conditions pass, what does a message template render
 * to, and is this trigger a timed nudge (so quiet hours apply).
 *
 * Those four live here so they can be tested directly. Importing the engine to
 * test them would pull in `server-only`, which throws outside a request, and
 * mocking it would test the mock. `automation.ts` imports and re-exports these,
 * so every existing call site is unchanged.
 */

import type {
  AutomationTrigger,
  Database,
} from "@/lib/database.types";

type Automation = Database["public"]["Tables"]["automations"]["Row"];
type Run = Database["public"]["Tables"]["automation_runs"]["Row"];
type Lead = Database["public"]["Tables"]["leads"]["Row"];

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

// ---------------------------------------------------------------------------
// Does this event match the automation?
// ---------------------------------------------------------------------------

export function matchesTriggerConfig(automation: Automation, event: TriggerEvent): boolean {
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

// ---------------------------------------------------------------------------
// Message tokens
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
export function isNudgeTrigger(
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
