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
    key: "get_research",
    label: "Read research briefing",
    description:
      "Reads the finished research report so the agent can tailor its pitch to the contact's actual business.",
    kind: "read",
  },
  {
    key: "update_lead",
    label: "Update the lead",
    description:
      "Sets deal value, score (hot/warm/cold) and appends qualification notes onto the linked CRM lead.",
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
    key: "send_booking_link",
    label: "Share meeting booking link",
    description:
      "Fetches your active booking pages (Meetings) and shares a link so the contact can book a call.",
    kind: "read",
  },
  {
    key: "create_proposal",
    label: "Create proposal draft",
    description:
      "After collecting requirements, generates a full priced proposal draft under Proposals and tasks the team to review + send it.",
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
