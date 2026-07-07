import "server-only";

import { openaiChatJSON, isOpenAIConfigured } from "@/lib/ai/openai";
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
  type ResearchAudit,
  type ResearchDomainInfo,
} from "@/lib/research-report";
import { runPageSpeed } from "@/lib/ai/pagespeed";
import { lookupDomainInfo } from "@/lib/ai/domain-info";
import {
  analyzeSeo,
  extractCopyrightYear,
  buildAudit,
  EMPTY_SEO,
  type SeoSignals,
} from "@/lib/ai/site-audit";

/**
 * Agency-grade prospect research. The CORE pipeline focuses on the company,
 * its services/products, and its competitors:
 *
 *   1. discover()          — scrape the homepage (links → socials, HTML → SEO
 *                            signals, markdown → content), map the site's pages,
 *                            and run competitor / news / LinkedIn / reviews
 *                            searches. (Branding is NOT fetched here.)
 *   2. analyzeCompetitor() — scrape the top competitor's homepage + the
 *                            prospect's own services/products/about/contact
 *                            pages for a full offering read.
 *   3. synthesize()        — OpenAI writes the dossier: profile, web presence,
 *                            competitor gaps, key people, contact, reputation,
 *                            and pitch angles.
 *
 * Branding and the website audit are DELIBERATELY out of the core pass — they're
 * fetched on demand via `researchBranding()` / `researchSiteAudit()` (wired to
 * "Grab branding" / "Run website audit" buttons in the report UI), so the first
 * pass is fast and about the company rather than its design system.
 *
 * Every external call degrades gracefully (returns []/null, never throws), and
 * the whole thing yields a useful report even with no OpenAI key — the socials,
 * page map, and contact are gathered deterministically.
 */

export type ResearchInput = {
  company: string;
  website?: string | null;
  contactName?: string | null;
  industry?: string | null;
  location?: string | null;
};

export type ResearchResult = { report: ResearchReport; sources: ResearchSource[] };

/** A real competitor site found via search, before same-field verification. */
export type ResearchCompetitorCandidate = {
  name: string;
  url: string;
  domain: string;
  description: string;
};

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
  competitorCandidates: ResearchCompetitorCandidate[];
  competitorUrl: string;
  competitorBrand: ResearchBrand | null;
  competitorContent: string;
  /** A comparison/listicle page that names rivals — deep-read in step 2. */
  competitorListUrl: string;
  competitorListContent: string;
  /** Key internal pages (services/products/about) to deep-read in step 2. */
  keyPageUrls: string[];
  /** Concatenated markdown of those key pages — the raw material for a full
   *  services + product-category list and a richer web-presence read. */
  keyPagesContent: string;
  searchContext: string;
  sources: ResearchSource[];
  signals: ResearchSignals;
  // ---- audit / contact / reputation enrichment ----
  /** On-page SEO signals parsed from the homepage HTML (in `discover`). */
  seoSignals: SeoSignals;
  /** Most recent footer copyright year (freshness signal). */
  copyrightYear: number;
  /** Deterministically-scraped contact channels (regex, not the model). */
  contactRaw: { emails: string[]; phones: string[]; whatsapp: string };
  /** Snippets from a "<company> reviews" search — the model reads reputation. */
  reputationText: string;
  /** Website scorecard — computed in the `audit` step. */
  audit: ResearchAudit | null;
  /** Domain registration + hosting facts — computed in the `audit` step. */
  domainInfo: ResearchDomainInfo | null;
};

// Research is the app's most demanding OpenAI job — it reads a whole site and
// writes a structured dossier — so it defaults to a GPT-5-family reasoning model
// (quality over speed). gpt-5.4-mini balances cost/latency/quality. Override the
// model/effort/timeout via env without touching code.
const MODEL = process.env.OPENAI_RESEARCH_MODEL || "gpt-5.4-mini";
const REASONING_EFFORT = process.env.OPENAI_RESEARCH_REASONING_EFFORT || "high";
// Reasoning models think for a while; give them room. In production this runs
// inside a Netlify Background Function (15-min budget), so the long timeout is
// safe; local dev has no cap either. (The inline/serverless path degrades to a
// basic report if a run is cut short rather than retrying forever.)
const SYNTH_TIMEOUT_MS = Number(process.env.OPENAI_RESEARCH_TIMEOUT_MS) || 600000;
const MAX_HOMEPAGE_CHARS = 8000;
const MAX_COMPETITOR_CHARS = 4000;
const MAX_COMPARE_CHARS = 3500;
const MAX_SEARCH_CHARS = 8000;
/** Combined budget for the scraped key internal pages (services/products/about). */
const MAX_KEY_PAGES_CHARS = 7000;
/** How many internal pages we deep-read for the offering + presence detail. */
const MAX_KEY_PAGES = 4;
/** How many verified competitors we aim to present. */
const TARGET_COMPETITORS = 5;

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

/** Sitemap XML, feeds, and static assets — plumbing, not real pages. */
const SITE_MAP_JUNK = /\.(xml|json|txt|rss|atom|css|js|map|png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|woff2?|ttf)$/i;

/** Readable page labels from a site map (title, else the path). */
function extractSiteMap(
  links: { url: string; title: string }[],
  anchorDomain: string,
): string[] {
  const seen = new Set<string>();
  const pages: string[] = [];
  for (const l of links) {
    if (anchorDomain && !domainMatches(domainOf(l.url), anchorDomain)) continue;

    let path = "";
    try {
      path = new URL(l.url).pathname.replace(/\/+$/, "");
    } catch {
      continue;
    }
    // Drop sitemap files, feeds, and assets — they aren't browsable pages.
    if (SITE_MAP_JUNK.test(path) || /sitemap/i.test(path)) continue;

    const label = l.title.trim() || (path || "Home");
    // Collapse paginated/duplicated detail pages (…-6, …-5, …/2) onto one
    // entry so a portfolio of 20 near-identical items doesn't flood the list.
    const key = (path || "home")
      .toLowerCase()
      .replace(/[-/]\d+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(label);
    if (pages.length >= 24) break;
  }
  return pages;
}

/** Page paths/labels worth deep-reading for the full offering + business detail. */
const KEY_PAGE_PRIMARY =
  /(service|product|solution|what-we-do|expertise|capabilit|portfolio|our-work|catalog|catalogue|offering|brand|range)/i;
/** Contact pages carry emails/phones/address/hours + often the team. */
const KEY_PAGE_CONTACT =
  /(contact|reach-us|reach us|get-in-touch|get in touch|connect|enquir|inquir)/i;
const KEY_PAGE_SECONDARY =
  /(about|company|who-we-are|overview|profile|team|leadership|management)/i;

/**
 * Pick the internal pages most likely to describe what the company sells —
 * services/products first, then about/company — from the site map AND the
 * homepage's own nav links (so it still works when the map comes back empty).
 * Returns absolute same-domain URLs, homepage and assets excluded.
 */
function pickKeyPageUrls(
  mapLinks: { url: string; title: string }[],
  homepageLinks: string[],
  anchorDomain: string,
  homepageUrl: string,
): string[] {
  const home = homepageUrl.split("#")[0].replace(/\/+$/, "");
  const seen = new Set<string>();
  const candidates: { url: string; label: string }[] = [
    ...mapLinks.map((l) => ({ url: l.url, label: `${l.title} ${l.url}` })),
    ...homepageLinks.map((u) => ({ url: u, label: u })),
  ];

  const collect = (re: RegExp, out: string[]) => {
    for (const c of candidates) {
      if (out.length >= MAX_KEY_PAGES) break;
      const norm = (c.url || "").split("#")[0].split("?")[0].replace(/\/+$/, "");
      if (!norm || norm === home || seen.has(norm)) continue;
      const host = domainOf(norm);
      if (anchorDomain && !domainMatches(host, anchorDomain)) continue;
      let path = "";
      try {
        path = new URL(norm).pathname;
      } catch {
        continue;
      }
      if (path === "/" || path === "") continue;
      if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|css|js)$/i.test(path))
        continue;
      if (!re.test(c.label) && !re.test(path)) continue;
      seen.add(norm);
      out.push(norm);
    }
  };

  const urls: string[] = [];
  collect(KEY_PAGE_PRIMARY, urls); // offering pages first
  collect(KEY_PAGE_CONTACT, urls); // then a contact page (emails/phone/address)
  collect(KEY_PAGE_SECONDARY, urls); // then about/team/company
  return urls;
}

// ---- contact extraction (deterministic) --------------------------------------

/** Emails from scraped text — skips image filenames and asset-looking matches. */
function extractEmails(text: string): string[] {
  const out = new Set<string>();
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.size < 20) {
    const e = m[0].toLowerCase();
    if (!/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(e) && !/@\d+x\./.test(e))
      out.add(e);
  }
  return [...out];
}

/**
 * Phone numbers — conservative to avoid capturing order IDs / SKUs / tracking
 * numbers that merely start with 0. Boundaries (no adjacent digit) plus fixed
 * shapes: a Sri Lankan 0-number is EXACTLY 10 digits (0 + area/network + 7);
 * an international number starts with a literal +.
 */
function extractPhones(text: string): string[] {
  const out = new Set<string>();
  const re =
    /(?<![\d+])0\d{1,2}[\s-]?\d{3}[\s-]?\d{4}(?![\d])|(?<![\d])\+\d{1,3}[\s-]?\d{1,3}[\s-]?\d{3}[\s-]?\d{3,4}(?![\d])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.size < 20) {
    const raw = m[0].replace(/\s+/g, " ").trim();
    const digits = raw.replace(/\D/g, "");
    // SL local = 10 digits; international (+cc) = 10-15 with country code.
    if (raw.startsWith("+") ? digits.length >= 10 && digits.length <= 15 : digits.length === 10)
      out.add(raw);
  }
  return [...out];
}

/** The first WhatsApp click-to-chat link among scraped links. */
function extractWhatsapp(links: string[]): string {
  for (const l of links) {
    if (/wa\.me\/|api\.whatsapp\.com|chat\.whatsapp\.com/i.test(l)) return l;
  }
  return "";
}

/** Digit-only key that collapses spacing/punctuation + a leading country code. */
function phoneKey(p: string): string {
  let d = p.replace(/\D/g, "");
  if (d.startsWith("0094")) d = `0${d.slice(4)}`;
  else if (d.startsWith("94") && d.length >= 11) d = `0${d.slice(2)}`;
  return d;
}

/**
 * Merge freshly-scraped contact signals into the accumulating set. Phones are
 * deduped by their DIGITS (so "+94 11 234 5678" and "+94-11-234-5678" and a
 * tel: href collapse to one), and `tel:` links are mined as a high-precision
 * source. Kept at a generous cap so a later contact page isn't crowded out by
 * the homepage; the report parser trims to the display limit.
 */
function mergeContactRaw(
  into: { emails: string[]; phones: string[]; whatsapp: string },
  text: string,
  links: string[],
): void {
  const emails = new Map<string, string>();
  for (const e of [...into.emails, ...extractEmails(text)]) {
    if (!emails.has(e.toLowerCase())) emails.set(e.toLowerCase(), e);
  }

  const telLinks = links
    .filter((l) => /^tel:/i.test(l))
    .map((l) => l.replace(/^tel:/i, "").trim())
    .filter((p) => p.replace(/\D/g, "").length >= 9);
  const phones = new Map<string, string>();
  for (const p of [...into.phones, ...extractPhones(text), ...telLinks]) {
    const k = phoneKey(p);
    if (k.length >= 9 && !phones.has(k)) phones.set(k, p);
  }

  into.emails = [...emails.values()].slice(0, 10);
  into.phones = [...phones.values()].slice(0, 10);
  into.whatsapp = into.whatsapp || extractWhatsapp(links);
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
    competitorCandidates: [],
    competitorUrl: "",
    competitorBrand: null,
    competitorContent: "",
    competitorListUrl: "",
    competitorListContent: "",
    keyPageUrls: [],
    keyPagesContent: "",
    searchContext: "",
    sources: [],
    signals: {
      websiteProvided: Boolean(domain),
      anchorDomain: domain,
      siteReached: false,
      siteMentionsCompany: false,
      nameSeenElsewhere: false,
    },
    seoSignals: { ...EMPTY_SEO },
    copyrightYear: 0,
    contactRaw: { emails: [], phones: [], whatsapp: "" },
    reputationText: "",
    audit: null,
    domainInfo: null,
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
    competitorCandidates: Array.isArray(a.competitorCandidates)
      ? (a.competitorCandidates as ResearchCompetitorCandidate[])
      : [],
    competitorUrl: str(a.competitorUrl),
    competitorBrand: (a.competitorBrand as ResearchBrand | null) ?? null,
    competitorContent: str(a.competitorContent),
    competitorListUrl: str(a.competitorListUrl),
    competitorListContent: str(a.competitorListContent),
    keyPageUrls: Array.isArray(a.keyPageUrls) ? (a.keyPageUrls as string[]) : [],
    keyPagesContent: str(a.keyPagesContent),
    searchContext: str(a.searchContext),
    sources: Array.isArray(a.sources) ? (a.sources as ResearchSource[]) : [],
    signals: {
      websiteProvided: Boolean(sig.websiteProvided ?? base.signals.websiteProvided),
      anchorDomain: str(sig.anchorDomain) || base.signals.anchorDomain,
      siteReached: Boolean(sig.siteReached),
      siteMentionsCompany: Boolean(sig.siteMentionsCompany),
      nameSeenElsewhere: Boolean(sig.nameSeenElsewhere),
    },
    seoSignals: { ...EMPTY_SEO, ...(a.seoSignals as Partial<SeoSignals>) },
    copyrightYear: typeof a.copyrightYear === "number" ? a.copyrightYear : 0,
    contactRaw: {
      emails: Array.isArray(obj(a.contactRaw).emails)
        ? (obj(a.contactRaw).emails as string[])
        : [],
      phones: Array.isArray(obj(a.contactRaw).phones)
        ? (obj(a.contactRaw).phones as string[])
        : [],
      whatsapp: str(obj(a.contactRaw).whatsapp),
    },
    reputationText: str(a.reputationText),
    audit: (a.audit as ResearchAudit | null) ?? null,
    domainInfo: (a.domainInfo as ResearchDomainInfo | null) ?? null,
  };
}

// ---- competitor discovery helpers --------------------------------------------

/** Domains that are never a competitor's own site — directories, socials, aggregators. */
const JUNK_COMPETITOR_DOMAIN =
  /(?:wikipedia|facebook|instagram|linkedin|youtube|youtu\.be|twitter|x\.com|crunchbase|glassdoor|indeed|yelp|reddit|medium\.com|quora|pinterest|tiktok|clutch\.co|goodfirms|sortlist|designrush|g2\.com|capterra|getapp|trustpilot|yellowpages|yell\.com|tripadvisor|github|gitlab|amazon\.|ebay\.|blogspot|wordpress\.com|wixsite|weebly|google\.|bing\.|duckduckgo|\.gov)/i;

function isJunkCompetitorDomain(domain: string): boolean {
  return JUNK_COMPETITOR_DOMAIN.test(domain);
}

/** A rough brand name from a domain: strip TLD, split tokens, title-case. */
function brandNameFromDomain(domain: string): string {
  const sld = domain.replace(/^www\./, "").split(".")[0] || "";
  return sld
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A company title without the tagline after a dash/pipe/colon. Returns "" for a
 * URL-shaped title (a titleless search hit whose title is the raw URL) so the
 * caller falls back to a name derived from the domain — never "https".
 */
function cleanCompanyTitle(title: string): string {
  const t = title.trim();
  if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) return "";
  return t.replace(/\s*[-–—|:·].*$/, "").trim();
}

/**
 * True when two names clearly denote the same company (self-match guard).
 * Uses a prefix test, not a substring one, so a distinct rival whose name
 * merely CONTAINS the prospect's (e.g. "Creative Design Studio" vs a prospect
 * "Design Studio") is NOT wrongly dropped — only "Design Studio Lanka" is.
 */
function sameCompany(a: string, b: string): boolean {
  const x = coreName(a).replace(/\s+/g, "");
  const y = coreName(b).replace(/\s+/g, "");
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.startsWith(short);
}

/** Titles/descriptions that read like a list of rivals, not a single company. */
const COMPARISON_HINT =
  /\b(vs\.?|versus|alternativ|competitor|top\s+\d|best\s+\d|best\s+\w+\s+(companies|agencies|firms)|leading|companies in|agencies in)\b/i;

// ---- STEP 1: discover --------------------------------------------------------

/**
 * Turn competitor/compare search hits into a de-duplicated list of REAL
 * competitor sites: skips the prospect's own domain and name, directories,
 * socials and aggregators, and dedupes by domain.
 */
function extractCompetitorCandidates(
  pages: FirecrawlPage[],
  anchorDomain: string,
  company: string,
): ResearchCompetitorCandidate[] {
  const out: ResearchCompetitorCandidate[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const domain = domainOf(p.url);
    if (!domain) continue;
    if (anchorDomain && domainMatches(domain, anchorDomain)) continue;
    if (isJunkCompetitorDomain(domain)) continue;
    if (seen.has(domain)) continue;
    const name = cleanCompanyTitle(p.title) || brandNameFromDomain(domain);
    if (!name) continue;
    // Drop the prospect itself showing up under its own name or domain.
    if (
      sameCompany(name, company) ||
      sameCompany(brandNameFromDomain(domain), company)
    )
      continue;
    seen.add(domain);
    out.push({ name, url: p.url, domain, description: p.description });
    if (out.length >= 8) break;
  }
  return out;
}

/** Pick a page that LISTS competitors (a "top/vs/alternatives" article) to deep-read. */
function pickComparisonUrl(pages: FirecrawlPage[], anchorDomain: string): string {
  for (const p of pages) {
    const d = domainOf(p.url);
    if (!d || (anchorDomain && domainMatches(d, anchorDomain))) continue;
    if (COMPARISON_HINT.test(p.title) || COMPARISON_HINT.test(p.description))
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

  // Two complementary competitor angles, run in parallel: a company-anchored
  // "competitors/alternatives" query, and a field/peer query (uses the lead's
  // industry when we have it) that surfaces same-sector companies by their own
  // sites rather than only listicles about this one prospect.
  const peerQuery = input.industry
    ? `top ${input.industry} companies in ${loc}`
    : `companies like ${company} ${loc}`;

  const [
    homepage,
    mapLinks,
    competitorPages,
    peerPages,
    newsPages,
    contactPages,
    reviewPages,
  ] = await Promise.all([
    // Homepage: links (socials) + HTML (content + SEO signals). Branding is
    // fetched separately on demand, so it's intentionally not requested here.
    siteUrl
      ? firecrawlScrape(siteUrl, { html: true })
      : Promise.resolve(null),
    siteUrl
      ? firecrawlMap(siteUrl, {
          search: "about services products portfolio work blog case study team contact",
          limit: 80,
        })
      : Promise.resolve([]),
    firecrawlSearch(`${company} ${loc} competitors alternatives vs`, {
      limit: 8,
      withoutContent: true,
      ...geo,
    }),
    firecrawlSearch(peerQuery, {
      limit: 8,
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
    // Reputation: reviews/ratings snippets for the model to summarise.
    firecrawlSearch(`${company} ${loc} reviews rating`, {
      limit: 5,
      withoutContent: true,
      ...geo,
    }),
  ]);

  // Pool both competitor angles for candidate extraction + the source list.
  const competitorHits = [...competitorPages, ...peerPages];

  // Socials + homepage content from the direct scrape. (Brand is on-demand.)
  if (homepage) {
    analysis.socialLinks = extractSocials(homepage.links);
    analysis.homepageContent = homepage.markdown.slice(0, MAX_HOMEPAGE_CHARS);
    analysis.signals.siteReached = true;
    analysis.signals.siteMentionsCompany =
      mentionsCompany(homepage.title, company) ||
      mentionsCompany(homepage.markdown, company);
    // Audit inputs gathered while we hold the HTML (the HTML is NOT persisted).
    // Use the raw HTML (has <head> + footer) for SEO + copyright; fall back to
    // markdown for copyright if the HTML format was unavailable.
    analysis.seoSignals = analyzeSeo(homepage.html);
    analysis.copyrightYear = extractCopyrightYear(
      homepage.html || homepage.markdown,
    );
    mergeContactRaw(
      analysis.contactRaw,
      `${homepage.markdown}\n${homepage.html}`,
      homepage.links,
    );
  }

  // Reputation snippets (rating/review sentiment for the model to summarise).
  analysis.reputationText = reviewPages
    .map((p) => `- ${p.title}${p.description ? ` — ${p.description}` : ""}`)
    .join("\n")
    .slice(0, 2500);

  // Site map → web-presence page list. Fold in the homepage's own nav links so
  // a company whose map comes back thin still shows a real page list. Also mine
  // it for socials, and pick the key pages to deep-read for the full offering.
  const homepageLinks = homepage?.links ?? [];
  const allSiteLinks = [
    ...mapLinks,
    ...homepageLinks.map((u) => ({ url: u, title: "", description: "" })),
  ];
  analysis.siteMap = extractSiteMap(allSiteLinks, anchorDomain);
  if (analysis.socialLinks.length === 0) {
    analysis.socialLinks = extractSocials(mapLinks.map((l) => l.url));
  }
  analysis.keyPageUrls = pickKeyPageUrls(
    mapLinks,
    homepageLinks,
    anchorDomain,
    homepage?.url ?? siteUrl ?? "",
  );

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
  addSources(competitorHits, "Competitor", `${company} competitors`);
  addSources(newsPages, "News", `${company} news`);
  addSources(contactPages, "LinkedIn", `${company} linkedin`);
  addSources(reviewPages, "Reviews", `${company} reviews`);
  if (homepage) {
    sources.unshift({ url: homepage.url, title: homepage.title, query: "company website" });
  }

  analysis.searchContext = searchChunks.join("\n").slice(0, MAX_SEARCH_CHARS);
  analysis.sources = sources;

  // Real competitor sites (prospect + junk excluded, deduped by domain), and a
  // comparison article that names rivals to deep-read for more in step 2.
  analysis.competitorCandidates = extractCompetitorCandidates(
    competitorHits,
    anchorDomain,
    company,
  );
  analysis.competitorUrl = analysis.competitorCandidates[0]?.url ?? "";
  analysis.competitorListUrl = pickComparisonUrl(competitorHits, anchorDomain);

  analysis.signals.nameSeenElsewhere = [
    ...competitorHits,
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
  const keyUrls = analysis.keyPageUrls.slice(0, MAX_KEY_PAGES);
  if (!analysis.competitorUrl && !analysis.competitorListUrl && !keyUrls.length)
    return analysis;

  // All in parallel: read the top real competitor's homepage for a side-by-side,
  // read a "top/vs/alternatives" article that names more rivals to verify, and
  // deep-read the prospect's own services/products/about pages for a full,
  // accurate offering + web-presence read (not just the homepage teaser).
  // (No brand scrape — branding is an on-demand step now, so this stays fast.)
  const [page, listPage, ...keyPages] = await Promise.all([
    analysis.competitorUrl
      ? firecrawlScrape(analysis.competitorUrl)
      : Promise.resolve(null),
    analysis.competitorListUrl
      ? firecrawlScrape(analysis.competitorListUrl)
      : Promise.resolve(null),
    ...keyUrls.map((u) => firecrawlScrape(u)),
  ]);

  if (page) {
    analysis.competitorContent = page.markdown.slice(0, MAX_COMPETITOR_CHARS);
  }
  if (listPage) {
    analysis.competitorListContent = listPage.markdown.slice(0, MAX_COMPARE_CHARS);
  }
  const ownPages = keyPages.filter((p): p is FirecrawlPage =>
    Boolean(p?.markdown),
  );
  analysis.keyPagesContent = ownPages
    .map((p) => `## ${p.title || p.url}\n${p.markdown}`)
    .join("\n\n")
    .slice(0, MAX_KEY_PAGES_CHARS);
  // Mine the contact/about pages for more emails/phones/WhatsApp.
  for (const p of ownPages) {
    mergeContactRaw(analysis.contactRaw, p.markdown, p.links);
  }

  return analysis;
}

// ---- STEP 3: synthesize the dossier ------------------------------------------

const SYSTEM = `You are a senior strategist at a web-design & digital agency,
preparing your sales team to pitch a prospect — a company based in Sri Lanka.
You are given real data scraped from the prospect's website (including its brand
system), a map of its pages, its social links, competitor and news search
results, a list of candidate competitor SITES, and a scrape of a top competitor.
Extract only what the data supports — never invent facts, numbers, funding, or
people.

CRITICAL — verify identity first: only use data that clearly matches the intended
company (its website domain, Sri Lanka location, named contact). If it doesn't,
set match_confidence "low", explain in "verification", and leave factual fields
empty rather than describing a same-named company elsewhere.

COMPETITORS — accuracy over quantity. A valid competitor is a DIFFERENT, real
company that operates in the SAME field as the prospect (same core products/
services) and, ideally, the same region (Sri Lanka). For each competitor you
return, set "same_field" true only when the evidence (its site, the candidate
list, or the comparison article) shows it is a genuine peer. NEVER list the
prospect itself, directories/marketplaces (Clutch, GoodFirms, Yelp…), news sites,
or a same-named business in a different industry. Prefer the candidate sites and
names found in the comparison article; you may add a well-known Sri Lankan peer
in the same field only if you are highly confident it is real. Aim for ${TARGET_COMPETITORS}
genuine same-field competitors — return fewer rather than padding with weak or
unrelated names.

PEOPLE & CONTACT — from the About/Contact pages and the LinkedIn results, extract
real decision-makers (founder, owner, CEO, marketing/brand head) with their role
and LinkedIn URL when present, plus the business's contact address and opening
hours. Never invent a name or title — only what the data shows.

REPUTATION — if the review search shows a star rating and/or review count, report
them and summarise the recurring positive and negative themes. If there's no
review data, leave reputation empty (do not guess a rating).

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

  const candidateBlock = analysis.competitorCandidates.length
    ? analysis.competitorCandidates
        .map(
          (c) =>
            `- ${c.name} — ${c.domain}${c.description ? ` — ${c.description}` : ""}`,
        )
        .join("\n")
    : "(none found — use the comparison article / your own knowledge, same field only)";

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

=== KEY INTERNAL PAGES — services / products / about (their own words) ===
${analysis.keyPagesContent || "(not scraped)"}

=== SEARCH RESULTS (competitors / news / linkedin) ===
${analysis.searchContext || "(none)"}

=== CANDIDATE COMPETITOR SITES (real domains from search — verify same field) ===
${candidateBlock}

=== COMPETITOR COMPARISON ARTICLE (${analysis.competitorListUrl || "n/a"}) ===
${analysis.competitorListContent || "(not scraped)"}

=== TOP COMPETITOR HOMEPAGE (${analysis.competitorUrl || "n/a"}) ===
${analysis.competitorContent || "(not scraped)"}

=== CONTACT SIGNALS scraped from the site (deterministic) ===
Emails: ${analysis.contactRaw.emails.join(", ") || "(none)"}
Phones: ${analysis.contactRaw.phones.join(", ") || "(none)"}
WhatsApp: ${analysis.contactRaw.whatsapp || "(none)"}

=== REVIEW / REPUTATION SEARCH RESULTS ===
${analysis.reputationText || "(none)"}

${
  analysis.audit
    ? `=== WEBSITE AUDIT (already measured — reference in talking points) ===
Overall ${analysis.audit.overall}/100. ${analysis.audit.scores.map((sc) => `${sc.label} ${sc.score}`).join(", ")}
Issues: ${analysis.audit.issues.slice(0, 8).join("; ") || "none"}`
    : ""
}

Return a JSON object with EXACTLY these keys:
{
  "match_confidence": "high | medium | low",
  "verification": "one line: how identity was confirmed, or why not",
  "overview": "2-4 sentences: what they do and who they serve",
  "industry": "primary industry, or ''",
  "headquarters": "city, country if known, else ''",
  "company_size": "employee range if known, else ''",
  "founded": "founding year if known, else ''",
  "products_services": ["EVERY distinct service they offer AND each product CATEGORY — comprehensive, not a summary"],
  "web_presence": {
    "ctas": ["primary calls-to-action on their site"],
    "gaps": ["specific weaknesses / things missing vs a modern site — agency angle"],
    "notes": "3-5 sentences: what the site covers (sections/pages), the depth of their offering, site quality/tech/freshness, and how complete their online presence is"
  },
  "brand_style_notes": "1-2 sentences reading their visual brand's tone/style",
  "competitors": [{ "name": "Competitor", "domain": "their website domain or ''", "same_field": true, "note": "one line on how they compete in the SAME field" }],
  "competitor_gaps": ["specific ways competitors are OUTPERFORMING this prospect online (site, brand, content, social, SEO) — the pitch"],
  "recent_news": [{ "title": "headline", "summary": "one sentence", "url": "source url or ''" }],
  "key_people": [{ "name": "Full Name", "role": "their title", "linkedin_url": "their LinkedIn URL or ''" }],
  "contact": { "address": "physical address or ''", "hours": "opening hours or ''" },
  "reputation": { "rating": 0, "reviews": 0, "source": "Google | Facebook | '' ", "summary": "one line on sentiment or ''", "positives": ["recurring praise"], "negatives": ["recurring complaints"] },
  "pain_points": ["business/marketing challenges we could solve"],
  "talking_points": ["specific opening angles for OUR agency's pitch, tied to their brand/site/competitors"],
  "discovery_questions": ["sharp questions to qualify this prospect"]
}

Guidance:
- If match_confidence is "low", keep factual fields empty and explain in "verification".
- products_services: be EXHAUSTIVE — mine the homepage AND the key internal pages and list every service and every product category the company offers (use categories, not individual SKUs/product names). Aim for 6-15 short items (2-6 words each) when the site supports it; never collapse them into one summary line.
- web_presence.notes: give a genuinely useful read of the business's online footprint, grounded in the pages you were given.
- competitors: return up to ${TARGET_COMPETITORS} DISTINCT same-field companies, each with same_field true and its domain when known. Drop anything that isn't a genuine peer.
- competitor_gaps & talking_points: 3-5 each, concrete and specific to THIS prospect, from a web-agency lens.
- key_people: only real, named individuals with a role; [] if none are evidenced. Never guess.
- reputation: fill rating/reviews ONLY if the review results show them; else all-empty.
- talking_points: where useful, tie one or two to the website AUDIT findings above.
- Keep strings tight; don't restate the raw data verbatim.`;
}

/** Looks like a real hostname: label(s) + a 2+ letter TLD, no spaces. */
function isValidHost(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && /\.[a-z]{2,}$/i.test(host);
}

/**
 * A bare domain → a clean https URL (drops scheme, www, path). Returns "" unless
 * what remains is a real hostname, so a model that answers `domain: "N/A"` /
 * "unknown" / a company name never yields a `https://N%20A`-style broken link.
 */
function domainToUrl(domain: string): string {
  const d = str(domain)
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/?#].*$/, "")
    .trim()
    .toLowerCase();
  return isValidHost(d) ? `https://${d}` : "";
}

/**
 * The model marked a competitor as NOT same-field. Handles booleans AND the
 * string/number forms LLMs emit under json_object mode (`"false"`, `"no"`, 0);
 * a missing/omitted flag is NOT treated as a negative.
 */
function saysNotSameField(v: unknown): boolean {
  if (v === false || v === 0 || v === null) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "false" || s === "no" || s === "n" || s === "0";
  }
  return false;
}

/**
 * The final competitor list: the model's SAME-FIELD picks first (each linked to
 * its site), backfilled with real candidate sites to reach the target. Never the
 * prospect itself, deduped by name AND site; suppressed on a low-confidence match.
 */
function buildCompetitors(
  input: ResearchInput,
  analysis: ResearchAnalysis,
  ai: Record<string, unknown> | null,
  confidence: MatchConfidence,
): { name: string; note: string; url: string }[] {
  // Don't assert competitors when we're not even sure this is the right company.
  if (confidence === "low") return [];

  const byDomain = new Map(
    analysis.competitorCandidates.map((c) => [c.domain, c] as const),
  );
  const byName = new Map(
    analysis.competitorCandidates.map((c) => [coreName(c.name), c] as const),
  );
  const resolveUrl = (name: string, domain: string): string => {
    const host = domainOf(domainToUrl(domain));
    if (host && byDomain.has(host)) return byDomain.get(host)!.url;
    const cand = byName.get(coreName(name));
    if (cand) return cand.url;
    return domainToUrl(domain);
  };

  const out: { name: string; note: string; url: string }[] = [];
  const seenKey = new Set<string>();
  const seenHost = new Set<string>();
  const push = (name: string, note: string, url: string) => {
    const clean = str(name);
    if (!clean || sameCompany(clean, input.company)) return; // never the prospect
    const key = coreName(clean) || clean.toLowerCase();
    if (seenKey.has(key)) return;
    // Same firm under a short brand vs a fuller title (e.g. "Arcade" and
    // "Arcade Digital Studio"), or two entries that resolve to one site.
    if (out.some((c) => sameCompany(c.name, clean))) return;
    const host = domainOf(url);
    if (host && seenHost.has(host)) return;
    seenKey.add(key);
    if (host) seenHost.add(host);
    out.push({ name: clean, note: str(note), url });
  };

  // The model's verified same-field competitors first. Only an explicit
  // negative (false / "false" / "no" / 0) fails the check — a missing flag is
  // kept, since these were drawn from field-scoped search candidates anyway.
  const aiComps = Array.isArray(ai?.competitors)
    ? (ai!.competitors as unknown[])
    : [];
  for (const c of aiComps) {
    const o = obj(c);
    if (saysNotSameField(o.same_field)) continue;
    const name = str(o.name);
    push(name, str(o.note), resolveUrl(name, str(o.domain)));
    if (out.length >= TARGET_COMPETITORS) break;
  }

  // Backfill from real, filtered candidate sites so we still reach the target.
  for (const c of analysis.competitorCandidates) {
    if (out.length >= TARGET_COMPETITORS) break;
    push(c.name, c.description, c.url);
  }

  return out;
}

/** Build the final report, merging deterministic brand/socials with AI output. */
function assembleReport(
  input: ResearchInput,
  analysis: ResearchAnalysis,
  ai: Record<string, unknown> | null,
  basicReason?: string,
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

  // Contact merges deterministic scrapes (emails/phones/WhatsApp) with the
  // model's read of address + hours. Audit/domain are about the provided site,
  // so they stand regardless of identity confidence; people + reputation are
  // identity-bound, so they're withheld on a low-confidence match.
  const trusted = confidence !== "low";
  const aiContact = obj(ai?.contact);
  const contact = {
    emails: analysis.contactRaw.emails,
    phones: analysis.contactRaw.phones,
    whatsapp: analysis.contactRaw.whatsapp,
    address: trusted ? str(aiContact.address) : "",
    hours: trusted ? str(aiContact.hours) : "",
  };

  return parseResearchReport({
    overview: str(ai?.overview),
    industry: str(ai?.industry) || input.industry || "",
    headquarters: str(ai?.headquarters),
    company_size: str(ai?.company_size),
    founded: str(ai?.founded),
    website,
    linkedin_url: linkedin,
    products_services: ai?.products_services,
    competitors: buildCompetitors(input, analysis, ai, confidence),
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
    key_people: trusted ? ai?.key_people : [],
    contact,
    audit: analysis.audit,
    reputation: trusted ? ai?.reputation : null,
    domain_info: analysis.domainInfo,
    match_confidence: confidence,
    verification: confidence === "low" || !aiVerification ? ceilingReason : aiVerification,
    generated_by: ai ? "ai" : "basic",
    basic_reason: ai ? "" : basicReason || "",
  });
}

/**
 * Build the OpenAI messages for synthesis. Pure + fast (no network), so the
 * background worker can store these strings on the row and make the (slow)
 * OpenAI call itself. Returns null when there's nothing to analyze — the caller
 * should then produce a "no_context" basic report.
 */
export function buildSynthMessages(
  input: ResearchInput,
  analysisRaw: unknown,
): { system: string; user: string } | null {
  const analysis = parseAnalysis(analysisRaw, input);
  const hasContext =
    Boolean(analysis.homepageContent) ||
    Boolean(analysis.searchContext) ||
    analysis.siteMap.length > 0;
  if (!hasContext) return null;
  return { system: SYSTEM, user: synthPrompt(input, analysis) };
}

/**
 * Turn the model's raw JSON (or a failure reason) into the final report. Used
 * by the tick once the background worker has stored the model output, and by
 * the inline `synthesize()` path. `aiRaw` parses → full report; `aiError` →
 * basic report carrying the real reason; neither → basic ("no_context"/"no_key").
 */
export function finalizeSynthesis(
  input: ResearchInput,
  analysisRaw: unknown,
  aiRaw: string | null,
  aiError?: string | null,
): ResearchResult {
  const analysis = parseAnalysis(analysisRaw, input);
  if (aiRaw) {
    try {
      const parsed = JSON.parse(aiRaw) as Record<string, unknown>;
      return {
        report: assembleReport(input, analysis, parsed),
        sources: analysis.sources,
      };
    } catch (e) {
      const reason = (e instanceof Error ? e.message : "Bad AI response.").slice(0, 300);
      return {
        report: assembleReport(input, analysis, null, reason),
        sources: analysis.sources,
      };
    }
  }
  const reason = aiError
    ? aiError.slice(0, 300)
    : isOpenAIConfigured()
      ? "no_context"
      : "no_key";
  return {
    report: assembleReport(input, analysis, null, reason),
    sources: analysis.sources,
  };
}

export async function synthesize(
  input: ResearchInput,
  analysisRaw: unknown,
): Promise<ResearchResult> {
  const analysis = parseAnalysis(analysisRaw, input);
  if (!isOpenAIConfigured()) {
    return {
      report: assembleReport(input, analysis, null, "no_key"),
      sources: analysis.sources,
    };
  }
  const messages = buildSynthMessages(input, analysis);
  if (!messages) return finalizeSynthesis(input, analysis, null);

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
      {
        temperature: 0.3,
        model: MODEL,
        reasoningEffort: REASONING_EFFORT,
        timeoutMs: SYNTH_TIMEOUT_MS,
      },
    );
    return finalizeSynthesis(input, analysis, raw);
  } catch (e) {
    console.error("[lead-research] synthesis failed:", e);
    // Keep the real reason so the UI can stop falsely blaming a missing key
    // (a present-but-rejected key, wrong model, or timeout looks different).
    const reason = (e instanceof Error ? e.message : "OpenAI request failed.").slice(0, 300);
    return finalizeSynthesis(input, analysis, null, reason);
  }
}

// ---- On-demand enrichment (branding + website audit buttons) -----------------

/**
 * On-demand branding: scrape the homepage's brand system (colours/fonts/logo/
 * spacing/personality via Firecrawl's branding pass). Returns null when the
 * site is unreachable or shows no discernible branding.
 */
export async function researchBranding(
  siteUrl: string,
): Promise<ResearchBrand | null> {
  const url = normaliseUrl(siteUrl);
  if (!url || !isFirecrawlConfigured()) return null;
  const page = await firecrawlScrape(url, { brand: true });
  if (!page) return null;
  const brand = normaliseBrand(page.branding);
  const hasBrand =
    brand.colors.length > 0 ||
    brand.fonts.length > 0 ||
    Boolean(brand.logo) ||
    Boolean(brand.style_notes);
  return hasBrand ? brand : null;
}

/**
 * On-demand website audit: a fresh mobile-Lighthouse (PageSpeed) + on-page SEO
 * (from the homepage HTML) + domain (RDAP) pass → the scorecard + domain facts.
 * Returns null when there's no site to measure.
 */
export async function researchSiteAudit(
  siteUrl: string,
): Promise<{ audit: ResearchAudit; domain_info: ResearchDomainInfo | null } | null> {
  const url = normaliseUrl(siteUrl);
  if (!url) return null;
  const [homepage, psi, domain] = await Promise.all([
    firecrawlScrape(url, { html: true }),
    runPageSpeed(url),
    lookupDomainInfo(url),
  ]);
  const seo = homepage ? analyzeSeo(homepage.html) : { ...EMPTY_SEO };
  const copyrightYear = homepage
    ? extractCopyrightYear(homepage.html || homepage.markdown)
    : 0;
  const ssl = domain?.ssl ?? url.startsWith("https://");
  const audit = buildAudit({
    url,
    psi,
    seo,
    ssl,
    ageYears: domain?.ageYears ?? 0,
    copyrightYear,
  });
  const domain_info: ResearchDomainInfo | null = domain
    ? {
        domain: domain.domain,
        registered: domain.registered,
        age_years: domain.ageYears,
        registrar: domain.registrar,
        hosting: domain.hosting,
        ssl: domain.ssl,
      }
    : null;
  return { audit, domain_info };
}

/** True when research can produce anything beyond the cold-start fallback. */
export function isResearchConfigured(): boolean {
  return isFirecrawlConfigured() || isOpenAIConfigured();
}
