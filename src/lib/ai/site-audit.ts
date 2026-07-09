import "server-only";

import type { PageSpeedResult } from "@/lib/ai/pagespeed";
import type { ResearchAudit, ResearchScore } from "@/lib/research-report";

/**
 * Turns raw signals (Lighthouse via PageSpeed, on-page HTML, HTTPS/freshness)
 * into the CRM "website scorecard" — an overall 0-100 plus labelled sub-scores
 * and a concrete list of issues that read as reasons to hire the agency.
 *
 * Pure/deterministic and server-only; no network here (the callers gather the
 * inputs). Everything degrades: a missing PageSpeed result just means fewer
 * sub-scores, never a crash.
 */

/** On-page SEO/quality signals lifted from the homepage HTML. */
export type SeoSignals = {
  title: boolean;
  titleText: string;
  metaDescription: boolean;
  h1: boolean;
  viewport: boolean;
  openGraph: boolean;
  schema: boolean;
  canonical: boolean;
  favicon: boolean;
  imgTotal: number;
  imgWithAlt: number;
};

export const EMPTY_SEO: SeoSignals = {
  title: false,
  titleText: "",
  metaDescription: false,
  h1: false,
  viewport: false,
  openGraph: false,
  schema: false,
  canonical: false,
  favicon: false,
  imgTotal: 0,
  imgWithAlt: 0,
};

function has(re: RegExp, html: string): boolean {
  return re.test(html);
}

/** Extract the on-page signals from a homepage's HTML. Never throws. */
export function analyzeSeo(html: string): SeoSignals {
  if (!html || typeof html !== "string") return { ...EMPTY_SEO };
  const head = html.slice(0, 200_000); // head/meta live up top; bound the work

  const titleText = (/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ?? "").trim();

  let imgTotal = 0;
  let imgWithAlt = 0;
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) && imgTotal < 500) {
    imgTotal += 1;
    if (/\balt\s*=\s*["'][^"']+["']/i.test(m[0])) imgWithAlt += 1;
  }

  return {
    title: Boolean(titleText),
    titleText,
    metaDescription: has(
      /<meta[^>]+name=["']description["'][^>]*content=["'][^"']+["']/i,
      head,
    ),
    h1: has(/<h1[\s>]/i, html),
    viewport: has(/<meta[^>]+name=["']viewport["']/i, head),
    openGraph: has(/<meta[^>]+property=["']og:[^"']+["']/i, head),
    schema:
      has(/application\/ld\+json/i, head) ||
      has(/itemtype=["'][^"']*schema\.org/i, html),
    canonical: has(/<link[^>]+rel=["']canonical["']/i, head),
    favicon: has(/<link[^>]+rel=["'][^"']*icon["']/i, head),
    imgTotal,
    imgWithAlt,
  };
}

// ---- structured data (schema.org JSON-LD + OpenGraph) --------------------------

/**
 * Machine-readable facts a site publishes about itself. Highest
 * precision-per-cost data in the whole research pipeline: no extra network
 * call (mined from the homepage HTML we already fetched for the SEO signals)
 * and written by the business itself.
 */
export type StructuredFacts = {
  /** name / legalName / alternateName / og:site_name — deduped. */
  names: string[];
  description: string;
  /** One formatted postal address (street, locality, region, postcode, country). */
  address: string;
  phones: string[];
  emails: string[];
  foundingDate: string;
  founders: string[];
  openingHours: string;
  /** Social/profile URLs from `sameAs`. */
  sameAs: string[];
};

export const EMPTY_FACTS: StructuredFacts = {
  names: [],
  description: "",
  address: "",
  phones: [],
  emails: [],
  foundingDate: "",
  founders: [],
  openingHours: "",
  sameAs: [],
};

/** True when the extraction found anything worth telling the model about. */
export function hasStructuredFacts(f: StructuredFacts): boolean {
  return Boolean(
    f.names.length ||
      f.address ||
      f.phones.length ||
      f.emails.length ||
      f.foundingDate ||
      f.founders.length ||
      f.openingHours ||
      f.sameAs.length,
  );
}

type JsonNode = Record<string, unknown>;

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : x != null ? [x] : [];
}

function nodeStr(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

/** A person-ish node (or plain string) → their name. */
function personName(x: unknown): string {
  if (typeof x === "string") return x.trim();
  if (x && typeof x === "object") return nodeStr((x as JsonNode).name);
  return "";
}

/** A PostalAddress node (or plain string) → one formatted line. */
function formatAddress(x: unknown): string {
  if (typeof x === "string") return x.trim();
  if (!x || typeof x !== "object") return "";
  const a = x as JsonNode;
  return [
    nodeStr(a.streetAddress),
    nodeStr(a.addressLocality),
    nodeStr(a.addressRegion),
    nodeStr(a.postalCode),
    nodeStr(a.addressCountry) ||
      nodeStr((a.addressCountry as JsonNode | undefined)?.name),
  ]
    .filter(Boolean)
    .join(", ");
}

/** @type values that describe the business itself (not articles/breadcrumbs). */
const ORG_TYPE =
  /(Organization|LocalBusiness|Corporation|Company|Store|Restaurant|Hotel|Agency|Dentist|Physician|Attorney|Service)$/i;

function isOrgNode(node: JsonNode): boolean {
  return asArray(node["@type"]).some((t) => typeof t === "string" && ORG_TYPE.test(t));
}

/**
 * Mine schema.org JSON-LD (plus OpenGraph basics) from a homepage's raw HTML.
 * Walks every <script type="application/ld+json"> block — including @graph
 * wrappers and arrays — and folds all Organization/LocalBusiness-ish nodes
 * into one fact sheet. Never throws; malformed JSON blocks are skipped.
 */
export function extractStructuredFacts(html: string): StructuredFacts {
  const facts: StructuredFacts = {
    ...EMPTY_FACTS,
    names: [],
    phones: [],
    emails: [],
    founders: [],
    sameAs: [],
  };
  if (!html || typeof html !== "string") return facts;

  const names = new Set<string>();
  const phones = new Set<string>();
  const emails = new Set<string>();
  const founders = new Set<string>();
  const sameAs = new Set<string>();

  const fold = (node: JsonNode) => {
    for (const key of ["name", "legalName", "alternateName"] as const) {
      const v = nodeStr(node[key]);
      if (v) names.add(v);
    }
    if (!facts.description) facts.description = nodeStr(node.description).slice(0, 300);
    if (!facts.address) {
      for (const a of asArray(node.address)) {
        const line = formatAddress(a);
        if (line) {
          facts.address = line;
          break;
        }
      }
    }
    for (const t of asArray(node.telephone)) {
      const v = nodeStr(t);
      if (v) phones.add(v);
    }
    for (const e of asArray(node.email)) {
      const v = nodeStr(e).replace(/^mailto:/i, "");
      if (v) emails.add(v);
    }
    if (!facts.foundingDate) facts.foundingDate = nodeStr(node.foundingDate);
    for (const f of [...asArray(node.founder), ...asArray(node.founders)]) {
      const v = personName(f);
      if (v) founders.add(v);
    }
    if (!facts.openingHours) {
      facts.openingHours = asArray(node.openingHours)
        .map(nodeStr)
        .filter(Boolean)
        .join("; ")
        .slice(0, 200);
    }
    for (const s of asArray(node.sameAs)) {
      const v = nodeStr(s);
      if (/^https?:\/\//i.test(v)) sameAs.add(v);
    }
  };

  const scriptRe =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let blocks = 0;
  while ((m = scriptRe.exec(html)) && blocks < 12) {
    blocks += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    // A block may be a node, an array of nodes, or a wrapper with @graph.
    const roots = asArray(parsed);
    for (const root of roots) {
      if (!root || typeof root !== "object") continue;
      const nodes = [root as JsonNode, ...asArray((root as JsonNode)["@graph"])];
      for (const n of nodes) {
        if (n && typeof n === "object" && isOrgNode(n as JsonNode)) {
          fold(n as JsonNode);
        }
      }
    }
  }

  // OpenGraph basics as a fallback identity signal (head lives up top).
  const head = html.slice(0, 200_000);
  const ogName =
    /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(
      head,
    )?.[1] ?? "";
  if (ogName.trim()) names.add(ogName.trim());
  if (!facts.description) {
    const ogDesc =
      /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i.exec(
        head,
      )?.[1] ?? "";
    facts.description = ogDesc.trim().slice(0, 300);
  }

  facts.names = [...names].slice(0, 4);
  facts.phones = [...phones].slice(0, 6);
  facts.emails = [...emails].slice(0, 6);
  facts.founders = [...founders].slice(0, 6);
  facts.sameAs = [...sameAs].slice(0, 10);
  return facts;
}

/** Pull the most recent 4-digit copyright year from footer-ish text. */
export function extractCopyrightYear(text: string): number {
  if (!text) return 0;
  let best = 0;
  const re =
    /(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const y = Number(m[1]);
    if (y >= 1990 && y <= 2100 && y > best) best = y;
  }
  return best;
}

// ---- scorecard math ----------------------------------------------------------

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// ---- quick site verdict (prospecting) ------------------------------------------

/**
 * Fast, deterministic 0-100 quality read from ONE homepage scrape — no
 * PageSpeed, so the prospecting agent can grade 40+ sites per scan in
 * seconds without quota. Weighted toward the signals that make a site read
 * as amateur/dated to a visitor (and that a web agency actually fixes):
 * mobile viewport, HTTPS, search essentials, content depth, freshness.
 *
 * Not comparable to `buildAudit`'s Lighthouse-backed overall — this is a
 * triage score. Returns the score plus pitch-ready issue lines.
 */
export function quickSiteVerdict(input: {
  seo: SeoSignals;
  https: boolean;
  copyrightYear: number;
  /** Length of the homepage markdown — a thin-content signal. */
  contentChars: number;
}): { score: number; issues: string[] } {
  const { seo, https, copyrightYear, contentChars } = input;
  const yearGap = copyrightYear
    ? new Date().getFullYear() - copyrightYear
    : -1; // unknown

  let score = 0;
  score += seo.viewport ? 22 : 0;
  score += https ? 14 : 0;
  score += seo.title ? 8 : 0;
  score += seo.metaDescription ? 10 : 0;
  score += seo.h1 ? 6 : 0;
  score += seo.openGraph ? 8 : 0;
  score += seo.schema ? 8 : 0;
  score += seo.canonical ? 4 : 0;
  score += seo.favicon ? 4 : 0;
  score += contentChars >= 1500 ? 8 : contentChars >= 500 ? 4 : 0;
  // Freshness: unknown copyright isn't punished as hard as a stale one.
  score += yearGap < 0 ? 4 : yearGap <= 2 ? 8 : yearGap <= 4 ? 4 : 0;

  const issues: string[] = [];
  if (!seo.viewport)
    issues.push("Not mobile-friendly — the layout doesn't adapt to phones.");
  if (!https)
    issues.push("No HTTPS — browsers mark the site as Not Secure.");
  if (!seo.title) issues.push("Missing page title — invisible in search results.");
  if (!seo.metaDescription)
    issues.push("No meta description — weak, unclickable Google snippets.");
  if (!seo.h1) issues.push("No clear headline (H1) on the homepage.");
  if (!seo.openGraph)
    issues.push("No social preview tags — shared links show nothing.");
  if (!seo.schema)
    issues.push("No structured data — misses Google rich results.");
  if (contentChars < 500)
    issues.push("Very thin homepage content — little for visitors or Google.");
  if (yearGap >= 3)
    issues.push(`Footer still says © ${copyrightYear} — looks unmaintained.`);
  if (seo.imgTotal > 3 && seo.imgWithAlt / seo.imgTotal < 0.5)
    issues.push("Most images lack alt text (SEO + accessibility).");

  return { score: clamp(score), issues };
}

/** Fraction (0-100) of the on-page SEO essentials that are present. */
function onPageSeoScore(seo: SeoSignals): number {
  const checks = [
    seo.title,
    seo.metaDescription,
    seo.h1,
    seo.openGraph,
    seo.canonical,
    seo.schema,
  ];
  return clamp((checks.filter(Boolean).length / checks.length) * 100);
}

function freshnessScore(copyrightYear: number): number {
  if (!copyrightYear) return -1; // unknown → excluded from the overall
  const gap = new Date().getFullYear() - copyrightYear;
  if (gap <= 1) return 100;
  if (gap === 2) return 80;
  if (gap === 3) return 60;
  if (gap === 4) return 40;
  return 20;
}

/**
 * Assemble the scorecard. `psi` may be null (PageSpeed unavailable); in that
 * case the performance/accessibility/best-practice sub-scores are simply
 * omitted and the overall is computed from what we do have.
 */
export function buildAudit(input: {
  url: string;
  psi: PageSpeedResult | null;
  seo: SeoSignals;
  /** Resolved by the caller (RDAP result, else the URL scheme). */
  ssl: boolean;
  /** Domain age in years (0 = unknown). */
  ageYears: number;
  copyrightYear: number;
  /** Whether a PAGESPEED_API_KEY is set — shapes the "limited audit" message
   *  so we don't tell the user to add a key they already have. */
  psiConfigured?: boolean;
}): ResearchAudit {
  const { url, psi, seo, ssl, ageYears, copyrightYear, psiConfigured } = input;
  const scores: ResearchScore[] = [];
  // Each sub-score carries a WEIGHT so the overall reflects real quality:
  // performance/accessibility dominate; HTTPS/freshness are hygiene, not merit.
  // A flat average (the old behaviour) let a site score ~90 on freebies alone
  // (HTTPS + a viewport tag + a current copyright) even when PageSpeed —
  // the actual performance/accessibility measure — never ran.
  const weighted: { score: number; weight: number }[] = [];
  const push = (label: string, score: number, note: string, weight: number) => {
    if (score < 0) return;
    const s = clamp(score);
    scores.push({ label, score: s, note });
    weighted.push({ score: s, weight });
  };

  // PageSpeed drives the meaningful signals; without it the audit is "limited".
  const measured: "full" | "limited" = psi ? "full" : "limited";

  // Performance / accessibility / best practices (mobile Lighthouse) — the core.
  if (psi) {
    push(
      "Performance",
      psi.performance,
      psi.metrics.find((m) => /largest paint/i.test(m.label))?.value
        ? `Largest paint ${psi.metrics.find((m) => /largest paint/i.test(m.label))!.value}`
        : "Mobile load speed",
      3,
    );
    push("Accessibility", psi.accessibility, "Lighthouse accessibility pass", 2);
    push("Best practices", psi.bestPractices, "Security, console, deprecations", 1.5);
  }

  // Mobile friendliness — a viewport tag is table stakes, not a strong pass, so
  // it only earns a modest base; real mobile flags from Lighthouse pull it down.
  const mobileFlags = psi
    ? psi.failedAudits.filter((a) => /mobile|tap|too small|viewport/i.test(a))
        .length
    : 0;
  const mobileBase = seo.viewport ? 72 : 25;
  push(
    "Mobile-friendly",
    Math.max(0, mobileBase - mobileFlags * 20),
    seo.viewport ? "Has a responsive viewport" : "No mobile viewport tag",
    1.5,
  );

  // SEO — blend Lighthouse SEO with our on-page essentials.
  const onPage = onPageSeoScore(seo);
  const seoScore = psi && psi.seo >= 0 ? Math.round((psi.seo + onPage) / 2) : onPage;
  const missingSeo = [
    !seo.metaDescription && "meta description",
    !seo.openGraph && "social preview tags",
    !seo.schema && "structured data",
  ].filter(Boolean);
  push(
    "SEO",
    seoScore,
    missingSeo.length ? `Missing ${missingSeo.join(", ")}` : "Search essentials present",
    1.5,
  );

  // Security (HTTPS) — hygiene: near-universal now, so low weight.
  push(
    "Security",
    ssl ? 100 : 15,
    ssl ? "Served over HTTPS" : "No HTTPS — browsers flag it as insecure",
    0.5,
  );

  // Freshness (copyright year) — hygiene, low weight.
  const fresh = freshnessScore(copyrightYear);
  push(
    "Freshness",
    fresh,
    copyrightYear ? `Footer copyright ${copyrightYear}` : "",
    0.5,
  );

  const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);
  let overall = totalWeight
    ? clamp(weighted.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight)
    : 0;
  // Without PageSpeed we've only measured hygiene, never performance or
  // accessibility — so the score cannot honestly read as "solid". Cap it.
  if (measured === "limited") overall = Math.min(overall, 69);

  // Concrete issues = pitch fuel.
  const issues: string[] = [];
  if (measured === "limited")
    issues.push(
      psiConfigured
        ? "Performance & accessibility couldn't be measured — PageSpeed didn't finish in time on this (heavy) site. The rest of the scorecard is accurate; re-run to try the speed test again."
        : "Performance & accessibility couldn't be measured — add a PAGESPEED_API_KEY for a full, accurate audit.",
    );
  if (!ssl)
    issues.push("No HTTPS — the site isn't secure and browsers warn visitors.");
  if (!seo.viewport)
    issues.push("No mobile viewport — the layout won't adapt to phones.");
  if (!seo.title) issues.push("Missing or empty page <title>.");
  if (!seo.metaDescription)
    issues.push("No meta description — weaker, less clickable search snippets.");
  if (!seo.openGraph)
    issues.push("No Open Graph tags — shared links show no preview image.");
  if (!seo.schema)
    issues.push("No structured data (schema.org) — misses rich search results.");
  if (seo.imgTotal > 0) {
    const missing = seo.imgTotal - seo.imgWithAlt;
    if (missing / seo.imgTotal >= 0.3)
      issues.push(
        `${missing} of ${seo.imgTotal} images have no alt text (SEO + accessibility).`,
      );
  }
  if (copyrightYear && new Date().getFullYear() - copyrightYear >= 3)
    issues.push(
      `Footer still says © ${copyrightYear} — the site looks unmaintained.`,
    );
  if (psi && psi.performance >= 0 && psi.performance < 50)
    issues.push("Slow on mobile — pages take too long to load.");
  if (ageYears >= 8)
    issues.push(
      `Domain is ${ageYears} years old — likely an ageing site due for a refresh.`,
    );
  if (psi) issues.push(...psi.failedAudits);

  // Dedupe + cap.
  const seen = new Set<string>();
  const deduped = issues.filter((i) => {
    const k = i.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    overall,
    scores,
    issues: deduped.slice(0, 12),
    metrics: psi?.metrics ?? [],
    measured_url: url,
    measured,
  };
}
