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
  type MatchConfidence,
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
call with a prospect — a company based in Sri Lanka. You are given raw
web/LinkedIn/news excerpts. Extract only what the excerpts support — never
invent facts, numbers, funding, or people. When a field is unknown, return an
empty string or empty array.

CRITICAL — verify identity first: the excerpts may describe a DIFFERENT company
that shares the name. Only use excerpts that clearly match the intended company
by its website domain, its Sri Lanka location, and (if given) the named contact.
If the excerpts do not convincingly describe that specific company, set
match_confidence to "low", explain why in "verification", and leave the factual
fields empty rather than reporting another company's details.

Return ONLY one JSON object, no markdown fences.`;

function userPrompt(
  input: ResearchInput,
  context: string,
  signals: ResearchSignals,
): string {
  const domain = signals.anchorDomain;
  const verifyBlock = `Verification signals (from our own checks):
- Website given: ${signals.websiteProvided ? `yes (${domain})` : "no"}
- Pages fetched from that domain: ${signals.siteReached ? "yes" : "no"}
- That domain's own content names the company: ${signals.siteMentionsCompany ? "yes" : "no"}
- Company name appears in other sources (LinkedIn/news): ${signals.nameSeenElsewhere ? "yes" : "no"}`;

  return `Intended company: ${input.company} (Sri Lanka)
${signals.websiteProvided ? `Official website (ground truth): ${input.website}\n` : ""}${
    input.industry ? `Industry hint: ${input.industry}\n` : ""
  }${input.location ? `Location: ${input.location}\n` : ""}${
    input.contactName ? `Our contact there: ${input.contactName}\n` : ""
  }
${verifyBlock}

Only report facts about the company at ${
    domain ? `the domain ${domain}` : `"${input.company}" in Sri Lanka`
  }. Ignore excerpts about same-named companies elsewhere.

=== SOURCE EXCERPTS ===
${context}
=== END SOURCES ===

Return a JSON object with EXACTLY these keys:
{
  "match_confidence": "high | medium | low — how sure you are these excerpts are the intended Sri Lankan company",
  "verification": "one line: how you confirmed identity (domain/contact/location match), or why you couldn't",
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
- If match_confidence is "low", keep overview/products/etc. empty and only explain the mismatch in "verification".
- competitors: 3-6 real competitors, preferably Sri Lankan / regional, inferred from the industry and offering.
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

/** Signals used to judge whether the research is about the RIGHT company. */
type ResearchSignals = {
  websiteProvided: boolean;
  anchorDomain: string;
  /** At least one page on the anchor domain was fetched (scrape or site: search). */
  siteReached: boolean;
  /** The anchor domain's OWN content actually names the company — the strong signal. */
  siteMentionsCompany: boolean;
  /** Some source off the anchor domain (LinkedIn/news/overview) names the company. */
  nameSeenElsewhere: boolean;
};

/** Gather raw source pages for a company across targeted, geo-biased queries. */
async function gatherSources(input: ResearchInput): Promise<{
  groups: { label: string; pages: FirecrawlPage[] }[];
  sources: ResearchSource[];
  signals: ResearchSignals;
}> {
  const company = input.company.trim();
  const contact = input.contactName?.trim();
  const loc = input.location?.trim() || "Sri Lanka";
  const siteUrl = input.website ? normaliseUrl(input.website) : null;
  const anchorDomain = siteUrl ? domainOf(siteUrl) : "";

  // Only the highest-signal pages are scraped in full (LinkedIn, the company's
  // own site, an overview); competitors + news + the person lookup use
  // snippet-only search so the run stays inside the serverless time budget.
  const queries: {
    label: string;
    query: string;
    sources?: ("web" | "news")[];
    tbs?: string;
    limit: number;
    withoutContent?: boolean;
  }[] = [
    {
      label: "LinkedIn",
      query: `${company} ${contact ? `${contact} ` : ""}${loc} site:linkedin.com`,
      limit: 3,
    },
    // With a known domain, pull the company's OWN pages (site:) instead of a
    // generic overview that can drift to a same-named company elsewhere.
    anchorDomain
      ? { label: "Site", query: `site:${anchorDomain}`, limit: 3 }
      : {
          label: "Overview",
          query: `${company} ${loc} company overview products services`,
          limit: 3,
        },
    { label: "Competitors", query: `${company} ${loc} competitors alternatives`, limit: 5, withoutContent: true },
    { label: "News", query: `${company} ${loc} news`, sources: ["news"], tbs: "qdr:y", limit: 5, withoutContent: true },
  ];
  // A person lookup helps the model confirm the contact really works there.
  if (contact) {
    queries.push({
      label: "Contact",
      query: `"${contact}" ${company} ${loc}`,
      limit: 3,
      withoutContent: true,
    });
  }

  // Fan every search out in parallel with the direct site scrape so the whole
  // gather phase costs ~one slow request, not the sum of them. All searches
  // are geo-biased to Sri Lanka to disambiguate common company names.
  const [results, sitePage] = await Promise.all([
    Promise.all(
      queries.map((q) =>
        firecrawlSearch(q.query, {
          limit: q.limit,
          sources: q.sources,
          tbs: q.tbs,
          withoutContent: q.withoutContent,
          location: "Colombo, Western, Sri Lanka",
          country: "lk",
        }).then((pages) => ({ q, pages })),
      ),
    ),
    siteUrl ? firecrawlScrape(siteUrl) : Promise.resolve(null),
  ]);

  const sitePages: FirecrawlPage[] = sitePage ? [sitePage] : [];

  // Website/site pages first: the prospect's own site is the highest-signal
  // source, so it claims budget before the SERP-derived groups (buildContext
  // caps total length and drops whatever overflows).
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

  // Deterministic identity signals — content-based, not mere reachability.
  const allPages = groups.flatMap((g) => g.pages);
  const named = (p: FirecrawlPage) =>
    mentionsCompany(p.title, company) || mentionsCompany(p.markdown, company);
  const onAnchor = (p: FirecrawlPage) =>
    Boolean(anchorDomain) && domainMatches(domainOf(p.url), anchorDomain);

  const anchorPages = allPages.filter(onAnchor);

  return {
    groups,
    sources,
    signals: {
      websiteProvided: Boolean(siteUrl),
      anchorDomain,
      siteReached: anchorPages.length > 0,
      siteMentionsCompany: anchorPages.some(named),
      nameSeenElsewhere: allPages.filter((p) => !onAnchor(p)).some(named),
    },
  };
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

/** Bare registrable-ish host of a URL, lowercased, `www.` stripped. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** True when `host` is the anchor domain or a subdomain of it (jobs.acme.lk ~ acme.lk). */
function domainMatches(host: string, anchor: string): boolean {
  if (!host || !anchor) return false;
  return host === anchor || host.endsWith(`.${anchor}`);
}

function normaliseName(company: string): string {
  return company
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The distinctive core of a company name — legal-form suffixes/punctuation stripped. */
function coreName(company: string): string {
  return normaliseName(company)
    .replace(
      /\b(pvt|private|ltd|limited|plc|inc|incorporated|llc|corporation|corp|co|company)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Word-boundary check that a blob of text is actually about this company.
 * Uses the distinctive core name, falling back to the full name when the core
 * is only legal-form tokens, and refuses cores too short to match reliably
 * (e.g. "ifs") so a common substring can't false-positive the identity signal.
 */
function mentionsCompany(text: string, company: string): boolean {
  if (!text) return false;
  let needle = coreName(company);
  if (needle.replace(/\s+/g, "").length < 4) needle = normaliseName(company);
  if (needle.replace(/\s+/g, "").length < 4) return false;
  const escaped = needle
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, "": 0 };
function rankToConf(r: number): MatchConfidence {
  return r >= 3 ? "high" : r === 2 ? "medium" : r >= 1 ? "low" : "";
}

/**
 * Clamp the model's self-reported confidence with what we could actually
 * verify. A model that claims "high" for a company whose given website we
 * never reached — and whose name never appears in any source — is capped
 * down so the rep sees an honest "couldn't confirm this is the right company".
 */
function resolveConfidence(
  modelConfidence: MatchConfidence,
  signals: ResearchSignals,
): { confidence: MatchConfidence; ceilingReason: string } {
  let ceiling: MatchConfidence;
  let ceilingReason: string;
  const domain = signals.anchorDomain || "the given website";

  if (signals.websiteProvided) {
    if (signals.siteMentionsCompany) {
      // The strongest signal: the given domain's OWN content names the company.
      ceiling = "high";
      ceilingReason = `Confirmed — ${domain}'s own content matches this company.`;
    } else if (signals.siteReached) {
      // Reachable, but the content didn't clearly name the company: don't trust it.
      ceiling = "medium";
      ceilingReason = `Reached ${domain}, but its content didn't clearly confirm this company — double-check the website is right.`;
    } else {
      ceiling = "low";
      ceilingReason = `Couldn't reach ${domain} — this may be a different company. Verify the URL.`;
    }
  } else if (signals.nameSeenElsewhere) {
    ceiling = "medium";
    ceilingReason =
      "No website given; matched by name only. Add the company website to confirm.";
  } else {
    ceiling = "low";
    ceilingReason =
      "No website given and the name didn't clearly appear in results — likely the wrong company. Add the company website.";
  }

  const modelRank = CONF_RANK[modelConfidence] || 2; // default medium if unset
  const finalRank = Math.min(modelRank, CONF_RANK[ceiling]);
  return { confidence: rankToConf(finalRank), ceilingReason };
}

/**
 * A useful report even with no OpenAI key: pull a website + LinkedIn
 * URL out of the gathered sources and surface generic-but-relevant
 * prompts so the rep isn't walking in cold.
 */
function heuristicReport(
  input: ResearchInput,
  sources: ResearchSource[],
  signals: ResearchSignals,
): ResearchReport {
  const website =
    normaliseUrl(input.website ?? "") ||
    sources.find((s) => !/linkedin\.com/i.test(s.url))?.url ||
    "";
  const linkedin = sources.find((s) => /linkedin\.com\/company/i.test(s.url))?.url || "";
  const company = input.company.trim();
  const { confidence, ceilingReason } = resolveConfidence("medium", signals);

  return parseResearchReport({
    match_confidence: confidence,
    verification: ceilingReason,
    overview: sources.length
      ? `${company} — briefing assembled from ${sources.length} web source(s). Add an OPENAI_API_KEY to turn these into a full analyst report.`
      : `No web sources were found for ${company}. Check the company name/website or add a FIRECRAWL_API_KEY to enable web research.`,
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
    const emptySignals: ResearchSignals = {
      websiteProvided: false,
      anchorDomain: "",
      siteReached: false,
      siteMentionsCompany: false,
      nameSeenElsewhere: false,
    };
    return { report: heuristicReport(input, [], emptySignals), sources: [] };
  }

  let sources: ResearchSource[] = [];
  let context = "";
  let signals: ResearchSignals = {
    websiteProvided: Boolean(input.website),
    anchorDomain: input.website ? domainOf(normaliseUrl(input.website) ?? "") : "",
    siteReached: false,
    siteMentionsCompany: false,
    nameSeenElsewhere: false,
  };

  if (isFirecrawlConfigured()) {
    try {
      const gathered = await gatherSources(input);
      sources = gathered.sources;
      context = buildContext(gathered.groups);
      signals = gathered.signals;
    } catch (e) {
      console.error("[lead-research] gathering sources failed:", e);
    }
  }

  // No AI, or nothing to summarise → heuristic report over whatever we found.
  if (!isOpenAIConfigured() || !context) {
    return { report: heuristicReport(input, sources, signals), sources };
  }

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPrompt(input, context, signals) },
      ],
      { temperature: 0.3, model: MODEL, timeoutMs: 25000 },
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const report = parseResearchReport({ ...parsed, generated_by: "ai" });

    // Clamp the model's confidence with what we could actually verify, and
    // fall back to our own explanation when the model didn't give one.
    const { confidence, ceilingReason } = resolveConfidence(
      report.match_confidence,
      signals,
    );
    report.match_confidence = confidence;
    // A "low" verdict is ours to explain (the mismatch reason); otherwise keep
    // the model's note, falling back to our reason if it gave none.
    if (confidence === "low" || !report.verification) {
      report.verification = ceilingReason;
    }

    // If the model found a site/linkedin we couldn't, keep it; otherwise
    // backfill from the given website / scraped sources.
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
    return { report: heuristicReport(input, sources, signals), sources };
  }
}

/** True when research can produce anything beyond the cold-start fallback. */
export function isResearchConfigured(): boolean {
  return isFirecrawlConfigured() || isOpenAIConfigured();
}
