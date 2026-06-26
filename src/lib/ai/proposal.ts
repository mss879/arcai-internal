import "server-only";

import { AI_MODELS, isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import type {
  FeatureBlock,
  ObjectiveGroup,
  ProposalContent,
  StructurePage,
} from "@/lib/proposal";

export type GenerateInput = {
  businessDescription: string;
  clientName: string;
  projectName: string;
  selectionSummary: string;
  includedFeatures: string[];
  customFeatures?: { name: string; price: number }[];
};

/** The subset of the proposal body the AI is allowed to write (no pricing). */
export type GeneratedNarrative = Pick<
  ProposalContent,
  | "overview"
  | "objectives"
  | "websiteStructure"
  | "keyFeatures"
  | "educational"
  | "seo"
  | "quality"
>;

const SYSTEM = `You are a senior proposal writer for ARC AI Agency, a premium web studio that builds high-end, conversion-focused websites and e-commerce platforms using Next.js (frontend) and Supabase (backend/CRM).

Write confident, concrete, benefit-driven B2B copy tailored to the specific client and their industry. Be specific to their business — never generic filler. Keep sentences clear and professional.

HARD RULES:
- Never invent or mention any prices, money, fees, percentages, or calendar dates. Pricing is handled elsewhere.
- Use the provided package + included features as ground truth for scope; do not promise features outside that scope.
- Output ONLY a single JSON object matching the requested schema. No markdown, no commentary.`;

function userPrompt(input: GenerateInput): string {
  const custom = input.customFeatures && input.customFeatures.length > 0
    ? `\nExtra custom features requested by the client (must be incorporated/highlighted in the proposal narrative where relevant):
${input.customFeatures.map(f => `- ${f.name} (valued at Rs ${f.price.toLocaleString("en-US")})`).join("\n")}`
    : "";

  return `Client: ${input.clientName}
Project: ${input.projectName || "(untitled)"}
Selected package: ${input.selectionSummary}
Included features (ground truth — reference, don't just restate verbatim):
${input.includedFeatures.map((f) => `- ${f}`).join("\n")}${custom}

Business description (written by the agency about this client):
"""
${input.businessDescription.trim()}
"""

Return a JSON object with EXACTLY these keys:
{
  "overview": "2-3 short paragraphs separated by \\n\\n, introducing the client and the goal of the project",
  "objectives": [{ "group": "Brand & Trust", "items": ["...", "..."] }],
  "websiteStructure": [{ "page": "Home Page", "description": "one sentence" }],
  "keyFeatures": [{ "heading": "High-End Frontend Website", "intro": "1-2 sentences", "bullets": ["...", "..."] }],
  "educational": { "intro": "1-2 sentences", "bullets": ["...", "..."], "aiAgent": { "intro": "...", "capabilities": ["...", "..."], "note": "..." } },
  "seo": { "bullets": ["...", "..."], "whyDedicated": "1-2 sentences" },
  "quality": { "bullets": ["...", "..."], "assumptions": ["...", "..."], "nextSteps": ["...", "..."] }
}

Guidance:
- objectives: 3 groups, each with 2-4 short bullet items, tailored to this business.
- websiteStructure: 6-10 pages relevant to THIS business (home, about, the client's actual services/products, contact, etc.).
- keyFeatures: 2-3 blocks. Include a "Backend CRM System" block ONLY if the package includes CRM; include AI agent specifics only if the package includes an AI agent.
- educational.aiAgent: set to null if the package does NOT include an AI agent.
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

function structure(x: unknown): StructurePage[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((p) => ({
      page: str((p as Record<string, unknown>)?.page),
      description: str((p as Record<string, unknown>)?.description),
    }))
    .filter((p) => p.page);
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
    websiteStructure: structure(parsed.websiteStructure),
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
