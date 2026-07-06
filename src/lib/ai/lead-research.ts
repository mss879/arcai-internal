import "server-only";

import { openaiChatJSON, isOpenAIConfigured, AI_MODELS } from "@/lib/ai/openai";
import {
  firecrawlSearch,
  firecrawlScrape,
  isFirecrawlConfigured,
  type FirecrawlPage,
} from "@/lib/ai/firecrawl";
import {
  parseResearchReport,
  type ResearchReport,
  type ResearchSource,
} from "@/lib/research-report";

/**
 * The prospect research pipeline.
 *
 *   1. Fan out a handful of targeted searches through Firecrawl —
 *      the LinkedIn company page, a general overview, competitors,
 *      and recent news — collecting the scraped page markdown.
 *   2. Optionally scrape the company's own site if we found it.
 *   3. Feed the gathered context to OpenAI, which condenses it into
 *      a structured briefing (overview, competitors, pain points,
 *      talking points, discovery questions).
 *
 * Every external call degrades gracefully: no Firecrawl key → the
 * report is written from the lead's own fields; no OpenAI key → we
 * still return the raw sources with a lightweight heuristic summary.
 */

export type ResearchInput = {
  company: string;
  /** Optional extra signal that sharpens the searches. */
  website?: string | null;
  contactName?: string | null;
  industry?: string | null;
  location?: string | null;
};

export type ResearchResult = {
  report: ResearchReport;
  sources: ResearchSource[];
};

const MODEL = process.env.OPENAI_RESEARCH_MODEL || AI_MODELS.chat;

/** Trim scraped markdown so a single page can't blow the token budget. */
const MAX_CHARS_PER_PAGE = 4000;
/** Cap total context handed to the model. */
const MAX_TOTAL_CHARS = 24000;

const SYSTEM = `You are a B2B sales research analyst preparing a rep for a first
call with a prospect. You are given raw web/LinkedIn/news excerpts about a
company. Extract only what the excerpts support — never invent facts, numbers,
funding, or people. When a field is unknown, return an empty string or empty
array. Write in crisp, factual sales-brief language. Return ONLY one JSON
object, no markdown fences.`;

function userPrompt(input: ResearchInput, context: string): string {
  return `Company to research: ${input.company}
${input.website ? `Known website: ${input.website}\n` : ""}${
    input.industry ? `Industry hint: ${input.industry}\n` : ""
  }${input.location ? `Location hint: ${input.location}\n` : ""}${
    input.contactName ? `Our contact there: ${input.contactName}\n` : ""
  }
Below are excerpts gathered from the web, LinkedIn, and news for this company.
Some excerpts may be about a different company with a similar name — ignore
those and only use excerpts clearly about "${input.company}".

=== SOURCE EXCERPTS ===
${context}
=== END SOURCES ===

Return a JSON object with EXACTLY these keys:
{
  "overview": "2-4 sentence plain-English summary of what the company does and who it serves",
  "industry": "primary industry / vertical, or ''",
  "headquarters": "city, country if known, else ''",
  "company_size": "employee count or range if stated, else ''",
  "founded": "founding year if stated, else ''",
  "website": "official company website URL if found, else ''",
  "linkedin_url": "company LinkedIn URL if found, else ''",
  "products_services": ["their main products or services, one per item"],
  "competitors": [{ "name": "Competitor", "note": "one line on why they compete" }],
  "recent_news": [{ "title": "headline", "summary": "one sentence", "url": "source url or ''" }],
  "pain_points": ["likely business challenges this company faces that we could help with"],
  "talking_points": ["specific, personalised angles the rep can open with on the call"],
  "discovery_questions": ["sharp questions to ask this prospect to qualify the opportunity"]
}

Guidance:
- competitors: 3-6 real competitors inferred from the industry and offering.
- talking_points & discovery_questions: 3-5 each, tailored to THIS company, not generic.
- Keep every string tight; no fluff, no repetition of the raw excerpts verbatim.`;
}

/** Collapse a set of scraped pages into a labelled, length-capped context blob. */
function buildContext(
  groups: { label: string; pages: FirecrawlPage[] }[],
): string {
  const seen = new Set<string>();
  const chunks: string[] = [];
  let total = 0;

  for (const group of groups) {
    for (const page of group.pages) {
      if (seen.has(page.url)) continue;
      seen.add(page.url);

      const body = (page.markdown || page.description || "")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, MAX_CHARS_PER_PAGE)
        .trim();
      if (!body) continue;

      const chunk = `## [${group.label}] ${page.title}\nURL: ${page.url}\n${body}`;
      // Skip a chunk that would overflow the budget, but keep going —
      // a smaller later page (e.g. the company's own site) can still fit.
      if (total + chunk.length > MAX_TOTAL_CHARS) continue;
      chunks.push(chunk);
      total += chunk.length;
    }
  }
  return chunks.join("\n\n");
}

/** Gather raw source pages for a company across targeted queries. */
async function gatherSources(input: ResearchInput): Promise<{
  groups: { label: string; pages: FirecrawlPage[] }[];
  sources: ResearchSource[];
}> {
  const company = input.company.trim();
  const loc = input.location ? ` ${input.location}` : "";

  // Only the LinkedIn + overview pages are scraped in full (highest signal);
  // competitors + news use snippet-only search (`withoutContent`) so the run
  // stays well inside the serverless wall-clock budget. Their titles and
  // descriptions are enough to name rivals and surface headlines.
  const queries: {
    label: string;
    query: string;
    sources?: ("web" | "news")[];
    tbs?: string;
    limit: number;
    withoutContent?: boolean;
  }[] = [
    { label: "LinkedIn", query: `${company}${loc} company site:linkedin.com/company`, limit: 2 },
    { label: "Overview", query: `${company}${loc} company overview products services`, limit: 3 },
    { label: "Competitors", query: `${company} competitors alternatives vs`, limit: 5, withoutContent: true },
    { label: "News", query: `${company} news`, sources: ["news"], tbs: "qdr:y", limit: 5, withoutContent: true },
  ];

  // Fan every search out in parallel with the direct site scrape so the
  // whole gather phase costs ~one slow request, not the sum of them.
  const siteUrl = input.website ? normaliseUrl(input.website) : null;
  const [results, sitePage] = await Promise.all([
    Promise.all(
      queries.map((q) =>
        firecrawlSearch(q.query, {
          limit: q.limit,
          sources: q.sources,
          tbs: q.tbs,
          withoutContent: q.withoutContent,
        }).then((pages) => ({ q, pages })),
      ),
    ),
    siteUrl ? firecrawlScrape(siteUrl) : Promise.resolve(null),
  ]);

  const sitePages: FirecrawlPage[] = sitePage ? [sitePage] : [];

  // Website first: the prospect's own site is the highest-signal source,
  // so it claims budget before the SERP-derived groups (buildContext caps
  // total length and drops whatever overflows).
  const groups = [
    ...(sitePages.length ? [{ label: "Website", pages: sitePages }] : []),
    ...results.map(({ q, pages }) => ({ label: q.label, pages })),
  ];

  const sources: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const { q, pages } of results) {
    for (const p of pages) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      sources.push({ url: p.url, title: p.title, query: q.query });
    }
  }
  for (const p of sitePages) {
    if (!seen.has(p.url)) {
      seen.add(p.url);
      sources.push({ url: p.url, title: p.title, query: "company website" });
    }
  }

  return { groups, sources };
}

function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A useful report even with no OpenAI key: pull a website + LinkedIn
 * URL out of the gathered sources and surface generic-but-relevant
 * prompts so the rep isn't walking in cold.
 */
function heuristicReport(
  input: ResearchInput,
  sources: ResearchSource[],
): ResearchReport {
  const website =
    normaliseUrl(input.website ?? "") ||
    sources.find((s) => !/linkedin\.com/i.test(s.url))?.url ||
    "";
  const linkedin = sources.find((s) => /linkedin\.com\/company/i.test(s.url))?.url || "";
  const company = input.company.trim();

  return parseResearchReport({
    overview: sources.length
      ? `${company} — briefing assembled from ${sources.length} web source(s). Add an OPENAI_API_KEY to turn these into a full analyst report.`
      : `No web sources were found for ${company}. Check the company name or add a FIRECRAWL_API_KEY to enable web research.`,
    industry: input.industry ?? "",
    website,
    linkedin_url: linkedin,
    talking_points: [
      `Reference something specific from ${company}'s website or recent news to open warm.`,
      `Confirm what ${company} actually does before pitching — don't assume from the name.`,
    ],
    discovery_questions: [
      `What's driving ${company} to look at a solution like ours right now?`,
      "Who else is involved in a decision like this on your side?",
      "What does success look like 6 months after we start working together?",
    ],
    generated_by: "basic",
  });
}

/**
 * Run the full research pipeline for one company.
 * Never throws — on total failure it returns a heuristic report so the
 * caller can always persist *something* and mark the row done.
 */
export async function researchCompany(
  input: ResearchInput,
): Promise<ResearchResult> {
  if (!input.company.trim()) {
    return { report: heuristicReport(input, []), sources: [] };
  }

  let sources: ResearchSource[] = [];
  let context = "";

  if (isFirecrawlConfigured()) {
    try {
      const gathered = await gatherSources(input);
      sources = gathered.sources;
      context = buildContext(gathered.groups);
    } catch (e) {
      console.error("[lead-research] gathering sources failed:", e);
    }
  }

  // No AI, or nothing to summarise → heuristic report over whatever we found.
  if (!isOpenAIConfigured() || !context) {
    return { report: heuristicReport(input, sources), sources };
  }

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt(input, context) },
      ],
      { temperature: 0.3, model: MODEL, timeoutMs: 25000 },
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const report = parseResearchReport({ ...parsed, generated_by: "ai" });
    // If the model found a site/linkedin we couldn't, keep it; otherwise
    // backfill from the sources we scraped.
    if (!report.website) {
      report.website =
        normaliseUrl(input.website ?? "") ||
        sources.find((s) => !/linkedin\.com/i.test(s.url))?.url ||
        "";
    }
    if (!report.linkedin_url) {
      report.linkedin_url =
        sources.find((s) => /linkedin\.com\/company/i.test(s.url))?.url || "";
    }
    return { report, sources };
  } catch (e) {
    console.error("[lead-research] synthesis failed:", e);
    return { report: heuristicReport(input, sources), sources };
  }
}

/** True when research can produce anything beyond the cold-start fallback. */
export function isResearchConfigured(): boolean {
  return isFirecrawlConfigured() || isOpenAIConfigured();
}
