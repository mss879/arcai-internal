/**
 * The WhatsApp agent's tool catalog — plain data, safe on client AND server.
 *
 * The Agent tab renders this list as permission checkboxes; whatever keys the
 * team ticks are stored in `wa_agent_config.allowed_tools`, and the agent
 * runtime (src/lib/wa-agent.ts) only ever advertises those tools to the model.
 * Adding a tool = implement it in wa-agent.ts + describe it here.
 */

export type WaToolMeta = {
  key: string;
  label: string;
  description: string;
  kind: "read" | "write";
};

export const WA_TOOL_CATALOG: WaToolMeta[] = [
  {
    key: "save_contact",
    label: "Capture contact → create client + lead",
    description:
      "When the person shares their name (and any details), saves it, creates a Client profile and a CRM lead in your chosen pipeline stage — the core new-lead flow.",
    kind: "write",
  },
  {
    key: "get_context",
    label: "Read CRM context",
    description:
      "Looks up the linked lead, client, deal value, notes and recent activity so the agent never asks for things it already knows.",
    kind: "read",
  },
  {
    key: "research_contact",
    label: "Run deep research",
    description:
      "Kicks off the CRM's prospect-research agent (Firecrawl + AI) on the contact's business/website to learn everything about them.",
    kind: "write",
  },
  {
    key: "audit_website",
    label: "Instant website audit",
    description:
      "Live-checks the contact's website in seconds — mobile-friendliness, HTTPS, SEO basics, freshness — so the agent can talk about their site's real issues mid-conversation.",
    kind: "read",
  },
  {
    key: "get_research",
    label: "Read research briefing",
    description:
      "Reads the finished research report so the agent can tailor its pitch to the contact's actual business.",
    kind: "read",
  },
  {
    key: "send_showcase",
    label: "Send the live showcase",
    description:
      "The 'show, don't tell' closer, delivered into the chat as one image. Has a website: audit scores + an AI redesign concept of their homepage. No website: a from-scratch design concept of their potential site, built from details gathered in the conversation.",
    kind: "write",
  },
  {
    key: "update_lead",
    label: "Update the lead",
    description:
      "Sets deal value, score (hot/warm/cold), appends qualification notes and moves the lead forward through the pipeline stages (e.g. to Contacted / Qualified) as the conversation progresses.",
    kind: "write",
  },
  {
    key: "create_task",
    label: "Create team task",
    description:
      "Creates a CRM follow-up task for the team (e.g. 'Call Nimal about the e-commerce build').",
    kind: "write",
  },
  {
    key: "schedule_followup",
    label: "Schedule follow-up reminder",
    description:
      "Schedules a dated follow-up task so the team is reminded to re-engage this contact in X days.",
    kind: "write",
  },
  {
    key: "schedule_promise",
    label: "Keep the customer's promises",
    description:
      "When the customer commits to a time or future event ('call me Monday', 'salary comes on the 25th', 'let me ask my partner'), schedules the agent's own WhatsApp follow-up for exactly that moment — replacing the generic quiet-chat cadence.",
    kind: "write",
  },
  {
    key: "cancel_promise",
    label: "Cancel a scheduled promise",
    description:
      "Cancels or completes a scheduled promise follow-up when plans change or it already resolved in the chat.",
    kind: "write",
  },
  {
    key: "set_language",
    label: "Match the customer's language",
    description:
      "Switches replies to Sinhala or Tamil (native script or romanized 'Singlish'/'Tanglish') ONLY when the customer clearly writes in that language or asks for it — otherwise the agent stays in English. Persists the choice across replies, follow-ups and voice notes.",
    kind: "write",
  },
  {
    key: "book_call",
    label: "Book a call time (the close)",
    description:
      "Agrees a real day and time for a phone call in the chat — no links, no video meetings — then puts a To-Do on your board due at exactly that moment, titled with who to ring and carrying what they're interested in as the notes. You get the usual task reminder before it.",
    kind: "write",
  },
  {
    key: "create_proposal",
    label: "Create proposal draft",
    description:
      "After collecting requirements, generates a full priced proposal draft under Proposals and tasks the team to review + send it.",
    kind: "write",
  },
  {
    key: "send_quote",
    label: "Send signable quote (the closer)",
    description:
      "When the customer agrees to a package, creates a real e-sign quotation (catalog prices only) and delivers the signing link into the chat. Their signature fires the deal-close automation — invoice, payment details, deposit task.",
    kind: "write",
  },
  {
    key: "send_pricelist",
    label: "Send the price-list PDF",
    description:
      "Delivers the branded pricing PDF (the /pricing page's export, with your live price overrides) into the chat as a WhatsApp document — only when the customer explicitly asks for the full list or something to show a partner.",
    kind: "write",
  },
  {
    key: "notify_team",
    label: "Notify the team",
    description:
      "Sends an in-app + push notification to every team member (e.g. 'hot lead wants a call today').",
    kind: "write",
  },
  {
    key: "handoff_human",
    label: "Hand off to a human",
    description:
      "Pauses the AI for this conversation, flags it as needing attention and alerts the team to take over.",
    kind: "write",
  },
];

export function waToolMeta(key: string): WaToolMeta | undefined {
  return WA_TOOL_CATALOG.find((t) => t.key === key);
}

export const DEFAULT_WA_TOOLS = WA_TOOL_CATALOG.map((t) => t.key);
