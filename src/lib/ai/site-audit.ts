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
}): ResearchAudit {
  const { url, psi, seo, ssl, ageYears, copyrightYear } = input;
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
      "Performance & accessibility couldn't be measured (PageSpeed didn't respond) — add a PAGESPEED_API_KEY for a full, accurate audit.",
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
