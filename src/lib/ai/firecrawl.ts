import "server-only";

/**
 * Thin wrapper around the Firecrawl v2 REST API used by CRM lead
 * research. Same philosophy as `openai.ts`: plain `fetch`, no SDK,
 * works the moment a `FIRECRAWL_API_KEY` lands in the env, and the
 * key never reaches the browser.
 *
 * We use four endpoints:
 *   - /search — Google-quality results, optionally scraped to markdown
 *     (LinkedIn/Google block direct bots; search does not).
 *   - /scrape — one known URL to markdown + links + (optionally) a full
 *     `branding` profile (colours, fonts, spacing, logo).
 *   - /map    — every URL on a site, fast, to read its web presence.
 */

const BASE_URL =
  process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev/v2";

/**
 * Server-side scrape budget Firecrawl applies per page (ms). Kept short so
 * one slow page can't blow a research step past the serverless time limit.
 */
const SCRAPE_TIMEOUT_MS = 8000;
/** Hard client-side abort so a hung connection can never stall a run. */
const FETCH_TIMEOUT_MS = 13000;
/**
 * Branding extraction runs an LLM over the page on Firecrawl's side, and the
 * prospect homepages we scan are typically slow small-business sites (heavy
 * WordPress/Wix on shared hosting, far from Firecrawl's servers) — real ones
 * take 15-20s to load and process. The old 15s page budget made Firecrawl 408
 * on any such site (that's the "Couldn't read the site's branding" error), so
 * give the page load real room. Kept under Netlify's ~26s synchronous-function
 * cap (the CRM pages raise `maxDuration` to match) so the action still returns
 * a clean error rather than being killed by the platform.
 */
const BRAND_SCRAPE_TIMEOUT_MS = 20000; // Firecrawl page-load budget for a brand pass
const BRAND_FETCH_TIMEOUT_MS = 24000; // client abort — > load + LLM extraction, < platform cap

/** True when a Firecrawl key is configured. */
export function isFirecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set.");
  return key;
}

/** Firecrawl's raw brand/design-system profile — normalised by the engine. */
export type FirecrawlBranding = Record<string, unknown>;

/** One search hit / scraped page, normalised for the research engine. */
export type FirecrawlPage = {
  url: string;
  title: string;
  description: string;
  markdown: string;
  /** Every link found on the page (used to detect socials + key pages). */
  links: string[];
  /** Full brand profile when the scrape requested `branding`, else null. */
  branding: FirecrawlBranding | null;
  /** Raw page HTML (incl. <head>) when the scrape requested `html` — for SEO
   *  signal parsing. Uses Firecrawl's `rawHtml` so <head>/<meta> survive. */
  html: string;
};

/** One entry from a site map. */
export type FirecrawlLink = { url: string; title: string; description: string };

type RawResult = {
  url?: string;
  title?: string;
  description?: string;
  snippet?: string;
  markdown?: string | null;
  html?: string | null;
  rawHtml?: string | null;
  links?: unknown;
  branding?: unknown;
  metadata?: { sourceURL?: string; title?: string; description?: string };
};

function strList(x: unknown): string[] {
  return Array.isArray(x)
    ? x.filter((v): v is string => typeof v === "string")
    : [];
}

function normalise(r: RawResult): FirecrawlPage | null {
  const url = r.url || r.metadata?.sourceURL || "";
  if (!url) return null;
  return {
    url,
    title: r.title || r.metadata?.title || url,
    description: r.description || r.snippet || r.metadata?.description || "",
    markdown: r.markdown || "",
    links: strList(r.links),
    branding:
      r.branding && typeof r.branding === "object"
        ? (r.branding as FirecrawlBranding)
        : null,
    // Prefer rawHtml (uncleaned, keeps <head>/<meta>) for SEO parsing.
    html:
      typeof r.rawHtml === "string"
        ? r.rawHtml
        : typeof r.html === "string"
          ? r.html
          : "",
  };
}

/**
 * Web/news search with the result pages scraped to markdown.
 * Returns [] on a failed call — research degrades to fewer sources
 * rather than dying because one query hit a rate limit.
 */
export async function firecrawlSearch(
  query: string,
  opts?: {
    limit?: number;
    /** Defaults to ["web"]. Pass ["news"] for recent coverage. */
    sources?: ("web" | "news")[];
    /** Time filter, e.g. "qdr:y" = past year. */
    tbs?: string;
    /** Skip scraping and keep just titles/descriptions (faster). */
    withoutContent?: boolean;
    /** Geo-target the search, e.g. "Colombo, Western, Sri Lanka". */
    location?: string;
    /** ISO country code for result ranking, e.g. "lk". */
    country?: string;
  },
): Promise<FirecrawlPage[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        query,
        limit: opts?.limit ?? 4,
        sources: (opts?.sources ?? ["web"]).map((type) => ({ type })),
        ...(opts?.tbs ? { tbs: opts.tbs } : {}),
        ...(opts?.location ? { location: opts.location } : {}),
        ...(opts?.country ? { country: opts.country } : {}),
        ...(opts?.withoutContent
          ? {}
          : {
              scrapeOptions: {
                formats: ["markdown"],
                onlyMainContent: true,
                timeout: SCRAPE_TIMEOUT_MS,
              },
            }),
      }),
    });
  } catch (e) {
    console.error(`[firecrawl] search errored: ${e instanceof Error ? e.message : e}`);
    return [];
  }

  if (!res.ok) {
    console.error(`[firecrawl] search failed (${res.status}): ${await res.text()}`);
    return [];
  }

  let json: { data?: Record<string, unknown> } | null;
  try {
    json = await res.json();
  } catch (e) {
    console.error(`[firecrawl] search: bad JSON — ${e instanceof Error ? e.message : e}`);
    return [];
  }
  // v2 keys results by source type: { data: { web: [...], news: [...] } }
  const data = (json?.data ?? {}) as Record<string, unknown>;
  const raw: RawResult[] = [
    ...(Array.isArray(data.web) ? (data.web as RawResult[]) : []),
    ...(Array.isArray(data.news) ? (data.news as RawResult[]) : []),
  ];
  return raw
    .map(normalise)
    .filter((p): p is FirecrawlPage => p !== null);
}

/**
 * Scrape one known URL to markdown + links, optionally with a full brand
 * profile. Returns null on failure — same graceful-degradation contract.
 */
export async function firecrawlScrape(
  url: string,
  opts?: { brand?: boolean; html?: boolean },
): Promise<FirecrawlPage | null> {
  const formats: string[] = ["markdown", "links"];
  if (opts?.brand) formats.push("branding");
  // rawHtml keeps <head>/<meta>/<script> that the cleaned `html` format and
  // `onlyMainContent` would strip — required for the SEO scorecard signals.
  if (opts?.html) formats.push("rawHtml");

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      signal: AbortSignal.timeout(
        opts?.brand ? BRAND_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS,
      ),
      body: JSON.stringify({
        url,
        formats,
        onlyMainContent: true,
        timeout: opts?.brand ? BRAND_SCRAPE_TIMEOUT_MS : SCRAPE_TIMEOUT_MS,
      }),
    });
  } catch (e) {
    console.error(`[firecrawl] scrape errored: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  if (!res.ok) {
    console.error(`[firecrawl] scrape failed (${res.status}): ${await res.text()}`);
    return null;
  }

  let json: { data?: RawResult } | null;
  try {
    json = await res.json();
  } catch (e) {
    console.error(`[firecrawl] scrape: bad JSON — ${e instanceof Error ? e.message : e}`);
    return null;
  }
  const data = (json?.data ?? {}) as RawResult;
  return normalise({ ...data, url: data.metadata?.sourceURL || url });
}

/**
 * Map a site — a fast listing of its URLs, optionally ordered by a search
 * term. Used to read a company's web presence (blog, portfolio, careers…)
 * without scraping every page. Returns [] on failure.
 */
export async function firecrawlMap(
  url: string,
  opts?: { search?: string; limit?: number },
): Promise<FirecrawlLink[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/map`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        url,
        ...(opts?.search ? { search: opts.search } : {}),
        limit: opts?.limit ?? 80,
      }),
    });
  } catch (e) {
    console.error(`[firecrawl] map errored: ${e instanceof Error ? e.message : e}`);
    return [];
  }

  if (!res.ok) {
    console.error(`[firecrawl] map failed (${res.status}): ${await res.text()}`);
    return [];
  }

  let json: { links?: unknown } | null;
  try {
    json = await res.json();
  } catch (e) {
    console.error(`[firecrawl] map: bad JSON — ${e instanceof Error ? e.message : e}`);
    return [];
  }
  const links = Array.isArray(json?.links) ? json.links : [];
  return links
    .map((l: unknown) => {
      const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
      return {
        url: typeof o.url === "string" ? o.url : "",
        title: typeof o.title === "string" ? o.title : "",
        description: typeof o.description === "string" ? o.description : "",
      };
    })
    .filter((l: FirecrawlLink) => l.url);
}

// ---- Crawl (0126, AI Projects) ---------------------------------------------
// A whole site, asynchronously: POST /crawl returns a job id, GET /crawl/{id}
// reports progress and pages, paginated through a `next` URL. Firecrawl has
// no scheduler — the CRM's tick starts crawls on the project's interval.

export type FirecrawlCrawlPage = { url: string; title: string; markdown: string };

export type FirecrawlCrawlStatus = {
  status: string;
  total: number;
  completed: number;
  /** The full URL of the next page of results, or null when this was the last. */
  next: string | null;
  pages: FirecrawlCrawlPage[];
};

/** Start a crawl. Null on failure (logged). */
export async function firecrawlCrawlStart(
  url: string,
  opts?: { limit?: number; maxDepth?: number },
): Promise<{ id: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/crawl`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        url,
        limit: Math.max(1, Math.min(1000, opts?.limit ?? 150)),
        ...(opts?.maxDepth ? { maxDiscoveryDepth: opts.maxDepth } : {}),
        ignoreQueryParameters: true,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
    });
  } catch (e) {
    console.error(`[firecrawl] crawl start errored: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[firecrawl] crawl start failed (${res.status}): ${await res.text()}`);
    return null;
  }
  try {
    const json = (await res.json()) as { id?: string; success?: boolean };
    return json?.id ? { id: String(json.id) } : null;
  } catch (e) {
    console.error(`[firecrawl] crawl start: bad JSON — ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Read a crawl's progress and one page of its results. Pass a job id for
 * the first page, then each response's `next` URL for the rest.
 */
export async function firecrawlCrawlStatus(idOrNextUrl: string): Promise<FirecrawlCrawlStatus | null> {
  const target = /^https?:\/\//i.test(idOrNextUrl)
    ? idOrNextUrl
    : `${BASE_URL}/crawl/${encodeURIComponent(idOrNextUrl)}`;
  let res: Response;
  try {
    res = await fetch(target, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(`[firecrawl] crawl status errored: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[firecrawl] crawl status failed (${res.status}): ${await res.text()}`);
    return null;
  }
  let json: { status?: string; total?: number; completed?: number; next?: string | null; data?: RawResult[] };
  try {
    json = await res.json();
  } catch (e) {
    console.error(`[firecrawl] crawl status: bad JSON — ${e instanceof Error ? e.message : e}`);
    return null;
  }
  const pages: FirecrawlCrawlPage[] = (Array.isArray(json.data) ? json.data : [])
    .map((r) => {
      const url = r.metadata?.sourceURL || r.url || "";
      return url ? { url, title: r.metadata?.title || r.title || "", markdown: r.markdown || "" } : null;
    })
    .filter((p): p is FirecrawlCrawlPage => p !== null);
  return {
    status: String(json.status ?? "scraping"),
    total: Number(json.total) || 0,
    completed: Number(json.completed) || 0,
    next: typeof json.next === "string" && json.next ? json.next : null,
    pages,
  };
}
