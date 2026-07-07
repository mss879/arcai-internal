/**
 * The shape of a company research briefing stored in
 * `lead_research.report` (jsonb), plus coercion helpers shared by
 * the server-side generator and the client-side report views.
 *
 * Deliberately NOT server-only: client components parse the jsonb
 * column with `parseResearchReport` before rendering.
 */

export type ResearchCompetitor = { name: string; note: string; url: string };
export type ResearchNewsItem = { title: string; summary: string; url: string };
export type ResearchSource = { url: string; title: string; query: string };
export type ResearchSocialLink = { platform: string; url: string };
export type ResearchColor = { name: string; hex: string };

/** A decision-maker / key person at the prospect (for outreach). */
export type ResearchPerson = { name: string; role: string; linkedin_url: string };

/** Ready-to-use contact channels scraped from the site. */
export type ResearchContact = {
  emails: string[];
  phones: string[];
  /** A https://wa.me/… link when found. */
  whatsapp: string;
  address: string;
  hours: string;
};

/** One labelled sub-score of the website scorecard (0-100). */
export type ResearchScore = { label: string; score: number; note: string };

/** The website audit / scorecard — the agency's core pitch fuel. */
export type ResearchAudit = {
  /** Overall 0-100. */
  overall: number;
  scores: ResearchScore[];
  /** Concrete failings, phrased as reasons to hire the agency. */
  issues: string[];
  /** Lighthouse metrics like "Largest paint — 4.2 s". */
  metrics: { label: string; value: string }[];
  /** The exact URL that was measured. */
  measured_url: string;
  /**
   * "full" when Google PageSpeed ran (performance + accessibility measured),
   * "limited" when it couldn't — in which case the overall is capped and must
   * not read as a confident high score. Defaults to "full" for old reports.
   */
  measured: "full" | "limited";
};

/** Google/online reputation summary. */
export type ResearchReputation = {
  /** Star rating 0-5 (0 = unknown). */
  rating: number;
  /** Number of reviews (0 = unknown). */
  reviews: number;
  source: string;
  summary: string;
  positives: string[];
  negatives: string[];
};

/** Domain registration + hosting facts (from RDAP + live headers). */
export type ResearchDomainInfo = {
  domain: string;
  /** ISO date (YYYY-MM-DD) or "". */
  registered: string;
  age_years: number;
  registrar: string;
  hosting: string;
  ssl: boolean;
};

/** The prospect's visual brand system, mostly from Firecrawl's branding scan. */
export type ResearchBrand = {
  colors: ResearchColor[];
  fonts: string[];
  logo: string;
  color_scheme: string;
  spacing: string;
  /** AI's read of the brand's tone/style (agency perspective). */
  style_notes: string;
};

/** The prospect's digital footprint — the raw material for a website pitch. */
export type ResearchWebPresence = {
  /** Notable pages the site has (blog, portfolio, careers, shop…). */
  pages: string[];
  /** Primary calls-to-action seen on the site. */
  ctas: string[];
  /** What's missing / weak vs a modern site (agency angle). */
  gaps: string[];
  /** Free-text note on tech, quality, freshness. */
  notes: string;
};

/** How confident we are the report is about the intended company. */
export type MatchConfidence = "high" | "medium" | "low" | "";

export type ResearchReport = {
  overview: string;
  industry: string;
  headquarters: string;
  company_size: string;
  founded: string;
  website: string;
  linkedin_url: string;
  products_services: string[];
  competitors: ResearchCompetitor[];
  /** Specific ways competitors are outperforming this prospect — pitch fuel. */
  competitor_gaps: string[];
  recent_news: ResearchNewsItem[];
  pain_points: string[];
  talking_points: string[];
  discovery_questions: string[];
  brand: ResearchBrand;
  web_presence: ResearchWebPresence;
  social_links: ResearchSocialLink[];
  /** Decision-makers to reach out to. */
  key_people: ResearchPerson[];
  /** Ready-to-use contact channels. */
  contact: ResearchContact;
  /** Website scorecard/audit — null until the audit step runs. */
  audit: ResearchAudit | null;
  /** Online reputation — null when nothing was found. */
  reputation: ResearchReputation | null;
  /** Domain registration + hosting facts — null when unknown. */
  domain_info: ResearchDomainInfo | null;
  /** How sure we are this is the right company (see MatchConfidence). */
  match_confidence: MatchConfidence;
  /** One line explaining the confidence — how identity was (or wasn't) confirmed. */
  verification: string;
  /** "ai" for OpenAI-written briefings, "basic" for the no-key fallback. */
  generated_by: "ai" | "basic";
  /**
   * Why a report is "basic": "no_key" (no OpenAI key), "no_context" (nothing
   * scraped to analyze), or the raw OpenAI error (present-but-rejected key,
   * wrong model, timeout). Empty for AI reports. Lets the UI show the real
   * cause instead of always saying "add a key".
   */
  basic_reason: string;
};

function confidence(x: unknown): MatchConfidence {
  return x === "high" || x === "medium" || x === "low" ? x : "";
}

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function strArr(x: unknown): string[] {
  return Array.isArray(x) ? x.map((v) => str(v)).filter(Boolean) : [];
}
function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

/** Accept only a real, whitespace-free http(s) URL with a dotted host; else ''. */
function url(x: unknown): string {
  const s = str(x);
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return "";
  try {
    return /\.[a-z]{2,}/i.test(new URL(s).hostname) ? s : "";
  } catch {
    return "";
  }
}

function competitors(x: unknown): ResearchCompetitor[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((c) => ({
      name: str((c as Record<string, unknown>)?.name),
      note: str((c as Record<string, unknown>)?.note),
      url: url((c as Record<string, unknown>)?.url),
    }))
    .filter((c) => c.name);
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** De-duplicated, trimmed, non-empty string list. */
function dedupeStrArr(x: unknown): string[] {
  const seen = new Set<string>();
  return strArr(x).filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function people(x: unknown): ResearchPerson[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((p) => {
      const o = obj(p);
      return {
        name: str(o.name),
        role: str(o.role),
        linkedin_url: url(o.linkedin_url),
      };
    })
    .filter((p) => p.name)
    .slice(0, 8);
}

function contact(x: unknown): ResearchContact {
  const o = obj(x);
  return {
    emails: dedupeStrArr(o.emails).slice(0, 6),
    phones: dedupeStrArr(o.phones).slice(0, 6),
    whatsapp: url(o.whatsapp),
    address: str(o.address),
    hours: str(o.hours),
  };
}

function metricList(x: unknown): { label: string; value: string }[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((m) => {
      const o = obj(m);
      return { label: str(o.label), value: str(o.value) };
    })
    .filter((m) => m.label && m.value)
    .slice(0, 8);
}

function scoreList(x: unknown): ResearchScore[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((s) => {
      const o = obj(s);
      return {
        label: str(o.label),
        score: Math.max(0, Math.min(100, Math.round(num(o.score)))),
        note: str(o.note),
      };
    })
    .filter((s) => s.label)
    .slice(0, 10);
}

function audit(x: unknown): ResearchAudit | null {
  if (!x || typeof x !== "object") return null;
  const o = obj(x);
  const scores = scoreList(o.scores);
  const issues = strArr(o.issues);
  const overall = Math.max(0, Math.min(100, Math.round(num(o.overall))));
  if (!scores.length && !issues.length && !overall) return null;
  return {
    overall,
    scores,
    issues: issues.slice(0, 12),
    metrics: metricList(o.metrics),
    measured_url: url(o.measured_url),
    // Old reports predate this field; treat them as full so nothing regresses.
    measured: o.measured === "limited" ? "limited" : "full",
  };
}

function reputation(x: unknown): ResearchReputation | null {
  if (!x || typeof x !== "object") return null;
  const o = obj(x);
  const rating = Math.max(0, Math.min(5, num(o.rating)));
  const reviews = Math.max(0, Math.round(num(o.reviews)));
  const summary = str(o.summary);
  if (!rating && !reviews && !summary) return null;
  return {
    rating,
    reviews,
    source: str(o.source),
    summary,
    positives: strArr(o.positives).slice(0, 5),
    negatives: strArr(o.negatives).slice(0, 5),
  };
}

function domainInfo(x: unknown): ResearchDomainInfo | null {
  if (!x || typeof x !== "object") return null;
  const o = obj(x);
  const domain = str(o.domain);
  const registered = str(o.registered);
  if (!domain && !registered && !str(o.hosting)) return null;
  return {
    domain,
    registered,
    age_years: Math.max(0, Math.round(num(o.age_years))),
    registrar: str(o.registrar),
    hosting: str(o.hosting),
    ssl: Boolean(o.ssl),
  };
}

function news(x: unknown): ResearchNewsItem[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((n) => ({
      title: str((n as Record<string, unknown>)?.title),
      summary: str((n as Record<string, unknown>)?.summary),
      url: str((n as Record<string, unknown>)?.url),
    }))
    .filter((n) => n.title);
}

/** Accept `#rgb`, `#rrggbb`, or `rgb()/rgba()` — normalise to a display hex-ish string. */
function color(x: unknown): string {
  const s = str(x).toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return s;
  if (/^rgba?\(/.test(s)) return s;
  return "";
}

function colors(x: unknown): ResearchColor[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  return x
    .map((c) => {
      const o = obj(c);
      return { name: str(o.name), hex: color(o.hex) };
    })
    .filter((c) => {
      if (!c.hex || seen.has(c.hex)) return false;
      seen.add(c.hex);
      return true;
    })
    .slice(0, 10);
}

function socials(x: unknown): ResearchSocialLink[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  return x
    .map((s) => {
      const o = obj(s);
      return { platform: str(o.platform), url: str(o.url) };
    })
    .filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
}

function brand(x: unknown): ResearchBrand {
  const b = obj(x);
  return {
    colors: colors(b.colors),
    fonts: strArr(b.fonts).slice(0, 8),
    logo: str(b.logo),
    color_scheme: str(b.color_scheme),
    spacing: str(b.spacing),
    style_notes: str(b.style_notes),
  };
}

function webPresence(x: unknown): ResearchWebPresence {
  const w = obj(x);
  return {
    pages: strArr(w.pages).slice(0, 20),
    ctas: strArr(w.ctas).slice(0, 8),
    gaps: strArr(w.gaps),
    notes: str(w.notes),
  };
}

/** Coerce the jsonb column into a well-formed report (missing keys → empty). */
export function parseResearchReport(x: unknown): ResearchReport {
  const r = obj(x);
  return {
    overview: str(r.overview),
    industry: str(r.industry),
    headquarters: str(r.headquarters),
    company_size: str(r.company_size),
    founded: str(r.founded),
    website: str(r.website),
    linkedin_url: str(r.linkedin_url),
    products_services: strArr(r.products_services),
    competitors: competitors(r.competitors),
    competitor_gaps: strArr(r.competitor_gaps),
    recent_news: news(r.recent_news),
    pain_points: strArr(r.pain_points),
    talking_points: strArr(r.talking_points),
    discovery_questions: strArr(r.discovery_questions),
    brand: brand(r.brand),
    web_presence: webPresence(r.web_presence),
    social_links: socials(r.social_links),
    key_people: people(r.key_people),
    contact: contact(r.contact),
    audit: audit(r.audit),
    reputation: reputation(r.reputation),
    domain_info: domainInfo(r.domain_info),
    match_confidence: confidence(r.match_confidence),
    verification: str(r.verification),
    generated_by: r.generated_by === "basic" ? "basic" : "ai",
    basic_reason: str(r.basic_reason),
  };
}

/** Coerce the jsonb sources column into a clean list. */
export function parseResearchSources(x: unknown): ResearchSource[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((s) => ({
      url: str((s as Record<string, unknown>)?.url),
      title: str((s as Record<string, unknown>)?.title),
      query: str((s as Record<string, unknown>)?.query),
    }))
    .filter((s) => s.url);
}
