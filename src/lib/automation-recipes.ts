import type {
  AutomationStepKind,
  AutomationTrigger,
} from "@/lib/database.types";

/**
 * One-click automation templates. Installing a recipe copies its trigger +
 * steps into a real automation the user can then tweak in the builder.
 * Safe on client and server — plain data only.
 */

export type AutomationRecipe = {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name rendered by the recipes tab. */
  emoji: string;
  trigger: AutomationTrigger;
  trigger_config: Record<string, unknown>;
  conditions: Record<string, unknown>[];
  steps: { kind: AutomationStepKind; config: Record<string, unknown> }[];
};

export const AUTOMATION_RECIPES: AutomationRecipe[] = [
  {
    id: "new-lead-keep-warm",
    name: "New lead keep-warm (SMS)",
    description:
      "The moment a lead lands in the CRM they get a welcome SMS introducing ARC AI and our services, then two spaced follow-ups so they never go cold — plus a call task for the team.",
    emoji: "🔥",
    trigger: "lead_created",
    trigger_config: {},
    conditions: [],
    steps: [
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, welcome to ARC AI! We're a Sri Lankan AI & digital agency — we build business websites, e-commerce stores, run social media marketing and set up AI automations that win you customers. A team member will reach out shortly. Talk soon!",
        },
      },
      { kind: "add_tag", config: { tag: "keep-warm" } },
      { kind: "wait", config: { minutes: 1440 } },
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, quick one from ARC AI 👋 Here's what we can do for you: 1) Business websites 2) E-commerce stores 3) Social media marketing 4) AI chat & automation. Reply with a number and we'll send details, or call +94 77 185 2522.",
        },
      },
      { kind: "wait", config: { minutes: 2880 } },
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, just checking in — still thinking about growing your business online? We'd love to show you a quick demo of what we'd build for you. Reply YES and we'll set it up. — ARC AI",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Call {{full_name}} — completed keep-warm flow",
          notes: "Lead finished the 3-SMS welcome sequence. Call them while they're warm.",
          due_in_days: 1,
        },
      },
    ],
  },
  {
    id: "form-lead-instant",
    name: "Website inquiry — instant response",
    description:
      "A form submission gets an instant thank-you SMS and the whole team is pinged, so no inquiry ever sits unanswered.",
    emoji: "⚡",
    trigger: "form_submitted",
    trigger_config: {},
    conditions: [],
    steps: [
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, thanks for reaching out to ARC AI! We received your inquiry and one of our team will contact you within a few hours. — ARC AI, www.arcai.agency",
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "New website inquiry",
          body: "{{full_name}} just submitted the inquiry form — respond fast!",
        },
      },
      {
        kind: "create_task",
        config: { title: "Respond to {{full_name}}'s inquiry", due_in_days: 1 },
      },
    ],
  },
  {
    id: "cold-lead-revival",
    name: "Cold lead revival",
    description:
      "When a lead sits untouched for 7 days it's tagged cold, gets a friendly revival SMS and the team gets a follow-up task.",
    emoji: "🧊",
    trigger: "lead_inactive",
    trigger_config: { days: 7 },
    conditions: [],
    steps: [
      { kind: "add_tag", config: { tag: "cold" } },
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, it's ARC AI — we haven't spoken in a while! We still have your project in mind and would love to pick it back up. Any questions we can answer? Just reply here.",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Revive cold lead: {{full_name}}",
          notes: "No activity for 7 days. Revival SMS was sent automatically — follow up with a call.",
          due_in_days: 1,
        },
      },
    ],
  },
  {
    id: "stale-deal-alert",
    name: "Stale deal alert",
    description:
      "Deals idle for 5 days ping the whole team and get an AI-suggested next action written onto the lead.",
    emoji: "⏰",
    trigger: "lead_inactive",
    trigger_config: { days: 5 },
    conditions: [{ field: "value", op: "gt", value: 0 }],
    steps: [
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Deal going stale",
          body: "{{title}} has had no activity for 5 days — value at risk.",
        },
      },
      {
        kind: "ai_agent",
        config: {
          instruction:
            "Suggest the single best next action to move this deal forward, in 1-2 sentences.",
          save_to: "ai_next_action",
        },
      },
    ],
  },
  {
    id: "invoice-chaser",
    name: "Unpaid invoice chaser",
    description:
      "Three days after an invoice is sent with no payment stamp, the client gets a polite email reminder and the team is notified.",
    emoji: "💸",
    trigger: "invoice_unpaid",
    trigger_config: { days: 3 },
    conditions: [],
    steps: [
      {
        kind: "send_email",
        config: {
          subject: "Friendly reminder — invoice {{invoice_number}} from ARC AI",
          body:
            "Hi {{name}},\nJust a friendly reminder that invoice {{invoice_number}} ({{amount}}) is still awaiting payment.\nIf you've already paid, please ignore this. Any questions, just reply — we're happy to help.\nThank you!\nARC AI",
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Invoice reminder sent",
          body: "Invoice {{invoice_number}} ({{amount}}) is unpaid after 3 days — automatic reminder emailed.",
        },
      },
    ],
  },
  {
    id: "quote-accepted",
    name: "Quote accepted → next steps",
    description:
      "The moment a client e-signs a quote: team notified, a task to convert it to an invoice, and a thank-you SMS to the client.",
    emoji: "✍️",
    trigger: "quote_accepted",
    trigger_config: {},
    conditions: [],
    steps: [
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Quote accepted 🎉",
          body: "{{full_name}} accepted quote {{quote_number}} ({{amount}}).",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Convert accepted quote {{quote_number}} to invoice",
          due_in_days: 1,
        },
      },
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, thank you for accepting our proposal! We're excited to get started. Our team will send the invoice and kick-off details shortly. — ARC AI",
        },
      },
    ],
  },
  {
    id: "closing-date-nudge",
    name: "Closing date approaching",
    description:
      "Three days before a deal's expected close date, the assignee gets a task and the lead gets a gentle nudge SMS.",
    emoji: "📅",
    trigger: "date_reached",
    trigger_config: { days_before: 3 },
    conditions: [],
    steps: [
      {
        kind: "create_task",
        config: {
          title: "Close {{title}} — target date in 3 days",
          due_in_days: 1,
        },
      },
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, we're all set on our side to get your project moving. Shall we lock things in this week? Reply here or call +94 77 185 2522. — ARC AI",
        },
      },
    ],
  },
];

export function getRecipe(id: string): AutomationRecipe | undefined {
  return AUTOMATION_RECIPES.find((r) => r.id === id);
}
