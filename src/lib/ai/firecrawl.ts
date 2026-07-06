import "server-only";

/**
 * Thin wrapper around the Firecrawl v2 REST API used by CRM lead
 * research. Same philosophy as `openai.ts`: plain `fetch`, no SDK,
 * works the moment a `FIRECRAWL_API_KEY` lands in the env, and the
 * key never reaches the browser.
 *
 * We lean on `/search` (Google-quality results with the matching
 * pages scraped to markdown in the same call) instead of scraping
 * LinkedIn/Google result pages ourselves — those block bots, search
 * does not.
 */

const BASE_URL =
  process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev/v2";

/**
 * Server-side scrape budget Firecrawl applies per page (ms). Kept short so
 * one slow page can't blow the whole research run past the serverless
 * function's wall-clock limit.
 */
const SCRAPE_TIMEOUT_MS = 8000;
/** Hard client-side abort so a hung connection can never stall a run. */
const FETCH_TIMEOUT_MS = 13000;

/** True when a Firecrawl key is configured. */
export function isFirecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set.");
  return key;
}

/** One search hit / scraped page, normalised for the research engine. */
export type FirecrawlPage = {
  url: string;
  title: string;
  description: string;
  markdown: string;
};

type RawResult = {
  url?: string;
  title?: string;
  description?: string;
  snippet?: string;
  markdown?: string | null;
  metadata?: { sourceURL?: string; title?: string; description?: string };
};

function normalise(r: RawResult): FirecrawlPage | null {
  const url = r.url || r.metadata?.sourceURL || "";
  if (!url) return null;
  return {
    url,
    title: r.title || r.metadata?.title || url,
    description: r.description || r.snippet || r.metadata?.description || "",
    markdown: r.markdown || "",
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

  const json = await res.json();
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
 * Scrape one known URL (the prospect's own website) to markdown.
 * Returns null on failure — same graceful-degradation contract.
 */
export async function firecrawlScrape(
  url: string,
): Promise<FirecrawlPage | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: SCRAPE_TIMEOUT_MS,
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

  const json = await res.json();
  const data = (json?.data ?? {}) as RawResult;
  return normalise({ ...data, url: data.metadata?.sourceURL || url });
}
