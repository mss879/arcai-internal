import "server-only";

import { openaiChatJSON, isOpenAIConfigured, AI_MODELS } from "@/lib/ai/openai";
import {
  firecrawlSearch,
  firecrawlScrape,
  firecrawlMap,
  isFirecrawlConfigured,
  type FirecrawlPage,
  type FirecrawlBranding,
} from "@/lib/ai/firecrawl";
import {
  parseResearchReport,
  type ResearchReport,
  type ResearchSource,
  type ResearchBrand,
  type ResearchSocialLink,
  type MatchConfidence,
} from "@/lib/research-report";

/**
 * Agency-grade prospect research, run as a 3-step pipeline (the orchestration
 * in `research.ts` advances one step per tick so each stays inside the
 * serverless time budget):
 *
 *   1. discover()          — scrape the homepage for its BRAND system
 *                            (colours/fonts/logo via Firecrawl branding) +
 *                            links (socials), map the site's pages, and run
 *                            competitor / news / LinkedIn searches.
 *   2. analyzeCompetitor() — scrape the top competitor's homepage (brand +
 *                            content) for a real side-by-side.
 *   3. synthesize()        — OpenAI writes the dossier: profile, web presence,
 *                            competitor gaps, brand read, and pitch angles.
 *
 * Every external call degrades gracefully (returns []/null, never throws), and
 * the whole thing yields a useful report even with no OpenAI key — the brand,
 * socials and page map are gathered deterministically.
 */

export type ResearchInput = {
  company: string;
  website?: string | null;
  contactName?: string | null;
  industry?: string | null;
  location?: string | null;
};

export type ResearchResult = { report: ResearchReport; sources: ResearchSource[] };

/** Signals used to judge whether the research is about the RIGHT company. */
export type ResearchSignals = {
  websiteProvided: boolean;
  anchorDomain: string;
  siteReached: boolean;
  siteMentionsCompany: boolean;
  nameSeenElsewhere: boolean;
};

/** Intermediate data carried between pipeline steps (stored in `analysis` jsonb). */
export type ResearchAnalysis = {
  brand: ResearchBrand;
  socialLinks: ResearchSocialLink[];
  siteMap: string[];
  homepageContent: string;
  competitorNames: string[];
  competitorUrl: string;
  competitorBrand: ResearchBrand | null;
  competitorContent: string;
  searchContext: string;
  sources: ResearchSource[];
  signals: ResearchSignals;
};

const MODEL = process.env.OPENAI_RESEARCH_MODEL || AI_MODELS.chat;
const MAX_HOMEPAGE_CHARS = 8000;
const MAX_COMPETITOR_CHARS = 4000;
const MAX_SEARCH_CHARS = 8000;

const EMPTY_BRAND: ResearchBrand = {
  colors: [],
  fonts: [],
  logo: "",
  color_scheme: "",
  spacing: "",
  style_notes: "",
};

// ---- small helpers -----------------------------------------------------------

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
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

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

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

function coreName(company: string): string {
  return normaliseName(company)
    .replace(
      /\b(pvt|private|ltd|limited|plc|inc|incorporated|llc|corporation|corp|co|company)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

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

// ---- brand + social + map extraction -----------------------------------------

const SOCIAL_HOSTS: { re: RegExp; platform: string }[] = [
  { re: /facebook\.com/i, platform: "Facebook" },
  { re: /instagram\.com/i, platform: "Instagram" },
  { re: /linkedin\.com/i, platform: "LinkedIn" },
  { re: /(?:twitter\.com|x\.com)/i, platform: "X" },
  { re: /(?:youtube\.com|youtu\.be)/i, platform: "YouTube" },
  { re: /tiktok\.com/i, platform: "TikTok" },
  { re: /pinterest\./i, platform: "Pinterest" },
  { re: /wa\.me|api\.whatsapp/i, platform: "WhatsApp" },
];

function extractSocials(links: string[]): ResearchSocialLink[] {
  const out: ResearchSocialLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (/sharer|\/share|intent\/|\/dialog\//i.test(link)) continue; // skip share buttons
    for (const { re, platform } of SOCIAL_HOSTS) {
      if (re.test(link) && !seen.has(platform)) {
        seen.add(platform);
        out.push({ platform, url: link });
        break;
      }
    }
  }
  return out;
}

/** Turn a Firecrawl branding profile into our normalised brand shape. */
function normaliseBrand(raw: FirecrawlBranding | null): ResearchBrand {
  if (!raw) return EMPTY_BRAND;
  const colorsObj = obj(raw.colors);
  const colors: { name: string; hex: string }[] = [];
  const pushColor = (name: string, val: unknown) => {
    const hex = str(val);
    if (hex) colors.push({ name, hex });
  };
  pushColor("Primary", colorsObj.primary);
  pushColor("Secondary", colorsObj.secondary);
  pushColor("Accent", colorsObj.accent);
  pushColor("Background", colorsObj.background);
  pushColor("Text", colorsObj.textPrimary);
  pushColor("Link", colorsObj.link);

  const fonts = new Set<string>();
  if (Array.isArray(raw.fonts)) {
    for (const f of raw.fonts) {
      const fam = typeof f === "string" ? f : str(obj(f).family);
      if (fam) fonts.add(fam);
    }
  }
  const fam = obj(obj(raw.typography).fontFamilies);
  for (const k of ["primary", "heading", "body", "code"]) {
    const v = str(fam[k]);
    if (v) fonts.add(v);
  }

  const images = obj(raw.images);
  const spacing = obj(raw.spacing);
  // Only accept a string/number baseUnit — never stringify an object.
  const baseUnit =
    typeof spacing.baseUnit === "number"
      ? String(spacing.baseUnit)
      : str(spacing.baseUnit);
  const spacingParts = [
    baseUnit ? `base ${baseUnit}px` : "",
    str(spacing.borderRadius) ? `radius ${str(spacing.borderRadius)}` : "",
  ].filter(Boolean);

  const personality = obj(raw.personality);
  const styleParts = [
    str(personality.tone),
    str(personality.energy),
    str(personality.targetAudience) || str(personality.audience),
  ].filter(Boolean);

  return {
    colors,
    fonts: [...fonts].slice(0, 8),
    logo: str(raw.logo) || str(images.logo),
    color_scheme: str(raw.colorScheme),
    spacing: spacingParts.join(" · "),
    style_notes: styleParts.join(" · "),
  };
}

/** Readable page labels from a site map (title, else the path). */
function extractSiteMap(
  links: { url: string; title: string }[],
  anchorDomain: string,
): string[] {
  const seen = new Set<string>();
  const pages: string[] = [];
  for (const l of links) {
    if (anchorDomain && !domainMatches(domainOf(l.url), anchorDomain)) continue;
    let label = l.title.trim();
    if (!label) {
      try {
        const p = new URL(l.url).pathname.replace(/\/+$/, "");
        label = p && p !== "" ? p : "Home";
      } catch {
        continue;
      }
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(label);
    if (pages.length >= 30) break;
  }
  return pages;
}

function brandToText(label: string, brand: ResearchBrand): string {
  if (!brand.colors.length && !brand.fonts.length && !brand.style_notes) return "";
  const parts = [
    brand.colors.length
      ? `colours: ${brand.colors.map((c) => `${c.name} ${c.hex}`).join(", ")}`
      : "",
    brand.fonts.length ? `fonts: ${brand.fonts.join(", ")}` : "",
    brand.color_scheme ? `scheme: ${brand.color_scheme}` : "",
    brand.style_notes ? `personality: ${brand.style_notes}` : "",
  ].filter(Boolean);
  return parts.length ? `${label} brand — ${parts.join("; ")}` : "";
}

// ---- confidence validation ---------------------------------------------------

const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, "": 0 };
function rankToConf(r: number): MatchConfidence {
  return r >= 3 ? "high" : r === 2 ? "medium" : r >= 1 ? "low" : "";
}

function resolveConfidence(
  modelConfidence: MatchConfidence,
  signals: ResearchSignals,
): { confidence: MatchConfidence; ceilingReason: string } {
  let ceiling: MatchConfidence;
  let ceilingReason: string;
  const domain = signals.anchorDomain || "the given website";

  if (signals.websiteProvided) {
    if (signals.siteMentionsCompany) {
      ceiling = "high";
      ceilingReason = `Confirmed — ${domain}'s own content matches this company.`;
    } else if (signals.siteReached) {
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

  const modelRank = CONF_RANK[modelConfidence] || 2;
  return {
    confidence: rankToConf(Math.min(modelRank, CONF_RANK[ceiling])),
    ceilingReason,
  };
}

// ---- analysis (de)serialisation ----------------------------------------------

function emptyAnalysis(input: ResearchInput): ResearchAnalysis {
  const domain = input.website ? domainOf(normaliseUrl(input.website) ?? "") : "";
  return {
    brand: EMPTY_BRAND,
    socialLinks: [],
    siteMap: [],
    homepageContent: "",
    competitorNames: [],
    competitorUrl: "",
    competitorBrand: null,
    competitorContent: "",
    searchContext: "",
    sources: [],
    signals: {
      websiteProvided: Boolean(domain),
      anchorDomain: domain,
      siteReached: false,
      siteMentionsCompany: false,
      nameSeenElsewhere: false,
    },
  };
}

/** Coerce a stored `analysis` jsonb value back into a typed ResearchAnalysis. */
export function parseAnalysis(x: unknown, input: ResearchInput): ResearchAnalysis {
  const base = emptyAnalysis(input);
  const a = obj(x);
  if (!Object.keys(a).length) return base;
  const sig = obj(a.signals);
  return {
    brand: (a.brand as ResearchBrand) || base.brand,
    socialLinks: Array.isArray(a.socialLinks)
      ? (a.socialLinks as ResearchSocialLink[])
      : [],
    siteMap: Array.isArray(a.siteMap) ? (a.siteMap as string[]) : [],
    homepageContent: str(a.homepageContent),
    competitorNames: Array.isArray(a.competitorNames)
      ? (a.competitorNames as string[])
      : [],
    competitorUrl: str(a.competitorUrl),
    competitorBrand: (a.competitorBrand as ResearchBrand | null) ?? null,
    competitorContent: str(a.competitorContent),
    searchContext: str(a.searchContext),
    sources: Array.isArray(a.sources) ? (a.sources as ResearchSource[]) : [],
    signals: {
      websiteProvided: Boolean(sig.websiteProvided ?? base.signals.websiteProvided),
      anchorDomain: str(sig.anchorDomain) || base.signals.anchorDomain,
      siteReached: Boolean(sig.siteReached),
      siteMentionsCompany: Boolean(sig.siteMentionsCompany),
      nameSeenElsewhere: Boolean(sig.nameSeenElsewhere),
    },
  };
}

// ---- STEP 1: discover --------------------------------------------------------

/** Choose the best competitor URL from search results to deep-dive later. */
function pickCompetitorUrl(pages: FirecrawlPage[], anchorDomain: string): string {
  for (const p of pages) {
    const d = domainOf(p.url);
    if (!d) continue;
    if (anchorDomain && domainMatches(d, anchorDomain)) continue;
    if (/wikipedia|facebook|instagram|linkedin|youtube|twitter|x\.com|crunchbase|glassdoor|indeed|yelp|reddit|medium\.com|\.gov/i.test(d))
      continue;
    return p.url;
  }
  return "";
}

export async function discover(input: ResearchInput): Promise<ResearchAnalysis> {
  const analysis = emptyAnalysis(input);
  const company = input.company.trim();
  const loc = input.location?.trim() || "Sri Lanka";
  const siteUrl = input.website ? normaliseUrl(input.website) : null;
  const anchorDomain = siteUrl ? domainOf(siteUrl) : "";

  const geo = { location: "Colombo, Western, Sri Lanka", country: "lk" as const };

  const [homepage, mapLinks, competitorPages, newsPages, contactPages] =
    await Promise.all([
      siteUrl ? firecrawlScrape(siteUrl, { brand: true }) : Promise.resolve(null),
      siteUrl
        ? firecrawlMap(siteUrl, {
            search: "about services products portfolio work blog case study team contact",
            limit: 80,
          })
        : Promise.resolve([]),
      firecrawlSearch(`${company} ${loc} competitors alternatives`, {
        limit: 6,
        withoutContent: true,
        ...geo,
      }),
      firecrawlSearch(`${company} ${loc} news`, {
        limit: 5,
        sources: ["news"],
        tbs: "qdr:y",
        withoutContent: true,
        ...geo,
      }),
      firecrawlSearch(
        `${company} ${input.contactName ? `${input.contactName} ` : ""}${loc} site:linkedin.com`,
        { limit: 4, withoutContent: true, ...geo },
      ),
    ]);

  // Brand + socials + homepage content from the direct scrape.
  if (homepage) {
    analysis.brand = normaliseBrand(homepage.branding);
    analysis.socialLinks = extractSocials(homepage.links);
    analysis.homepageContent = homepage.markdown.slice(0, MAX_HOMEPAGE_CHARS);
    analysis.signals.siteReached = true;
    analysis.signals.siteMentionsCompany =
      mentionsCompany(homepage.title, company) ||
      mentionsCompany(homepage.markdown, company);
  }

  // Site map → web-presence page list. Also mine it for socials.
  analysis.siteMap = extractSiteMap(mapLinks, anchorDomain);
  if (analysis.socialLinks.length === 0) {
    analysis.socialLinks = extractSocials(mapLinks.map((l) => l.url));
  }

  // Search context + sources + competitor picks.
  const searchChunks: string[] = [];
  const sources: ResearchSource[] = [];
  const seenSource = new Set<string>();
  const addSources = (pages: FirecrawlPage[], label: string, query: string) => {
    for (const p of pages) {
      const line = `- [${label}] ${p.title}${p.description ? ` — ${p.description}` : ""} (${p.url})`;
      searchChunks.push(line);
      if (!seenSource.has(p.url)) {
        seenSource.add(p.url);
        sources.push({ url: p.url, title: p.title, query });
      }
    }
  };
  addSources(competitorPages, "Competitor", `${company} competitors`);
  addSources(newsPages, "News", `${company} news`);
  addSources(contactPages, "LinkedIn", `${company} linkedin`);
  if (homepage) {
    sources.unshift({ url: homepage.url, title: homepage.title, query: "company website" });
  }

  analysis.searchContext = searchChunks.join("\n").slice(0, MAX_SEARCH_CHARS);
  analysis.sources = sources;
  analysis.competitorUrl = pickCompetitorUrl(competitorPages, anchorDomain);
  analysis.competitorNames = competitorPages
    .map((p) => p.title.replace(/\s*[-–|:].*$/, "").trim())
    .filter(Boolean)
    .slice(0, 6);

  analysis.signals.nameSeenElsewhere = [
    ...competitorPages,
    ...newsPages,
    ...contactPages,
  ].some((p) => mentionsCompany(p.title, company) || mentionsCompany(p.description, company));

  return analysis;
}

// ---- STEP 2: analyze the top competitor --------------------------------------

export async function analyzeCompetitor(
  input: ResearchInput,
  analysisRaw: unknown,
): Promise<ResearchAnalysis> {
  const analysis = parseAnalysis(analysisRaw, input);
  if (!analysis.competitorUrl) return analysis;

  const page = await firecrawlScrape(analysis.competitorUrl, { brand: true });
  if (page) {
    analysis.competitorBrand = normaliseBrand(page.branding);
    analysis.competitorContent = page.markdown.slice(0, MAX_COMPETITOR_CHARS);
  }
  return analysis;
}

// ---- STEP 3: synthesize the dossier ------------------------------------------

const SYSTEM = `You are a senior strategist at a web-design & digital agency,
preparing your sales team to pitch a prospect — a company based in Sri Lanka.
You are given real data scraped from the prospect's website (including its brand
system), a map of its pages, its social links, competitor and news search
results, and a scrape of a top competitor. Extract only what the data supports —
never invent facts, numbers, funding, or people.

CRITICAL — verify identity first: only use data that clearly matches the intended
company (its website domain, Sri Lanka location, named contact). If it doesn't,
set match_confidence "low", explain in "verification", and leave factual fields
empty rather than describing a same-named company elsewhere.

Think like an agency: assess their web presence and brand, and pinpoint concrete
ways competitors are outperforming them online — that is the pitch. Return ONLY
one JSON object, no markdown fences.`;

function synthPrompt(input: ResearchInput, analysis: ResearchAnalysis): string {
  const s = analysis.signals;
  const verifyBlock = `Verification signals:
- Website given: ${s.websiteProvided ? `yes (${s.anchorDomain})` : "no"}
- Homepage fetched: ${s.siteReached ? "yes" : "no"}
- Homepage content names the company: ${s.siteMentionsCompany ? "yes" : "no"}
- Company named in other sources: ${s.nameSeenElsewhere ? "yes" : "no"}`;

  const brandBlock = brandToText("Prospect", analysis.brand);
  const compBrandBlock = analysis.competitorBrand
    ? brandToText("Top competitor", analysis.competitorBrand)
    : "";

  return `Intended company: ${input.company} (Sri Lanka)
${s.websiteProvided ? `Website: ${input.website}\n` : ""}${input.industry ? `Industry hint: ${input.industry}\n` : ""}${input.contactName ? `Contact: ${input.contactName}\n` : ""}
${verifyBlock}

Pages on their site (from a site map):
${analysis.siteMap.length ? analysis.siteMap.map((p) => `- ${p}`).join("\n") : "(none found)"}

Social profiles found: ${analysis.socialLinks.length ? analysis.socialLinks.map((l) => l.platform).join(", ") : "(none found)"}

${brandBlock}
${compBrandBlock}

=== HOMEPAGE CONTENT ===
${analysis.homepageContent || "(not available)"}

=== SEARCH RESULTS (competitors / news / linkedin) ===
${analysis.searchContext || "(none)"}

=== TOP COMPETITOR HOMEPAGE (${analysis.competitorUrl || "n/a"}) ===
${analysis.competitorContent || "(not scraped)"}

Return a JSON object with EXACTLY these keys:
{
  "match_confidence": "high | medium | low",
  "verification": "one line: how identity was confirmed, or why not",
  "overview": "2-4 sentences: what they do and who they serve",
  "industry": "primary industry, or ''",
  "headquarters": "city, country if known, else ''",
  "company_size": "employee range if known, else ''",
  "founded": "founding year if known, else ''",
  "products_services": ["their main products/services"],
  "web_presence": {
    "ctas": ["primary calls-to-action on their site"],
    "gaps": ["specific weaknesses / things missing vs a modern site — agency angle"],
    "notes": "1-2 sentences on site quality, tech, freshness"
  },
  "brand_style_notes": "1-2 sentences reading their visual brand's tone/style",
  "competitors": [{ "name": "Competitor", "note": "one line on how they compete" }],
  "competitor_gaps": ["specific ways competitors are OUTPERFORMING this prospect online (site, brand, content, social, SEO) — the pitch"],
  "recent_news": [{ "title": "headline", "summary": "one sentence", "url": "source url or ''" }],
  "pain_points": ["business/marketing challenges we could solve"],
  "talking_points": ["specific opening angles for OUR agency's pitch, tied to their brand/site/competitors"],
  "discovery_questions": ["sharp questions to qualify this prospect"]
}

Guidance:
- If match_confidence is "low", keep factual fields empty and explain in "verification".
- competitor_gaps & talking_points: 3-5 each, concrete and specific to THIS prospect, from a web-agency lens.
- Keep strings tight; don't restate the raw data verbatim.`;
}

/** Build the final report, merging deterministic brand/socials with AI output. */
function assembleReport(
  input: ResearchInput,
  analysis: ResearchAnalysis,
  ai: Record<string, unknown> | null,
): ResearchReport {
  const web = obj(ai?.web_presence);
  const brand: ResearchBrand = {
    ...analysis.brand,
    // Prefer the AI's read of style if the branding scan didn't provide one.
    style_notes: analysis.brand.style_notes || str(ai?.brand_style_notes),
  };

  const modelConfidence: MatchConfidence =
    ai?.match_confidence === "high" || ai?.match_confidence === "medium" || ai?.match_confidence === "low"
      ? (ai.match_confidence as MatchConfidence)
      : "";
  const { confidence, ceilingReason } = resolveConfidence(modelConfidence, analysis.signals);
  const aiVerification = str(ai?.verification);

  const website =
    normaliseUrl(input.website ?? "") ||
    analysis.sources.find((s) => !/linkedin\.com/i.test(s.url))?.url ||
    "";
  const linkedin =
    analysis.socialLinks.find((l) => l.platform === "LinkedIn")?.url ||
    analysis.sources.find((s) => /linkedin\.com\/(company|in)/i.test(s.url))?.url ||
    "";

  return parseResearchReport({
    overview: str(ai?.overview),
    industry: str(ai?.industry) || input.industry || "",
    headquarters: str(ai?.headquarters),
    company_size: str(ai?.company_size),
    founded: str(ai?.founded),
    website,
    linkedin_url: linkedin,
    products_services: ai?.products_services,
    competitors: ai?.competitors,
    competitor_gaps: ai?.competitor_gaps,
    recent_news: ai?.recent_news,
    pain_points: ai?.pain_points,
    talking_points: ai?.talking_points,
    discovery_questions: ai?.discovery_questions,
    brand,
    web_presence: {
      pages: analysis.siteMap,
      ctas: web.ctas,
      gaps: web.gaps,
      notes: str(web.notes),
    },
    social_links: analysis.socialLinks,
    match_confidence: confidence,
    verification: confidence === "low" || !aiVerification ? ceilingReason : aiVerification,
    generated_by: ai ? "ai" : "basic",
  });
}

export async function synthesize(
  input: ResearchInput,
  analysisRaw: unknown,
): Promise<ResearchResult> {
  const analysis = parseAnalysis(analysisRaw, input);

  const hasContext =
    Boolean(analysis.homepageContent) ||
    Boolean(analysis.searchContext) ||
    analysis.siteMap.length > 0;

  if (!isOpenAIConfigured() || !hasContext) {
    return {
      report: assembleReport(input, analysis, null),
      sources: analysis.sources,
    };
  }

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: synthPrompt(input, analysis) },
      ],
      { temperature: 0.3, model: MODEL, timeoutMs: 25000 },
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { report: assembleReport(input, analysis, parsed), sources: analysis.sources };
  } catch (e) {
    console.error("[lead-research] synthesis failed:", e);
    return {
      report: assembleReport(input, analysis, null),
      sources: analysis.sources,
    };
  }
}

/** True when research can produce anything beyond the cold-start fallback. */
export function isResearchConfigured(): boolean {
  return isFirecrawlConfigured() || isOpenAIConfigured();
}
