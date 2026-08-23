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
  quote_viewed: {
    label: "Quote opened",
    description: "A client opens a quotation's share link for the first time.",
  },
  payment_received: {
    label: "Payment received",
    description:
      "A payment-plan installment is marked paid. Set seq = 1 in the trigger config to fire only when the deposit lands.",
  },
  client_created: {
    label: "Client created",
    description: "A new client record is added to the workspace.",
  },
  webhook: {
    label: "Webhook received",
    description: "An inbound webhook endpoint (Zapier/Make/custom) fires.",
  },
  wa_message_received: {
    label: "WhatsApp message received",
    description:
      "An inbound WhatsApp message arrives. Add a keyword in the trigger config to only fire on messages containing it.",
  },
  project_stage_changed: {
    label: "Project stage changed",
    description:
      "A project moves to a new delivery stage (onboarding → assets → build → review → delivered → aftercare). Pick a stage to fire only on that one.",
  },
  project_delivered: {
    label: "Project delivered",
    description:
      "A project's delivery stage lands on Delivered — the hook for review asks, testimonials, aftercare and upsells.",
  },
  asset_submitted: {
    label: "Asset received",
    description:
      "A checklist item lands — the client uploaded it on the portal or sent it over WhatsApp.",
  },
  assets_complete: {
    label: "All assets collected",
    description:
      "The LAST required checklist item arrives — everything needed to start the build is in. Fires once per project.",
  },

  // 0096 — Projects theme 6 (AUTO-1). Everything below concerns a project,
  // so the steps that need one (invoice, portal link, template, member,
  // asset, expense, status, plan, meeting, update) all work off these.
  project_created: {
    label: "Project created",
    description:
      "A project record is born — added by hand, generated as a retainer month, or created by the assistant. Deliberately NOT fired by the \u201cCreate project\u201d automation step, so a kickoff flow can\u2019t loop into itself.",
  },
  project_due_soon: {
    label: "Project due in X days",
    description:
      "An open project\u2019s due date is within a number of days. Fires once per deadline — move the date and it re-arms.",
    timeBased: true,
  },
  project_overdue: {
    label: "Project overdue",
    description:
      "An open project is past its due date by X days. Fires once per deadline, so pushing the date out re-arms it.",
    timeBased: true,
  },
  balance_overdue: {
    label: "Balance overdue",
    description:
      "A delivered project still has money outstanding X days after delivery. The escalation the built-in balance chaser hands over to.",
    timeBased: true,
  },
  expense_added: {
    label: "Expense added",
    description:
      "A cost is recorded against a project. Add a category in the trigger config to only fire on that one.",
  },
  expenses_over_budget: {
    label: "Expenses over budget",
    description:
      "A project\u2019s recorded costs pass its expense cap (or its budget). Fires once per project \u2014 the same guard the built-in budget alert uses.",
  },
  milestone_completed: {
    label: "Milestone completed",
    description:
      "A project milestone is ticked off. Add a title keyword in the trigger config to only fire on the ones that matter.",
  },
  client_approved: {
    label: "Client approved",
    description:
      "The client signed off on an approval from the portal. The hook for \u201cthey said yes \u2014 now invoice/build/ship it\u201d.",
  },
  project_completed: {
    label: "Project completed",
    description:
      "A project\u2019s status becomes Completed \u2014 the job is closed, whatever its delivery stage says.",
  },
  project_stalled: {
    label: "Project stalled",
    description:
      "A project has sat untouched past the Delivery stalled threshold. Fires alongside the built-in alert, so an escalation ladder can hang off it.",
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
  send_whatsapp: {
    label: "Send WhatsApp",
    description:
      "Message the contact on WhatsApp. Set a template name for contacts who haven't replied in 24h.",
    tone: "bg-green-600",
  },
  convert_quote_to_invoice: {
    label: "Quote → invoice",
    description:
      "Turn the run's accepted quote into a real invoice plus a deposit/balance payment plan.",
    tone: "bg-lime-600",
  },
  create_project: {
    label: "Create project",
    description: "Spin up a project for the client (e.g. the moment the deposit lands).",
    tone: "bg-purple-600",
  },
  start_wa_onboarding: {
    label: "Start WhatsApp onboarding",
    description:
      "Flip the client's WhatsApp thread into asset-collection mode and send the kickoff — the agent then collects logo, photos, content and access, and files everything against the project checklist.",
    tone: "bg-green-700",
  },
  set_delivery_stage: {
    label: "Set delivery stage",
    description:
      "Move the run's project to a delivery stage — fires the same milestone notifications as moving it on the board.",
    tone: "bg-purple-500",
  },
  wait: {
    label: "Wait",
    description: "Pause before the next step.",
    tone: "bg-amber-500",
  },

  // 0096 — Projects theme 6 (AUTO-2). Every one of these needs a project on
  // the run: fire from a project trigger, or put a Create project step first.
  create_project_invoice: {
    label: "Raise project invoice",
    description:
      "Bill the project for real: contract value plus every uninvoiced billable extra, minus what has already been received. Lands in /invoices like one you typed.",
    tone: "bg-lime-700",
  },
  send_portal_link: {
    label: "Send portal link",
    description:
      "Text the client their portal link and passcode in one message \u2014 the same send as the button on the project.",
    tone: "bg-sky-600",
  },
  seed_task_template: {
    label: "Apply plan template",
    description:
      "Seed the project\u2019s tasks, milestones, launch checks and asset checklist from a plan template. Skips anything already there.",
    tone: "bg-violet-600",
  },
  assign_member: {
    label: "Assign teammate to project",
    description:
      "Put someone on the job (optionally as owner) and tell them. Staffing, not commission.",
    tone: "bg-indigo-600",
  },
  request_asset: {
    label: "Request an asset",
    description:
      "Add a checklist item for the client to supply \u2014 the WhatsApp agent and the portal both collect against it.",
    tone: "bg-amber-600",
  },
  add_expense: {
    label: "Add expense",
    description:
      "Record a cost against the project \u2014 a recurring licence, a stock-photo budget, a retainer\u2019s fixed hosting.",
    tone: "bg-rose-600",
  },
  set_project_status: {
    label: "Set project status",
    description:
      "Move the project between Planning, Active, On hold, Completed and Cancelled.",
    tone: "bg-teal-600",
  },
  create_payment_plan: {
    label: "Create payment plan",
    description:
      "Schedule the balance as instalments against the project \u2014 the installment-due reminders then run themselves.",
    tone: "bg-emerald-700",
  },
  schedule_meeting: {
    label: "Schedule a meeting",
    description:
      "Book a call with the client on the calendar, with its SMS invite and reminder.",
    tone: "bg-blue-600",
  },
  draft_client_update: {
    label: "Draft client update",
    description:
      "Have the AI write a short, plain progress update from where the project actually is, and file it as a team note to send or edit. Never messages the client on its own.",
    tone: "bg-fuchsia-600",
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
