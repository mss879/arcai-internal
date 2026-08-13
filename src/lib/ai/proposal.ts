import "server-only";

import { AI_MODELS, isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import type {
  FeatureBlock,
  ObjectiveGroup,
  ProposalContent,
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
};

/** The subset of the proposal body the AI is allowed to write (no pricing). */
export type GeneratedNarrative = Pick<
  ProposalContent,
  | "overview"
  | "objectives"
  | "keyFeatures"
  | "educational"
  | "seo"
  | "quality"
>;

const SYSTEM = `You are a senior proposal writer for ARC AI Agency, a premium web studio that builds high-end, conversion-focused websites and e-commerce platforms using Next.js (frontend) and Supabase (backend/CRM).

Write confident, concrete, benefit-driven B2B copy tailored to the specific client and their industry. Be specific to their business — never generic filler. Keep sentences clear and professional.

HARD RULES:
- Never invent or mention any prices, money, fees, percentages, or calendar dates. Pricing is handled elsewhere.
- Use the provided package + included features (+ any listed custom features) as ground truth for scope; do not promise features outside that scope.
- When the client's stated requirements are provided, EVERY one of them must be visibly addressed somewhere in the narrative — in their own vocabulary, mapped to the part of the package that solves it. A requirement the package does NOT cover goes into quality.assumptions or quality.nextSteps as an item to scope together — never silently promised, never silently dropped.
- Output ONLY a single JSON object matching the requested schema. No markdown, no commentary.`;

function userPrompt(input: GenerateInput): string {
  const custom = input.customFeatures && input.customFeatures.length > 0
    ? `\nExtra custom features requested by the client (must be incorporated/highlighted in the proposal narrative where relevant):
${input.customFeatures.map(f => `- ${f.name} (valued at Rs ${f.price.toLocaleString("en-US")})`).join("\n")}`
    : "";
  const reqs = input.requirements && input.requirements.length > 0
    ? `\nWHAT THE CLIENT ACTUALLY ASKED FOR (from the live sales conversation — the heart of this proposal; address every single item, in their language, mapped to what solves it):
${input.requirements.map((r) => `- ${r}`).join("\n")}`
    : "";
  const team = input.teamInstructions?.trim()
    ? `\nEXTRA INSTRUCTIONS FROM THE TEAM (follow them wherever they don't break the hard rules):
"""
${input.teamInstructions.trim().slice(0, 2000)}
"""`
    : "";
  const agentOnly = input.projectKind === "agent";

  return `Client: ${input.clientName}
Project: ${input.projectName || "(untitled)"}
Selected package: ${input.selectionSummary}
Included features (ground truth — reference, don't just restate verbatim):
${input.includedFeatures.map((f) => `- ${f}`).join("\n")}${custom}${reqs}${team}

Business description (written by the agency about this client):
"""
${input.businessDescription.trim()}
"""

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

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function strArr(x: unknown): string[] {
  return Array.isArray(x)
    ? x.map((v) => str(v)).filter((s) => s.length > 0)
    : [];
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

/** Generate the narrative body of a proposal. Throws on misconfiguration / API error. */
export async function generateProposalContent(
  input: GenerateInput,
): Promise<GeneratedNarrative> {
  if (!isOpenAIConfigured()) throw new Error("OPENAI_API_KEY is not set.");

  const raw = await openaiChatJSON(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(input) },
    ],
    {
      temperature: 0.6,
      model: process.env.OPENAI_PROPOSAL_MODEL || AI_MODELS.chat,
    },
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("The AI returned malformed JSON. Try again.");
  }

  const edu = (parsed.educational ?? {}) as Record<string, unknown>;
  const aiAgentRaw = edu.aiAgent as Record<string, unknown> | null | undefined;
  const seo = (parsed.seo ?? {}) as Record<string, unknown>;
  const quality = (parsed.quality ?? {}) as Record<string, unknown>;

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
    quality: {
      bullets: strArr(quality.bullets),
      assumptions: strArr(quality.assumptions),
      nextSteps: strArr(quality.nextSteps),
    },
  };
}
