import type {
  AutomationStepKind,
  AutomationTrigger,
} from "@/lib/database.types";
import { INVOICE_BANK } from "@/lib/invoice";

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
  /** Which gallery shows it: sales (default) or the Client Delivery hub. */
  category?: "sales" | "delivery";
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
    id: "whatsapp-deal-close",
    name: "WhatsApp deal close 💰",
    description:
      "The agent's quote gets e-signed → it instantly becomes a real invoice + deposit/balance payment plan, the customer receives the bank transfer details on WhatsApp, the team celebrates and a deposit-chase task is created. The full money moment, zero humans needed.",
    emoji: "💰",
    trigger: "quote_accepted",
    trigger_config: {},
    conditions: [],
    steps: [
      { kind: "convert_quote_to_invoice", config: {} },
      {
        kind: "send_whatsapp",
        config: {
          message: `Thank you {{name}}! 🎉 That's confirmed — invoice {{invoice_number}} is ready.\nTo kick things off, the deposit is {{deposit_amount}}:\nBank: ${INVOICE_BANK.bankName}\nAccount name: ${INVOICE_BANK.accountName}\nAccount no: ${INVOICE_BANK.accountNumber}\nBranch: ${INVOICE_BANK.branch}\nSend the slip here once it's done and we'll get started right away 🚀`,
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Deal closed on WhatsApp 💰",
          body: "{{full_name}} signed {{quote_number}} ({{amount}}) — invoice {{invoice_number}} + payment details already sent in the chat.",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Confirm deposit received — {{full_name}}",
          notes:
            "Quote {{quote_number}} was signed; deposit {{deposit_amount}} of {{total_amount}}. The moment the money lands, mark installment 1 paid in Finance — that fires the kickoff automation.",
          due_in_days: 1,
        },
      },
    ],
  },
  {
    id: "quote-opened-alert",
    name: "Quote opened 👀",
    description:
      "The instant a client opens a quote's signing link, the whole team knows — the hottest moment in the deal. (The WhatsApp agent also nudges them automatically a few minutes later.)",
    emoji: "👀",
    trigger: "quote_viewed",
    trigger_config: {},
    conditions: [],
    steps: [
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Quote opened 👀",
          body: "{{full_name}} is looking at quote {{quote_number}} ({{amount}}) right now.",
        },
      },
    ],
  },
  {
    id: "deposit-kickoff",
    name: "Deposit received 🚀",
    description:
      "The deposit installment is marked paid in Finance → the customer gets a warm kickoff message on WhatsApp, a project is created automatically and the team gets the kickoff task. Deal → cash → delivery, hands-free.",
    emoji: "🚀",
    trigger: "payment_received",
    trigger_config: { seq: 1 },
    conditions: [],
    steps: [
      {
        kind: "send_whatsapp",
        config: {
          message:
            "Payment received {{name}} — thank you! 🎉 Your project is officially underway. Our team is being briefed right now and you'll hear from us within one working day with the kickoff plan. Exciting times ahead 🚀",
        },
      },
      { kind: "create_project", config: {} },
      {
        kind: "create_task",
        config: {
          title: "Kick off {{full_name}}'s project",
          notes:
            "Deposit {{amount}} received (plan: {{plan_title}}). Project created automatically — brief the team and send the kickoff plan.",
          due_in_days: 1,
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Deposit received 🚀",
          body: "{{full_name}} paid {{amount}} — project created, kickoff task assigned.",
        },
      },
    ],
  },
  {
    id: "referral-ask",
    name: "Referral ask, two weeks after payment 🤝",
    description:
      "A customer pays → two weeks later (when the work is real and the goodwill is warm) they get ONE friendly WhatsApp asking who else they know that needs this. The 24h window is long closed by then, so this REQUIRES a Meta-approved template — create one (e.g. 'referral_ask', category Marketing) in WhatsApp Manager and put its exact name in the step before activating.",
    emoji: "🤝",
    trigger: "payment_received",
    trigger_config: {},
    conditions: [],
    steps: [
      { kind: "wait", config: { minutes: 14 * 24 * 60 } },
      {
        kind: "send_whatsapp",
        config: {
          template_name: "referral_ask",
          template_lang: "en",
          template_params: ["{{name}}"],
          message:
            "Hey {{name}}! Hope everything's running smoothly on your side 😊 Quick one — if you know another business owner who'd love what we built for you, send them my way. We take great care of friends of clients 🤝",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Referral follow-through — {{full_name}}",
          notes:
            "The referral ask just went out to {{full_name}} (paid {{amount}} two weeks ago). If they name someone, get the intro moving the same day.",
          due_in_days: 2,
        },
      },
    ],
  },
  {
    id: "cold-prospect-first-touch",
    name: "Cold prospect first touch (WhatsApp)",
    description:
      "The hunter-closer's opening move: a Find Leads prospect lands in the CRM → they instantly get your approved WhatsApp template quoting their own audit result. When they reply, the AI agent takes over already knowing their business. Requires a Meta-approved template — set its name in the step before activating.",
    emoji: "🎯",
    trigger: "lead_created",
    trigger_config: {},
    conditions: [{ field: "source", op: "eq", value: "prospecting" }],
    steps: [
      {
        kind: "send_whatsapp",
        config: {
          template_name: "site_audit_intro",
          template_lang: "en",
          template_params: ["{{business}}", "{{audit_score}}"],
          message:
            "Hi! We run ARC AI, a web agency in Colombo. We came across {{business}} and ran a quick check on your website — it scored {{audit_score}}/100 on Google's test. Mind if I share what's holding it back?",
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Cold outreach sent 🎯",
          body: "First-touch WhatsApp sent to {{business}} (audit {{audit_score}}/100).",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "No reply from {{business}}? Follow up the cold outreach",
          due_in_days: 3,
        },
      },
    ],
  },
  {
    id: "whatsapp-lead-warming",
    name: "WhatsApp lead warming",
    description:
      "A WhatsApp lead that goes quiet for 3 days gets a friendly nudge on WhatsApp and the team gets a follow-up task — keeps every chat-lead warm automatically.",
    emoji: "💬",
    trigger: "lead_inactive",
    trigger_config: { days: 3 },
    conditions: [{ field: "source", op: "eq", value: "whatsapp" }],
    steps: [
      {
        kind: "send_whatsapp",
        config: {
          message:
            "Hi {{name}} 👋 just checking in from ARC AI — still keen on getting your project moving? Happy to answer any questions right here. 🙂",
        },
      },
      { kind: "add_tag", config: { tag: "warming" } },
      {
        kind: "create_task",
        config: {
          title: "Follow up WhatsApp lead: {{full_name}}",
          notes: "No activity for 3 days — warming message sent automatically on WhatsApp.",
          due_in_days: 1,
        },
      },
    ],
  },
  {
    id: "whatsapp-payment-reminder",
    name: "WhatsApp payment reminder",
    description:
      "Three days after an invoice goes unpaid, the client gets a polite WhatsApp reminder (plus the usual email) — WhatsApp gets read far more than email.",
    emoji: "🧾",
    trigger: "invoice_unpaid",
    trigger_config: { days: 3 },
    conditions: [],
    steps: [
      {
        kind: "send_whatsapp",
        config: {
          message:
            "Hi {{name}}, a gentle reminder from ARC AI — invoice {{invoice_number}} ({{amount}}) is still awaiting payment. If you've already paid, please ignore this. Any questions, just reply here 🙏",
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "WhatsApp invoice reminder sent",
          body: "Invoice {{invoice_number}} ({{amount}}) unpaid after 3 days — reminder sent on WhatsApp.",
        },
      },
    ],
  },
  {
    id: "whatsapp-pricing-alert",
    name: "WhatsApp buying-signal alert",
    description:
      'Someone types "price", "cost" or "quotation" on WhatsApp → the lead is marked hot and the whole team is pinged to jump in while intent is high.',
    emoji: "🔔",
    trigger: "wa_message_received",
    trigger_config: { keyword: "price" },
    conditions: [],
    steps: [
      { kind: "update_score", config: { score: "hot" } },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "WhatsApp buying signal 🔥",
          body: "{{full_name}} asked about pricing on WhatsApp — jump into the chat!",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Close {{full_name}} — asked for pricing on WhatsApp",
          due_in_days: 1,
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

  // -------------------------------------------------------------------------
  // Client Delivery recipes (0085) — surfaced in the Client Delivery hub's
  // Automations tab. All opt-in: nothing here runs until it's installed.
  // -------------------------------------------------------------------------
  {
    id: "delivery-payment-onboarding",
    name: "Payment received → full client onboarding",
    description:
      "The FIRST payment recorded against a project (on the Payments board or the project itself) kicks off delivery hands-free: a project checklist is seeded, the WhatsApp agent flips into onboarding mode and starts collecting the logo, photos, content and access — plus a team task and a heads-up. Supersedes \"Deposit received 🚀\" for project-linked payments; prefer the Start onboarding button if you'd rather stay in control.",
    emoji: "🤝",
    category: "delivery",
    trigger: "payment_received",
    trigger_config: { first_payment: true },
    conditions: [],
    steps: [
      { kind: "start_wa_onboarding", config: {} },
      {
        kind: "create_task",
        config: {
          title: "Onboarding started — {{full_name}} ({{project_name}})",
          notes:
            "First payment {{amount}} received. The WhatsApp agent is collecting assets — watch the checklist in Client Delivery and step in if it stalls.",
          due_in_days: 2,
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Client onboarding started 🤝",
          body: "{{full_name}} paid {{amount}} — WhatsApp asset collection is underway for {{project_name}}.",
        },
      },
    ],
  },
  {
    id: "delivery-assets-complete",
    name: "All assets in → build kickoff",
    description:
      "The last required checklist item lands → the project moves to In build, the team gets the build task and everyone's notified. The client's milestone message goes out automatically with the stage change.",
    emoji: "✅",
    category: "delivery",
    trigger: "assets_complete",
    trigger_config: {},
    conditions: [],
    steps: [
      { kind: "set_delivery_stage", config: { stage: "build" } },
      {
        kind: "create_task",
        config: {
          title: "Start the build — {{project_name}}",
          notes:
            "Every required asset for {{project_name}} is collected. Assign the build and set the internal deadline.",
          due_in_days: 1,
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "All assets collected ✅",
          body: "{{project_name}} has everything — moved to In build.",
        },
      },
    ],
  },
  {
    id: "delivery-review-request",
    name: "Design ready → client review request",
    description:
      "Moving a project to Client review automatically asks the client to take a look, with their portal link — and files a task to collect the feedback. Works as a WhatsApp free-text when they've written within 24h; add a template name in the step for older threads.",
    emoji: "🎨",
    category: "delivery",
    trigger: "project_stage_changed",
    trigger_config: { stage: "review" },
    conditions: [],
    steps: [
      {
        kind: "send_whatsapp",
        config: {
          message:
            "Hi {{name}}! 🎨 Your design for {{project_name}} is ready for review. Take a look here: {{portal_link}} — reply with anything you'd like changed, or a simple 👍 if we're good to continue!",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Collect review feedback — {{project_name}}",
          notes: "The review request went out. Chase the feedback and log revisions.",
          due_in_days: 2,
        },
      },
    ],
  },
  {
    id: "delivery-handover",
    name: "Delivered → congrats + handover",
    description:
      "Marking a project Delivered sends the client a warm congratulations on WhatsApp and reminds the team to send the handover pack (credentials, invoice, guide).",
    emoji: "🎉",
    category: "delivery",
    trigger: "project_stage_changed",
    trigger_config: { stage: "delivered" },
    conditions: [],
    steps: [
      {
        kind: "send_whatsapp",
        config: {
          message:
            "🎉 Congratulations {{name}} — {{project_name}} is officially delivered! It's been a pleasure building this with you. Your handover pack (access details + guide) is on its way. Anything you need, we're one message away. — ARC AI",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Send handover pack — {{project_name}}",
          notes: "Credentials, final invoice/receipt and the how-to guide.",
          due_in_days: 1,
        },
      },
    ],
  },
  {
    id: "delivery-review-ask",
    name: "Delivered → Google review ask ⭐",
    description:
      "Three days after delivery the client gets ONE friendly ask for a Google review. The 24h window is closed by then, so this REQUIRES a Meta-approved template — create one (e.g. 'arc_review_ask', category Marketing, {{1}} = name) in WhatsApp Manager, put its exact name in the step, and paste your Google review link into the message.",
    emoji: "⭐",
    category: "delivery",
    trigger: "project_delivered",
    trigger_config: {},
    conditions: [],
    steps: [
      { kind: "wait", config: { minutes: 3 * 24 * 60 } },
      {
        kind: "send_whatsapp",
        config: {
          template_name: "arc_review_ask",
          template_lang: "en",
          template_params: ["{{name}}"],
          message:
            "Hi {{name}}! Hope you're loving the new {{project_name}} 🙌 If we earned it, a quick Google review would mean the world to our small team — it takes 30 seconds: [paste your Google review link]. Thank you! — ARC AI",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Review ask sent — {{full_name}}",
          notes: "If they leave one, thank them personally. If not, one gentle nudge in a few days.",
          due_in_days: 4,
        },
      },
    ],
  },
  {
    id: "delivery-testimonial",
    name: "Delivered → testimonial capture 💬",
    description:
      "A week after delivery, ask the client for a couple of sentences on the experience — raw material for the website and proposals. Needs a Meta-approved template (e.g. 'arc_testimonial_ask') since the 24h window is closed by then.",
    emoji: "💬",
    category: "delivery",
    trigger: "project_delivered",
    trigger_config: {},
    conditions: [],
    steps: [
      { kind: "wait", config: { minutes: 7 * 24 * 60 } },
      {
        kind: "send_whatsapp",
        config: {
          template_name: "arc_testimonial_ask",
          template_lang: "en",
          template_params: ["{{name}}"],
          message:
            "Hi {{name}}! Quick favour — could you share a sentence or two about working with us on {{project_name}}? We'd love to feature it (with your permission). Just reply here 🙏 — ARC AI",
        },
      },
      {
        kind: "create_task",
        config: {
          title: "Save {{full_name}}'s testimonial",
          notes: "When they reply, save the quote to the testimonials doc and get permission to publish.",
          due_in_days: 3,
        },
      },
    ],
  },
  {
    id: "delivery-aftercare",
    name: "Delivered → 2-week aftercare check-in 🩺",
    description:
      "Two weeks after delivery: \"is everything running smoothly?\" Catches small issues before they become complaints — and often surfaces the next piece of work. Needs a Meta-approved template (e.g. 'arc_aftercare_checkin').",
    emoji: "🩺",
    category: "delivery",
    trigger: "project_delivered",
    trigger_config: {},
    conditions: [],
    steps: [
      { kind: "wait", config: { minutes: 14 * 24 * 60 } },
      {
        kind: "send_whatsapp",
        config: {
          template_name: "arc_aftercare_checkin",
          template_lang: "en",
          template_params: ["{{name}}"],
          message:
            "Hi {{name}}! Two weeks in — how's {{project_name}} treating you? Everything running smoothly? If anything needs a tweak, reply here and we'll sort it. — ARC AI",
        },
      },
    ],
  },
  {
    id: "delivery-upsell",
    name: "Delivered → upsell opportunity (30 days) 📈",
    description:
      "A month after delivery the team gets an upsell task: what's the natural next service for this client (website → social marketing, social → e-commerce…)? Internal only — nothing is sent to the client automatically.",
    emoji: "📈",
    category: "delivery",
    trigger: "project_delivered",
    trigger_config: {},
    conditions: [],
    steps: [
      { kind: "wait", config: { minutes: 30 * 24 * 60 } },
      {
        kind: "create_task",
        config: {
          title: "Upsell call — {{full_name}}",
          notes:
            "{{project_name}} was delivered a month ago. What are they missing — social marketing, e-commerce, maintenance, AI automation? Prep the pitch and call.",
          due_in_days: 2,
        },
      },
      {
        kind: "notify",
        config: {
          user_id: "all",
          title: "Upsell window open 📈",
          body: "{{full_name}} is 30 days post-delivery — time for the next-service conversation.",
        },
      },
    ],
  },
  {
    id: "delivery-client-welcome",
    name: "New client welcome 👋",
    description:
      "The moment a client record is created they get a short welcome SMS — sets the tone before any project starts.",
    emoji: "👋",
    category: "delivery",
    trigger: "client_created",
    trigger_config: {},
    conditions: [],
    steps: [
      {
        kind: "send_sms",
        config: {
          message:
            "Hi {{name}}, welcome to ARC AI! You're officially on our books — expect great things. Save this number; it's the fastest way to reach the team. — ARC AI",
        },
      },
    ],
  },
];

export function getRecipe(id: string): AutomationRecipe | undefined {
  return AUTOMATION_RECIPES.find((r) => r.id === id);
}
