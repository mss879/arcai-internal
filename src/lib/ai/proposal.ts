import "server-only";

import { AI_MODELS, isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import {
  defaultContent,
  lineItemId,
  type FeatureBlock,
  type LineRecurrence,
  type ObjectiveGroup,
  type ProposalBody,
  type ProposalContent,
  type ProposalSection,
  type TimelineStep,
} from "@/lib/proposal";

export type GenerateInput = {
  businessDescription: string;
  clientName: string;
  projectName: string;
  selectionSummary: string;
  includedFeatures: string[];
  customFeatures?: { name: string; price: number }[];
  /** Concrete requirements, pains and wishes the client stated in the sales
   * conversation (the WhatsApp agent passes these verbatim). The narrative
   * must visibly address every one — this is what turns the fixed proposal
   * skeleton into THEIR proposal rather than a template. */
  requirements?: string[];
  /** Free-form instructions from the team (typed or dictated) — tone, things
   * to emphasise, things to leave out. Followed wherever they don't break the
   * hard rules. */
  teamInstructions?: string;
  /** "agent" = a standalone AI agent + CRM deployment with NO website build —
   * the narrative must not invent website pages or SEO work. */
  projectKind?: "website" | "agent";
  /**
   * Every package on this proposal with the features actually being sold and
   * how each one is charged. Supersedes the flat `includedFeatures` list: it
   * is what lets the writer talk about a website as a BUILD and a social
   * retainer as an ONGOING SERVICE in the same document, instead of mashing
   * two products into one undifferentiated bullet list.
   *
   * `proposalPackages(selection)` in @/lib/proposal returns exactly this shape.
   */
  packages?: { label: string; features: string[]; recurrence: LineRecurrence }[];
  /**
   * Let the writer design the document: an ordered list of sections it chose
   * for THIS client and THIS combination of packages, instead of filling the
   * fixed Overview/Objectives/Key Features/Educational/SEO slots.
   *
   * Explicit `false` forces the fixed skeleton. ABSENT is decided by the
   * proposal itself — free-form as soon as more than one package is being
   * sold, because a two-package deal is precisely what the single-package
   * skeleton cannot describe (it would print an SEO heading over a social
   * retainer and never mention the retainer at all).
   */
  allowFreeSections?: boolean;
};

/**
 * The subset of the proposal body the AI is allowed to write (no pricing).
 *
 * `sections` / `sectionsMode` appear ONLY when the writer composed the
 * document itself. Widening this `Pick<>` rather than replacing it is
 * deliberate: every call site merges the result with `{...defaultContent(),
 * ...narrative}`, so the new keys flow through untouched and a run that
 * returns none leaves a legacy-shaped content object behind.
 */
export type GeneratedNarrative = Pick<
  ProposalContent,
  | "overview"
  | "objectives"
  | "keyFeatures"
  | "educational"
  | "seo"
  | "quality"
> & {
  /** Only when the model chose to write free-form sections. */
  sections?: ProposalSection[];
  sectionsMode?: ProposalContent["sectionsMode"];
};

// ---- Model ---------------------------------------------------------------

/**
 * Proposal writing is the highest-stakes text this app produces — it is the
 * document a client says yes or no to — so it does NOT ride on the cheap
 * conversational default (gpt-4o-mini). It defaults to the sharpest model the
 * codebase uses and, since it now composes a whole document rather than
 * filling six slots, it gets a real timeout instead of the framework default.
 *
 * Override any of the three via env without touching code:
 *   OPENAI_PROPOSAL_MODEL             any chat model this key can use
 *   OPENAI_PROPOSAL_REASONING_EFFORT  minimal|low|medium|high|xhigh
 *   OPENAI_PROPOSAL_TIMEOUT_MS
 *
 * The default is deliberately a model we KNOW every key with GPT-4 access can
 * call. Defaulting to a newer name would cost a failed round-trip on every
 * proposal and then silently drop to the cheap chat default via the fallback
 * in `ask()` — the exact weak output this upgrade exists to prevent, visible
 * only in a server log. Point this at a stronger model when you have one.
 */
const MODEL = process.env.OPENAI_PROPOSAL_MODEL?.trim() || "gpt-4o";
const REASONING_EFFORT =
  process.env.OPENAI_PROPOSAL_REASONING_EFFORT?.trim() || "high";
const TIMEOUT_MS = Number(process.env.OPENAI_PROPOSAL_TIMEOUT_MS) || 180_000;
/** Composition wants room to think; a mechanical repair does not. */
const REPAIR_EFFORT = "medium";
/** Prose, not data extraction — ignored outright by reasoning models. */
const TEMPERATURE = 0.6;

// ---- Guardrails ----------------------------------------------------------
// Freedom in what is SAID, not in how much. Every cap below exists so a model
// that goes off the rails cannot produce a document that fails to render:
// react-pdf will loop or emit blank pages on a block it cannot fit, and a
// proposal that will not open is worse than a templated one.

const MIN_SECTIONS = 3;
const MAX_SECTIONS = 12;
/** Total bodies across the whole document, not per section. */
const MAX_BODIES_TOTAL = 30;
const MAX_BODIES_PER_SECTION = 6;
const MAX_HEADING_CHARS = 48;
/** One bullet, cell, title or caption. */
const MAX_LINE_CHARS = 240;
const MAX_PARA_CHARS = 1200;
const MAX_PARAGRAPHS = 6;
const MAX_BULLETS = 12;
const MAX_GROUPS = 6;
const MAX_GROUP_ITEMS = 8;
const MAX_STEPS = 10;
const MAX_FEATURE_CELLS = 12;
const MAX_TIMELINE_STEPS = 8;
const MAX_TABLE_ROWS = 14;
/** How much of a rejected response we echo back on the repair pass. */
const MAX_REPAIR_ECHO_CHARS = 20_000;

// ---- Prompts -------------------------------------------------------------

/** The rules that hold in BOTH modes. Unchanged — they are what stops the
 * writer inventing money, dates or scope, and freedom does not touch them. */
const HARD_RULES = `HARD RULES:
- Never invent or mention any prices, money, fees, percentages, or calendar dates. Pricing is handled elsewhere.
- Use the provided package + included features (+ any listed custom features) as ground truth for scope; do not promise features outside that scope.
- When the client's stated requirements are provided, EVERY one of them must be visibly addressed somewhere in the narrative — in their own vocabulary, mapped to the part of the package that solves it. A requirement the package does NOT cover goes into quality.assumptions or quality.nextSteps as an item to scope together — never silently promised, never silently dropped.
- Output ONLY a single JSON object matching the requested schema. No markdown, no commentary.`;

const VOICE = `You are a senior proposal writer for ARC AI Agency, a premium web studio that builds high-end, conversion-focused websites and e-commerce platforms using Next.js (frontend) and Supabase (backend/CRM), and runs ongoing services such as social media management and AI agent operations.

Write confident, concrete, benefit-driven B2B copy tailored to the specific client and their industry. Be specific to their business — never generic filler. Keep sentences clear and professional.`;

const SYSTEM = `${VOICE}

${HARD_RULES}`;

const SYSTEM_FREE = `${VOICE}

You DESIGN the document. There is no fixed set of sections: you choose which sections this proposal needs, what each one is called, and what order they appear in, based on this client and on the exact combination of packages being sold. A restaurant buying a website plus a monthly social retainer needs a different document from a manufacturer buying an AI agent — write the one that fits.

${HARD_RULES}

COMPOSITION RULES:
- Cover every package listed as being bought, and give a monthly/ongoing service its own section: a retainer is a service we run every month, not a thing we hand over once. A one-time build is delivered and handed over; never describe it as ongoing, and never describe a retainer as a deliverable that finishes.
- Write ONLY about what is being bought. If no SEO is on this proposal there is no SEO section; if no AI agent is on it there is no AI section. An invented section is the single worst failure here.
- Section 1 is the opening: who this client is, what they are trying to achieve, and what this proposal covers. It always comes first.
- Do not list or promise specific website pages — the structure is agreed at kickoff, and naming pages commits us to a layout the client may not want. Write about capabilities and outcomes instead.
- Vary the shapes. A document that is eight prose sections in a row is as bad as a template.
- Every heading is a short label of at most ${MAX_HEADING_CHARS} characters; it prints in capitals next to a section number.
- Keep bullets under ~16 words.`;

/** Ground-truth block shared by both prompts. Renders to "" when the caller
 * passed no packages, which is why the legacy prompt below is byte-identical
 * to what it has always sent for a single-package proposal. */
function packagesBlock(input: GenerateInput): string {
  const packs = input.packages ?? [];
  if (packs.length === 0) return "";
  const lines = packs.map((p, i) => {
    const feats = p.features.length
      ? p.features.map((f) => `     - ${f}`).join("\n")
      : "     - (no feature list — describe it from the business context only)";
    return `  ${i + 1}. ${p.label} — ${recurrenceBrief(p.recurrence)}\n${feats}`;
  });
  return `\nEVERYTHING THE CLIENT IS BUYING ON THIS PROPOSAL (ground truth — write about ALL of it, and about nothing else):
${lines.join("\n")}
Charging model is scope, not price: say what is ongoing and what is delivered once, but never state an amount, a duration in months, or a number of anything you were not given.`;
}

/** How a line is charged, in words the writer can use. Never a figure. */
function recurrenceBrief(r: LineRecurrence): string {
  switch (r) {
    case "monthly":
      return "ONGOING MONTHLY SERVICE (we run it every month; it does not finish)";
    case "yearly":
      return "ONGOING ANNUAL SERVICE (renews each year)";
    case "at_cost":
      return "PASS-THROUGH AT COST (the client pays the underlying usage; it is not an ARC fee)";
    default:
      return "ONE-TIME BUILD (designed, built and handed over as a project)";
  }
}

/** The client-context block shared by both prompts. */
function contextBlock(input: GenerateInput): string {
  const custom =
    input.customFeatures && input.customFeatures.length > 0
      ? `\nExtra custom features requested by the client (must be incorporated/highlighted in the proposal narrative where relevant):
${input.customFeatures.map((f) => `- ${f.name} (valued at Rs ${f.price.toLocaleString("en-US")})`).join("\n")}`
      : "";
  const reqs =
    input.requirements && input.requirements.length > 0
      ? `\nWHAT THE CLIENT ACTUALLY ASKED FOR (from the live sales conversation — the heart of this proposal; address every single item, in their language, mapped to what solves it):
${input.requirements.map((r) => `- ${r}`).join("\n")}`
      : "";
  const team = input.teamInstructions?.trim()
    ? `\nEXTRA INSTRUCTIONS FROM THE TEAM (follow them wherever they don't break the hard rules):
"""
${input.teamInstructions.trim().slice(0, 2000)}
"""`
    : "";

  return `Client: ${input.clientName}
Project: ${input.projectName || "(untitled)"}
Selected package: ${input.selectionSummary}
Included features (ground truth — reference, don't just restate verbatim):
${input.includedFeatures.map((f) => `- ${f}`).join("\n")}${packagesBlock(input)}${custom}${reqs}${team}

Business description (written by the agency about this client):
"""
${input.businessDescription.trim()}
"""`;
}

/** The fixed-skeleton prompt. Kept verbatim: it is the fallback that has to
 * work when free composition comes back unusable. */
function userPrompt(input: GenerateInput): string {
  const agentOnly = input.projectKind === "agent";

  return `${contextBlock(input)}

Return a JSON object with EXACTLY these keys:
{
  "overview": "2-3 short paragraphs separated by \\n\\n, introducing the client and the goal of the project",
  "objectives": [{ "group": "Brand & Trust", "items": ["...", "..."] }],
  "keyFeatures": [{ "heading": "High-End Frontend Website", "intro": "1-2 sentences", "bullets": ["...", "..."] }],
  "educational": { "intro": "1-2 sentences", "bullets": ["...", "..."], "aiAgent": { "intro": "...", "capabilities": ["...", "..."], "note": "..." } },
  "seo": { "bullets": ["...", "..."], "whyDedicated": "1-2 sentences" },
  "quality": { "bullets": ["...", "..."], "assumptions": ["...", "..."], "nextSteps": ["...", "..."] }
}

Guidance:
- objectives: 3 groups, each with 2-4 short bullet items, tailored to this business — lead with the outcomes the client's own requirements point at.
${
  agentOnly
    ? `- THIS IS AN AGENT-ONLY DEPLOYMENT (no website is being built). Return "seo": {"bullets": [], "whyDedicated": ""} — do NOT invent SEO work.
- keyFeatures: 2-3 blocks about the AI agent and the CRM it comes with — how it answers, qualifies, follows up, and how every chat lands in the pipeline. Where a block answers one of the client's stated requirements, say so in its intro.
- educational.aiAgent: REQUIRED — this is the product.`
    : `- NEVER list or promise specific website pages — the structure is agreed with the client during kickoff, and naming pages here commits us to a layout they may not want. Talk about capabilities and outcomes instead.
- keyFeatures: 2-3 blocks. Include a "Backend CRM System" block ONLY if the package includes CRM; include AI agent specifics only if the package includes an AI agent. Where a block answers one of the client's stated requirements, say so in its intro ("you mentioned X — this is what handles it").
- educational.aiAgent: set to null if the package does NOT include an AI agent.`
}
- Keep every bullet under ~16 words.`;
}

/** The eight shapes the proposal PDF can draw. The writer is free in content
 * and order; it is not free in layout, which is what keeps an arbitrary
 * section looking like an ARC AI proposal. */
const BODY_SHAPES = `Each entry in "body" is one of these eight shapes, and NOTHING else:
  { "kind": "prose",    "paragraphs": ["...", "..."] }
  { "kind": "bullets",  "items": ["...", "..."] }
  { "kind": "groups",   "groups": [{ "heading": "...", "intro": "optional", "items": ["...", "..."] }] }
  { "kind": "features", "items": [{ "title": "...", "description": "one short line" }] }
  { "kind": "steps",    "steps": [{ "title": "...", "description": "optional" }] }
  { "kind": "timeline", "steps": [{ "title": "...", "description": "...", "duration": "Day 1-2" }] }
  { "kind": "table",    "columns": ["Item", "Billing"], "rows": [["...", "..."], ["...", "..."]] }
  { "kind": "note",     "text": "one short muted footnote" }

Choosing well:
- "prose" opens a section; "bullets" and "features" carry what is included; "groups" splits a section by theme (one heading per package, for example); "steps" is a process; "timeline" is a schedule with durations (relative only — "Day 1-2", "Week 3" — NEVER a calendar date); "table" is a two-column comparison such as what is one-time versus what is monthly; "note" is a caveat.
- Two or three bodies per section reads best: a short intro in prose, then the detail.`;

/** The free-composition prompt. */
function freePrompt(input: GenerateInput): string {
  const agentOnly = input.projectKind === "agent";

  return `${contextBlock(input)}

Design the proposal. Return a JSON object with EXACTLY these keys:
{
  "overview": "2-3 short paragraphs separated by \\n\\n, introducing the client and what this proposal is for",
  "sections": [
    {
      "id": "short-slug",
      "heading": "SHORT SECTION TITLE",
      "placement": "before",
      "body": [ ... ]
    }
  ],
  "quality": { "bullets": ["...", "..."], "assumptions": ["...", "..."], "nextSteps": ["...", "..."] }
}

"sections" is the whole narrative and it is yours to design: between ${MIN_SECTIONS} and ${MAX_SECTIONS} sections, in the order you want them read, each with a heading you chose. Section 1 is the opening. Do not reuse the old fixed headings unless they genuinely fit.

"placement" says which side of the pricing table a section sits on: "before" for everything that argues the case, "after" for anything that reads better once the client has seen the numbers (how the work splits between one-time and ongoing, what happens next). Most sections are "before"; end with one or two "after".

${BODY_SHAPES}

"quality" still prints after the pricing table and is where the commercial close lives:
- quality.bullets: the standards the work is held to.
- quality.assumptions: what we are assuming, INCLUDING anything the client asked for that these packages do not cover — name it as something to scope together rather than promising or dropping it.
- quality.nextSteps: what happens next to get started. Never empty.
${
  agentOnly
    ? `\nTHIS IS AN AGENT-ONLY DEPLOYMENT — no website is being built. Do not write a website, page or SEO section.`
    : ""
}
Write the document now.`;
}

/** The repair prompt: hand the model its own output plus exactly what was
 * wrong with it. One pass only — after that the fixed skeleton takes over. */
function repairPrompt(problems: string[]): string {
  return `That response could not be used. Problems found:
${problems.map((p) => `- ${p}`).join("\n")}

Return the COMPLETE corrected JSON object — the same keys, all of the content, with those problems fixed. Every entry in every "body" array must be one of the eight shapes exactly as specified, spelled exactly as shown. No commentary.`;
}

// ---- Sanitisers ----------------------------------------------------------

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function strArr(x: unknown): string[] {
  return Array.isArray(x)
    ? x.map((v) => str(v)).filter((s) => s.length > 0)
    : [];
}

/** Trim to a hard character budget on a word boundary. A model that writes a
 * 4,000-character "bullet" must not be able to produce a block react-pdf
 * cannot fit on a page. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function lines(x: unknown, count: number, chars = MAX_LINE_CHARS): string[] {
  return strArr(x)
    .slice(0, count)
    .map((s) => clip(s, chars));
}

function objectives(x: unknown): ObjectiveGroup[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((g) => ({
      group: str((g as Record<string, unknown>)?.group),
      items: strArr((g as Record<string, unknown>)?.items),
    }))
    .filter((g) => g.group && g.items.length);
}

function features(x: unknown): FeatureBlock[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((f) => ({
      heading: str((f as Record<string, unknown>)?.heading),
      intro: str((f as Record<string, unknown>)?.intro),
      bullets: strArr((f as Record<string, unknown>)?.bullets),
    }))
    .filter((f) => f.heading);
}

function rec(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function timelineSteps(x: unknown, max: number): TimelineStep[] {
  if (!Array.isArray(x)) return [];
  return x
    .slice(0, max)
    .map((s) => {
      const o = rec(s);
      return {
        title: clip(str(o.title), MAX_LINE_CHARS),
        description: clip(str(o.description), MAX_LINE_CHARS),
        duration: clip(str(o.duration), 40),
      };
    })
    .filter((s) => s.title.length > 0);
}

/**
 * One body block, or null if it is not a shape the PDF can draw.
 *
 * Everything here is defensive on purpose. `renderToBuffer` is the download,
 * the emailed file AND the on-screen preview, so a single malformed body —
 * `steps: undefined`, a table row that is a bare string — would not degrade
 * one section, it would make that proposal permanently unopenable.
 */
function bodyOf(x: unknown): ProposalBody | null {
  const b = rec(x);
  switch (str(b.kind)) {
    case "prose": {
      const paragraphs = lines(b.paragraphs, MAX_PARAGRAPHS, MAX_PARA_CHARS);
      return paragraphs.length ? { kind: "prose", paragraphs } : null;
    }
    case "bullets": {
      const items = lines(b.items, MAX_BULLETS);
      return items.length ? { kind: "bullets", items } : null;
    }
    case "groups": {
      if (!Array.isArray(b.groups)) return null;
      const groups = b.groups
        .slice(0, MAX_GROUPS)
        .map((g) => {
          const o = rec(g);
          const intro = clip(str(o.intro), MAX_PARA_CHARS);
          return {
            heading: clip(str(o.heading), MAX_HEADING_CHARS),
            ...(intro ? { intro } : {}),
            items: lines(o.items, MAX_GROUP_ITEMS),
          };
        })
        .filter((g) => g.heading.length > 0 && g.items.length > 0);
      return groups.length ? { kind: "groups", groups } : null;
    }
    case "steps": {
      if (!Array.isArray(b.steps)) return null;
      const steps = b.steps
        .slice(0, MAX_STEPS)
        .map((s) => {
          const o = rec(s);
          const description = clip(str(o.description), MAX_LINE_CHARS);
          return {
            title: clip(str(o.title), MAX_LINE_CHARS),
            ...(description ? { description } : {}),
          };
        })
        .filter((s) => s.title.length > 0);
      return steps.length ? { kind: "steps", steps } : null;
    }
    case "features": {
      if (!Array.isArray(b.items)) return null;
      const items = b.items
        .slice(0, MAX_FEATURE_CELLS)
        .map((f) => {
          const o = rec(f);
          // A grid cell is atomic in the PDF; a paragraph inside one is what
          // makes react-pdf emit blank pages. Keep the description to a line.
          const description = clip(str(o.description), MAX_LINE_CHARS);
          return {
            title: clip(str(o.title), MAX_HEADING_CHARS),
            ...(description ? { description } : {}),
          };
        })
        .filter((f) => f.title.length > 0);
      return items.length ? { kind: "features", items } : null;
    }
    case "timeline": {
      const steps = timelineSteps(b.steps, MAX_TIMELINE_STEPS);
      return steps.length ? { kind: "timeline", steps } : null;
    }
    case "table": {
      const cols = lines(b.columns, 2, MAX_HEADING_CHARS);
      if (cols.length !== 2 || !Array.isArray(b.rows)) return null;
      const rows: [string, string][] = [];
      for (const r of b.rows.slice(0, MAX_TABLE_ROWS)) {
        // A row must be a pair. A model that returns a bare string here would
        // otherwise reach the renderer as `row[1] === undefined`.
        if (!Array.isArray(r)) continue;
        const left = clip(str(r[0]), MAX_LINE_CHARS);
        const right = clip(str(r[1]), MAX_LINE_CHARS);
        if (left || right) rows.push([left, right]);
      }
      const width = str(b.labelWidth);
      return rows.length
        ? {
            kind: "table",
            columns: [cols[0], cols[1]],
            rows,
            ...(/^\d{1,3}%$/.test(width) ? { labelWidth: width } : {}),
          }
        : null;
    }
    case "note": {
      const text = clip(str(b.text), MAX_PARA_CHARS);
      return text ? { kind: "note", text } : null;
    }
    default:
      // Unknown shape — dropped here rather than at render time, where it
      // would have nothing to draw.
      return null;
  }
}

/**
 * The writer's sections, validated into something the PDF can always draw.
 * Drops any section without a heading or without at least one renderable
 * body, de-duplicates ids, and spends a single document-wide body budget so
 * one runaway section cannot fill the whole proposal.
 */
function sectionsOf(x: unknown): ProposalSection[] {
  if (!Array.isArray(x)) return [];
  const out: ProposalSection[] = [];
  const ids = new Set<string>();
  let budget = MAX_BODIES_TOTAL;

  for (const raw of x) {
    if (out.length >= MAX_SECTIONS || budget <= 0) break;
    const s = rec(raw);
    const heading = clip(str(s.heading), MAX_HEADING_CHARS);
    if (!heading) continue;

    const bodies: ProposalBody[] = [];
    const candidates = Array.isArray(s.body) ? s.body : [];
    for (const c of candidates.slice(0, MAX_BODIES_PER_SECTION)) {
      if (budget <= 0) break;
      const body = bodyOf(c);
      if (!body) continue;
      bodies.push(body);
      budget -= 1;
    }
    if (bodies.length === 0) continue;

    // `lineItemId` is the module's slugger; reused so a section id and a line
    // item id are formed the same way and stay stable across an update.
    let id = str(s.id) ? lineItemId(str(s.id)) : lineItemId(heading);
    if (ids.has(id)) id = `${id}-${out.length + 1}`;
    ids.add(id);

    out.push({
      id,
      heading,
      placement: str(s.placement) === "after" ? "after" : "before",
      body: bodies,
    });
  }

  // The opening section argues the case; it can never sit after the price
  // table, whatever the model labelled it.
  if (out.length > 0) out[0].placement = "before";
  return out;
}

function qualityOf(x: unknown): ProposalContent["quality"] {
  const q = rec(x);
  return {
    bullets: strArr(q.bullets),
    assumptions: strArr(q.assumptions),
    nextSteps: strArr(q.nextSteps),
  };
}

// ---- Model plumbing ------------------------------------------------------

/** True when OpenAI rejected the MODEL ITSELF rather than the request — a
 * name that is not enabled on this account. Only this class of failure is
 * worth silently retrying on the proven default; a content or quota error
 * must surface. */
function isUnknownModel(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return (
    /\(404\)/.test(m) ||
    /model_not_found|does not exist|do not have access/i.test(m)
  );
}

/** One JSON round-trip. Returns the raw string too, so a rejected response
 * can be quoted back to the model on the repair pass. */
async function ask(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  effort: string,
): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  let raw: string;
  try {
    raw = await openaiChatJSON(messages, {
      model: MODEL,
      temperature: TEMPERATURE,
      reasoningEffort: effort,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    if (!isUnknownModel(err) || MODEL === AI_MODELS.chat) throw err;
    // The configured model is not available on this key. A proposal the team
    // is waiting on matters more than the upgrade, so fall back to the model
    // the rest of the app is proven to run on and say so in the logs.
    console.warn(
      `[proposal] model "${MODEL}" unavailable, falling back to "${AI_MODELS.chat}". Set OPENAI_PROPOSAL_MODEL to a model this key can use.`,
    );
    raw = await openaiChatJSON(messages, {
      model: AI_MODELS.chat,
      temperature: TEMPERATURE,
      reasoningEffort: effort,
      timeoutMs: TIMEOUT_MS,
    });
  }

  try {
    return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    throw new Error("The AI returned malformed JSON. Try again.");
  }
}

// ---- The two modes -------------------------------------------------------

/**
 * Whether this proposal gets to design itself. Explicit wins; otherwise the
 * proposal decides — more than one package on the document means the fixed
 * skeleton structurally cannot describe it.
 */
function wantsFreeSections(input: GenerateInput): boolean {
  if (typeof input.allowFreeSections === "boolean") {
    return input.allowFreeSections;
  }
  return (input.packages?.length ?? 0) > 1;
}

/** The fixed skeleton — unchanged, and the floor everything falls back to. */
async function skeletonNarrative(
  input: GenerateInput,
): Promise<GeneratedNarrative> {
  const { parsed } = await ask(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(input) },
    ],
    REASONING_EFFORT,
  );

  const edu = rec(parsed.educational);
  const aiAgentRaw = edu.aiAgent as Record<string, unknown> | null | undefined;
  const seo = rec(parsed.seo);

  return {
    overview: str(parsed.overview),
    objectives: objectives(parsed.objectives),
    keyFeatures: features(parsed.keyFeatures),
    educational: {
      intro: str(edu.intro),
      bullets: strArr(edu.bullets),
      aiAgent:
        aiAgentRaw && typeof aiAgentRaw === "object"
          ? {
              intro: str(aiAgentRaw.intro),
              capabilities: strArr(aiAgentRaw.capabilities),
              note: str(aiAgentRaw.note),
            }
          : null,
    },
    seo: {
      bullets: strArr(seo.bullets),
      whyDedicated: str(seo.whyDedicated),
    },
    quality: qualityOf(parsed.quality),
  };
}

/**
 * Turn a free-composition response into a narrative, or explain why it can't
 * be one. Anything fixable is fixed here rather than costing another API call;
 * only a response with no usable document in it comes back null.
 */
function buildFreeNarrative(parsed: Record<string, unknown>): {
  narrative: GeneratedNarrative | null;
  problems: string[];
} {
  const problems: string[] = [];
  const sections = sectionsOf(parsed.sections);
  const overview = str(parsed.overview);
  const quality = qualityOf(parsed.quality);

  if (sections.length < MIN_SECTIONS) {
    problems.push(
      `Only ${sections.length} usable section(s) came back — at least ${MIN_SECTIONS} are required. A section needs a "heading" and a "body" array holding at least one of the eight listed shapes; anything else was dropped.`,
    );
  }
  if (!overview) {
    problems.push(`"overview" was empty. It must be 2-3 short paragraphs.`);
  }
  if (problems.length > 0) return { narrative: null, problems };

  return {
    narrative: {
      overview,
      // Deliberately empty: in "replace_narrative" the PDF suppresses the six
      // fixed narrative sections, and leaving them blank means a stray reader
      // of this object can never print a half-template alongside the real one.
      objectives: [],
      keyFeatures: [],
      educational: { intro: "", bullets: [], aiAgent: null },
      seo: { bullets: [], whyDedicated: "" },
      quality: {
        ...quality,
        // The next-steps list is the commercial close and it prints after the
        // pricing table. Backfilled with the house standard rather than left
        // blank — this is the one part of the document that must never be
        // missing, and these steps state no price and no date.
        nextSteps: quality.nextSteps.length
          ? quality.nextSteps
          : defaultContent().quality.nextSteps,
      },
      sections,
      // Forced, never taken from the model: "replace_all" would drop Terms of
      // Payment and Maintenance & Support, which is a commercial decision the
      // writer does not get to make on its own.
      sectionsMode: "replace_narrative",
    },
    problems: [],
  };
}

/** Generate the narrative body of a proposal. Throws on misconfiguration / API error. */
export async function generateProposalContent(
  input: GenerateInput,
): Promise<GeneratedNarrative> {
  if (!isOpenAIConfigured()) throw new Error("OPENAI_API_KEY is not set.");
  if (!wantsFreeSections(input)) return skeletonNarrative(input);

  const messages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[] = [
    { role: "system", content: SYSTEM_FREE },
    { role: "user", content: freePrompt(input) },
  ];

  const first = await ask(messages, REASONING_EFFORT);
  let built = buildFreeNarrative(first.parsed);

  if (!built.narrative) {
    // One repair pass, holding its own output up against what was wrong with
    // it. Cheaper and far more likely to land than regenerating blind.
    const repaired = await ask(
      [
        ...messages,
        { role: "assistant", content: first.raw.slice(0, MAX_REPAIR_ECHO_CHARS) },
        { role: "user", content: repairPrompt(built.problems) },
      ],
      REPAIR_EFFORT,
    );
    built = buildFreeNarrative(repaired.parsed);
  }

  if (built.narrative) return built.narrative;

  // Twice unusable. Fall back to the fixed skeleton and return NO `sections`
  // key: a templated proposal is a disappointment, an unopenable one is a
  // broken deliverable, and the team can rewrite from the editor.
  console.warn(
    `[proposal] free-form composition unusable after a repair pass (${built.problems.join(" | ")}); falling back to the fixed skeleton.`,
  );
  return skeletonNarrative(input);
}
