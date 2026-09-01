import "server-only";

/**
 * Google PageSpeed Insights (Lighthouse) wrapper for the CRM website audit.
 *
 * Same philosophy as `openai.ts` / `firecrawl.ts`: plain `fetch`, no SDK, and
 * it works with NO key at all (Google allows anonymous PSI calls at a low
 * quota). Set `PAGESPEED_API_KEY` to raise the quota. Never throws — returns
 * null on any failure so the audit degrades to the signals we can compute
 * ourselves rather than sinking the whole research run.
 */

const PSI_URL =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * PSI runs a FULL mobile Lighthouse pass and routinely takes 30-50s on heavy
 * (WordPress/LiteSpeed) prospect sites — the old 20s abort was the real reason
 * the audit kept coming back "limited" even with a valid key.
 *
 * Locally there's no function cap, so give it real room (a slow site is worth
 * the wait for accurate performance/accessibility numbers). In the deployed app
 * the synchronous audit action is bounded by the ~26s function budget, so keep
 * the PSI call under that: a still-slower site degrades to a "limited" audit
 * rather than getting the whole function killed mid-request.
 *
 * Gate on NODE_ENV (reliably "production" in the deployed build), NOT
 * `process.env.NETLIFY`, which is a build-time flag not present in the function
 * runtime.
 */
const TIMEOUT_MS = process.env.NODE_ENV === "production" ? 15000 : 60000;

/** Normalised Lighthouse result. Category scores are 0-100, or -1 = unknown. */
export type PageSpeedResult = {
  performance: number;
  seo: number;
  accessibility: number;
  bestPractices: number;
  /** Human metrics like "Largest paint — 4.2 s". */
  metrics: { label: string; value: string }[];
  /** Concrete Lighthouse failures, phrased as agency talking points. */
  failedAudits: string[];
  /** Lighthouse's final full-page screenshot as a data: URI, when present. */
  screenshot: string | null;
};

/** PSI works keyless; this just says whether we raised the quota. */
export function isPageSpeedConfigured(): boolean {
  return Boolean(process.env.PAGESPEED_API_KEY);
}

/** Named Lighthouse metrics we surface (id → label). */
const METRIC_LABELS: Record<string, string> = {
  "first-contentful-paint": "First paint",
  "largest-contentful-paint": "Largest paint",
  "cumulative-layout-shift": "Layout shift",
  "total-blocking-time": "Blocking time",
  "speed-index": "Speed index",
  interactive: "Time to interactive",
};

/** Lighthouse audits worth surfacing as fix-this pitch points (id → label). */
const AUDIT_LABELS: Record<string, string> = {
  "server-response-time": "Slow server response",
  "render-blocking-resources": "Render-blocking scripts/styles",
  "uses-optimized-images": "Images aren't optimised",
  "uses-responsive-images": "Images aren't sized for the device",
  "modern-image-formats": "Not using modern image formats (WebP/AVIF)",
  "uses-text-compression": "No text compression",
  "unminified-css": "CSS isn't minified",
  "unminified-javascript": "JavaScript isn't minified",
  "unused-css-rules": "Large amount of unused CSS",
  "efficient-animated-content": "Heavy animated media",
  viewport: "No mobile viewport tag",
  "image-alt": "Images missing alt text",
  "document-title": "Missing page title",
  "meta-description": "Missing meta description",
  "is-crawlable": "Blocked from search engines",
  "font-size": "Text too small to read on mobile",
  "tap-targets": "Tap targets too close together",
  "color-contrast": "Low colour contrast",
  "link-text": "Non-descriptive link text",
  "errors-in-console": "Browser console errors",
};

function scoreOf(lh: Record<string, unknown>, key: string): number {
  const categories = (lh.categories ?? {}) as Record<string, { score?: unknown }>;
  const s = categories[key]?.score;
  return typeof s === "number" ? Math.round(s * 100) : -1;
}

/**
 * Run a mobile Lighthouse pass on one URL. Mobile is what matters for a Sri
 * Lankan audience and is Google's own ranking basis. Returns null on failure.
 */
export async function runPageSpeed(
  url: string,
  strategy: "mobile" | "desktop" = "mobile",
): Promise<PageSpeedResult | null> {
  const params = new URLSearchParams({ url, strategy });
  for (const c of ["performance", "seo", "accessibility", "best-practices"]) {
    params.append("category", c);
  }
  const key = process.env.PAGESPEED_API_KEY?.trim();
  if (key) params.set("key", key);

  let res: Response;
  try {
    res = await fetch(`${PSI_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.error(
      `[pagespeed] request errored: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }

  if (!res.ok) {
    console.error(`[pagespeed] failed (${res.status})`);
    return null;
  }

  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const lh = json.lighthouseResult as Record<string, unknown> | undefined;
  if (!lh) return null;
  const audits = (lh.audits ?? {}) as Record<
    string,
    { displayValue?: unknown; score?: unknown; details?: { data?: unknown } }
  >;

  // Lighthouse ships a final full-page screenshot as a base64 data: URI —
  // the showcase builder uses it as the "before" shot.
  const shot = audits["final-screenshot"]?.details?.data;
  const screenshot =
    typeof shot === "string" && shot.startsWith("data:image") ? shot : null;

  const metrics: { label: string; value: string }[] = [];
  for (const [id, label] of Object.entries(METRIC_LABELS)) {
    const dv = audits[id]?.displayValue;
    if (typeof dv === "string" && dv) metrics.push({ label, value: dv });
  }

  const failedAudits: string[] = [];
  for (const [id, label] of Object.entries(AUDIT_LABELS)) {
    const a = audits[id];
    // score < 0.9 = Lighthouse considers it a real issue; null = not applicable.
    if (a && typeof a.score === "number" && a.score < 0.9) {
      failedAudits.push(label);
    }
  }

  return {
    performance: scoreOf(lh, "performance"),
    seo: scoreOf(lh, "seo"),
    accessibility: scoreOf(lh, "accessibility"),
    bestPractices: scoreOf(lh, "best-practices"),
    metrics,
    failedAudits: failedAudits.slice(0, 10),
    screenshot,
  };
}
