/**
 * The Content Office roster (0130) — who works here, on which model, with
 * which tools, at which desk.
 *
 * Pure and client-safe: the floor draws from it, the runtime composes from
 * it, and `roster.test.ts` pins it. A row in `office_agents` overrides one
 * agent's model / effort / persona / name; the code is the default.
 *
 * Model choices, and why:
 *   manager   gpt-6-astra — the one the owner asked for by name: it plans,
 *             delegates and reviews, and tool calling on it requires the
 *             Responses API (which is why `src/lib/ai/responses.ts` exists).
 *             Falls back to Sol then 5.5 while the key is still on the
 *             rollout list; the fallback is recorded on the task.
 *   research  Terra with the built-in web search — balanced cost for a lot
 *             of reading; every finding must carry a URL.
 *   planner   Sol — the calendar is where reasoning pays.
 *   writer    Terra — good copy at volume.
 *   designer  Terra — art direction, then hands the draft to Gemini.
 *   brand     Terra — judgement against a written voice.
 *   qa        gpt-5.5 — a DIFFERENT family from the writer on purpose, so
 *             the checker does not share the writer's blind spots.
 *   publisher gpt-5.4-mini — timing and a proposal; cheap and quick.
 */

import type { OfficeAgentKey, OfficeEffort } from "@/lib/database.types";

import type { OfficeAgentRow, OfficeAgentView, OfficeZoneKey } from "./office-types";
import type { OfficeToolName } from "./tool-names";

export type AgentDef = {
  key: OfficeAgentKey;
  name: string;
  title: string;
  description: string;
  color: string;
  /** First available wins; a fallback is written to `office_tasks.model_note`. */
  modelChain: string[];
  effort: OfficeEffort;
  tools: OfficeToolName[];
  webSearch: { contextSize: "low" | "medium" | "high" } | null;
  zone: OfficeZoneKey;
  /** Which seat in the zone (two generalists share a studio). Default 0. */
  seat?: number;
  /** The agent's own voice, prepended to the shared rules. */
  persona: string;
  maxOutputTokens: number;
};

export const ROSTER: readonly AgentDef[] = [
  {
    key: "manager",
    name: "Astra",
    title: "Content Director",
    description:
      "Turns a goal into a plan, briefs the specialists, reviews the finished work and decides what goes to you for approval.",
    color: "#f97316",
    modelChain: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"],
    effort: "high",
    tools: ["get_brand_profile", "list_recent_posts", "get_content_calendar", "list_social_accounts"],
    webSearch: null,
    zone: "managerOffice",
    persona:
      "You are Astra, the Content Director of a small digital agency's content team. You think like a seasoned head of social: audience first, one clear idea per post, and you never ask a specialist for work the brief does not need.",
    maxOutputTokens: 6_000,
  },
  {
    key: "research",
    name: "Scout",
    title: "Researcher",
    description:
      "Reads the web for trends, competitor angles and audience facts. Every finding carries the page it came from.",
    color: "#0ea5e9",
    modelChain: ["gpt-5.6-terra", "gpt-5.5"],
    effort: "medium",
    tools: ["get_brand_profile", "list_recent_posts"],
    webSearch: { contextSize: "medium" },
    zone: "library",
    persona:
      "You are Scout, the team's researcher. You are sceptical, concrete and fast: you search, you read, you quote the source. You never state a figure you did not find on a page you can cite.",
    maxOutputTokens: 5_000,
  },
  {
    key: "planner",
    name: "Grid",
    title: "Content Planner",
    description:
      "Lays out the calendar: which day, which pillar, which format, which hook — and why that order.",
    color: "#8b5cf6",
    modelChain: ["gpt-5.6-sol", "gpt-5.5"],
    effort: "medium",
    tools: ["get_content_calendar", "get_brand_profile", "list_recent_posts"],
    webSearch: null,
    zone: "strategyTable",
    persona:
      "You are Grid, the content planner. You balance pillars, avoid repeating what went out recently, and give every post a reason to exist on its date.",
    maxOutputTokens: 5_000,
  },
  {
    key: "writer",
    name: "Quill",
    title: "Copywriter",
    description:
      "Writes the caption, the hashtags and two different carousel concepts, slide by slide.",
    color: "#10b981",
    modelChain: ["gpt-5.6-terra", "gpt-5.5"],
    effort: "medium",
    tools: ["get_brand_profile", "get_brand_references"],
    webSearch: null,
    zone: "writingDesk",
    persona:
      "You are Quill, the copywriter. Scroll-stopping, concrete, useful — never generic filler. Short sentences. British English.",
    maxOutputTokens: 5_000,
  },
  {
    key: "designer",
    name: "Pixel",
    title: "Art Director",
    description:
      "Gives each concept its visual direction and hands the draft to the render queue, where Gemini paints the slides.",
    color: "#ec4899",
    modelChain: ["gpt-5.6-terra", "gpt-5.5"],
    effort: "medium",
    tools: ["get_brand_references", "get_brand_profile", "create_carousel_draft"],
    webSearch: null,
    zone: "designStudio",
    persona:
      "You are Pixel, the art director. You describe palette, layout system, typography mood and imagery so a renderer can paint a cohesive carousel that matches the brand's reference library.",
    maxOutputTokens: 5_000,
  },
  {
    key: "brand",
    name: "Tone",
    title: "Brand Guardian",
    description:
      "Checks every line against the brand voice, pillars and banned words, and rewrites what drifts.",
    color: "#f59e0b",
    modelChain: ["gpt-5.6-terra", "gpt-5.5"],
    effort: "medium",
    tools: ["get_brand_profile", "get_brand_references"],
    webSearch: null,
    zone: "brandCorner",
    persona:
      "You are Tone, the brand guardian. You know the voice by heart and you protect it without making everything sound the same.",
    maxOutputTokens: 4_000,
  },
  {
    key: "qa",
    name: "Audit",
    title: "Quality Checker",
    description:
      "Independently checks facts against sources, platform limits, brand fit, hooks, CTAs and spelling — and sends work back with exact fixes.",
    color: "#6366f1",
    modelChain: ["gpt-5.5", "gpt-5.6-sol"],
    effort: "high",
    tools: ["get_brand_profile", "get_carousel_draft"],
    webSearch: null,
    zone: "qaDesk",
    persona:
      "You are Audit, the quality checker. You did not write this and you owe it nothing: find what is wrong, say exactly how to fix it, and pass only what you would post yourself.",
    maxOutputTokens: 4_000,
  },
  {
    key: "publisher",
    name: "Relay",
    title: "Publisher",
    description:
      "Picks posting times across the connected accounts and prepares the schedule. Queues posts itself only when auto-publish is on.",
    color: "#14b8a6",
    modelChain: ["gpt-5.4-mini", "gpt-5.4"],
    effort: "low",
    tools: ["list_social_accounts", "get_content_calendar", "get_carousel_draft"],
    webSearch: null,
    zone: "dispatchDesk",
    persona:
      "You are Relay, the publisher. Colombo time, 09:00–20:00, spread across the range, never two posts on the same day for the same account, and you never claim anything was posted unless a tool told you so.",
    maxOutputTokens: 3_000,
  },
  // 0131 — the generalists. Not part of the Director's plans: you hand them a
  // job directly. Second-best model by the owner's choice (Sol, not Astra).
  {
    key: "ops_a",
    name: "Nova",
    title: "Generalist",
    description:
      "Takes any one-off job: research a company or topic, pull a brand's look and voice from its website, find a client in the CRM and draft them a message for your approval.",
    color: "#2563eb",
    modelChain: ["gpt-5.6-sol", "gpt-5.5"],
    effort: "medium",
    tools: ["get_brand_profile", "list_recent_posts", "get_content_calendar", "fetch_website", "lookup_client", "prepare_message"],
    webSearch: { contextSize: "medium" },
    zone: "opsStudio",
    seat: 0,
    persona:
      "You are Nova, a generalist at a small digital agency. You take a job end to end: find out, make, draft, report — concretely and with sources. You never send anything yourself; a message you draft is parked for a person to approve.",
    maxOutputTokens: 5_000,
  },
  {
    key: "ops_b",
    name: "Atlas",
    title: "Generalist",
    description:
      "The second pair of hands for one-off jobs — same skills as Nova, so two errands can run at once.",
    color: "#65a30d",
    modelChain: ["gpt-5.6-sol", "gpt-5.5"],
    effort: "medium",
    tools: ["get_brand_profile", "list_recent_posts", "get_content_calendar", "fetch_website", "lookup_client", "prepare_message"],
    webSearch: { contextSize: "medium" },
    zone: "opsStudio",
    seat: 1,
    persona:
      "You are Atlas, a generalist at a small digital agency. You take a job end to end: find out, make, draft, report — concretely and with sources. You never send anything yourself; a message you draft is parked for a person to approve.",
    maxOutputTokens: 5_000,
  },
];

export const AGENT_KEYS: readonly OfficeAgentKey[] = ROSTER.map((a) => a.key);

export function agentByKey(key: string): AgentDef | null {
  return ROSTER.find((a) => a.key === key) ?? null;
}

export function isAgentKey(key: string): key is OfficeAgentKey {
  return (AGENT_KEYS as readonly string[]).includes(key);
}

const EFFORTS: readonly OfficeEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isOfficeEffort(v: unknown): v is OfficeEffort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

/**
 * The model chain for one agent: an env override (`OPENAI_AGENT_<KEY>_MODEL`)
 * or a row's model goes first; the code's chain follows as fallbacks, minus
 * duplicates. `env` is a parameter so this stays pure.
 */
export function modelChainFor(
  def: AgentDef,
  rowModel: string | null | undefined,
  env: Record<string, string | undefined> = {},
): string[] {
  const envModel = env[`OPENAI_AGENT_${def.key.toUpperCase()}_MODEL`]?.trim();
  const first = [envModel, rowModel?.trim()].filter((m): m is string => Boolean(m));
  const out: string[] = [];
  for (const m of [...first, ...def.modelChain]) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** Code defaults ⊕ the `office_agents` rows → what the UI and runtime use. */
export function mergeRosterOverrides(
  rows: readonly OfficeAgentRow[] | null | undefined,
  env: Record<string, string | undefined> = {},
): OfficeAgentView[] {
  const byKey = new Map((rows ?? []).map((r) => [r.key, r] as const));
  return ROSTER.map((def) => {
    const row = byKey.get(def.key);
    const chain = modelChainFor(def, row?.model ?? null, env);
    const rowTools = Array.isArray(row?.tools)
      ? (row!.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    return {
      key: def.key,
      name: row?.name?.trim() || def.name,
      title: row?.title?.trim() || def.title,
      description: row?.description?.trim() || def.description,
      color: row?.color?.trim() || def.color,
      model: chain[0],
      chain,
      effort: isOfficeEffort(row?.reasoning_effort) ? row!.reasoning_effort! : def.effort,
      enabled: row?.enabled ?? true,
      zone: def.zone,
      seat: def.seat ?? 0,
      instructions: row?.instructions ?? "",
      tools: rowTools.length ? rowTools : [...def.tools],
      webSearch: def.webSearch !== null,
      overridden: Boolean(row?.model?.trim() || env[`OPENAI_AGENT_${def.key.toUpperCase()}_MODEL`]?.trim()),
    };
  });
}
