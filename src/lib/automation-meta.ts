import type {
  AutomationStepKind,
  AutomationTrigger,
} from "@/lib/database.types";

/**
 * Display metadata for the automation builder. Client-safe (no server deps).
 */

export const TRIGGER_META: Record<
  AutomationTrigger,
  { label: string; description: string; timeBased?: boolean }
> = {
  lead_created: {
    label: "Lead created",
    description: "A new lead lands in the CRM — from the app, a form, the API or the AI agent.",
  },
  form_submitted: {
    label: "Inquiry form submitted",
    description: "A public website form posted to /api/public/forms/lead.",
  },
  stage_changed: {
    label: "Stage changed",
    description: "A lead is moved into a pipeline stage.",
  },
  tag_added: {
    label: "Tag added",
    description: "A specific tag is applied to a lead.",
  },
  lead_inactive: {
    label: "Lead inactive for X days",
    description: "No activity on an open lead for a number of days.",
    timeBased: true,
  },
  date_reached: {
    label: "Close date approaching",
    description: "An open deal's expected close date is within X days.",
    timeBased: true,
  },
  invoice_unpaid: {
    label: "Invoice unpaid",
    description: "An emailed invoice has no payment stamp X days after sending.",
    timeBased: true,
  },
  installment_due: {
    label: "Installment due",
    description: "A payment-plan installment is due within X days.",
    timeBased: true,
  },
  cheque_due: {
    label: "Cheque due",
    description: "A pending post-dated cheque reaches its due date window.",
    timeBased: true,
  },
  quote_accepted: {
    label: "Quote accepted",
    description: "A client e-signs a quotation via its share link.",
  },
  client_created: {
    label: "Client created",
    description: "A new client record is added to the workspace.",
  },
  webhook: {
    label: "Webhook received",
    description: "An inbound webhook endpoint (Zapier/Make/custom) fires.",
  },
};

export const STEP_META: Record<
  AutomationStepKind,
  { label: string; description: string; tone: string }
> = {
  send_sms: {
    label: "Send SMS",
    description: "Text the contact via Notify.lk.",
    tone: "bg-primary-500",
  },
  send_email: {
    label: "Send email",
    description: "Email the contact via Resend.",
    tone: "bg-sky-500",
  },
  create_task: {
    label: "Create task",
    description: "Add a CRM follow-up task.",
    tone: "bg-violet-500",
  },
  add_tag: {
    label: "Add tag",
    description: "Tag the lead.",
    tone: "bg-emerald-500",
  },
  remove_tag: {
    label: "Remove tag",
    description: "Untag the lead.",
    tone: "bg-slate-500",
  },
  assign_user: {
    label: "Assign teammate",
    description: "Set the lead's owner and notify them.",
    tone: "bg-indigo-500",
  },
  move_stage: {
    label: "Move stage",
    description: "Move the lead to another pipeline stage.",
    tone: "bg-orange-500",
  },
  update_field: {
    label: "Update field",
    description: "Write a value onto the lead (incl. custom fields).",
    tone: "bg-teal-500",
  },
  update_score: {
    label: "Set score",
    description: "Mark the lead hot, warm or cold.",
    tone: "bg-rose-500",
  },
  notify: {
    label: "Notify team",
    description: "In-app + push notification.",
    tone: "bg-amber-500",
  },
  webhook: {
    label: "Call webhook",
    description: "POST JSON to an external URL.",
    tone: "bg-slate-700",
  },
  ai_agent: {
    label: "AI agent",
    description: "Have the AI draft, summarize or suggest — saved to the lead.",
    tone: "bg-fuchsia-500",
  },
  enroll_sms_workflow: {
    label: "Enroll in SMS drip",
    description: "Start an SMS-page workflow for the contact.",
    tone: "bg-cyan-500",
  },
  wait: {
    label: "Wait",
    description: "Pause before the next step.",
    tone: "bg-amber-500",
  },
};

export const CONDITION_FIELDS = [
  { value: "source", label: "Source" },
  { value: "tags", label: "Tags" },
  { value: "score", label: "Score" },
  { value: "status", label: "Deal status" },
  { value: "value", label: "Deal value" },
  { value: "assigned_to", label: "Assignee" },
  { value: "contact_phone", label: "Phone" },
  { value: "contact_email", label: "Email" },
] as const;

export const CONDITION_OPS = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "is_set", label: "is set" },
  { value: "not_set", label: "is empty" },
] as const;
