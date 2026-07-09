import "server-only";

/**
 * Direct HTTP truth-check for the prospecting qualifier. A Firecrawl scrape
 * returning null does NOT mean a site is down — rate limits, scrape timeouts
 * and bot-blocking all return null too (that's how a live site got a false
 * "Site down" verdict). Before any negative claim, this module visits the
 * site itself, browser-style, and reports what a real visitor would get.
 *
 * Leaf module: only `server-only` + fetch, so the Node test harness can run
 * it — including live against the exact site a verdict is disputed on.
 */

const PROBE_TIMEOUT_MS = 10_000;

/** Look like a real browser — plain `fetch` UA gets bot-walled far more often. */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export type ProbeVerdict =
  /** Responded 2xx with (usually) real content — definitively not down. */
  | "up"
  /** Responded, but behind bot protection / auth (401/403/429) — up, unreadable. */
  | "protected"
  /** Responded 5xx — visitors see a server error. */
  | "erroring"
  /** No variant of the URL answered at all. */
  | "down";

export type ProbeResult = {
  verdict: ProbeVerdict;
  /** HTTP status of the best response seen (0 = nothing answered). */
  status: number;
  /** Page HTML when the response was readable HTML, else "". */
  html: string;
  /** The URL that answered (after redirects), else "". */
  finalUrl: string;
};

/** Pure status → verdict mapping (exported for the fixture tests). */
export function classifyProbe(status: number): ProbeVerdict {
  if (status >= 200 && status < 400) return "up";
  if (status === 401 || status === 403 || status === 429) return "protected";
  if (status >= 500) return "erroring";
  if (status > 0) return "protected"; // other 4xx: server exists, page didn't
  return "down";
}

/** The https/http and www/bare variants worth trying when a URL won't answer. */
export function probeVariants(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return [];
  }
  const host = url.hostname;
  const flippedHost = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  const path = `${url.pathname}${url.search}`;
  const scheme = url.protocol === "http:" ? "http" : "https";
  const flippedScheme = scheme === "https" ? "http" : "https";
  // As given first, then the www-flip, then the scheme-flip.
  return [
    `${scheme}://${host}${path}`,
    `${scheme}://${flippedHost}${path}`,
    `${flippedScheme}://${host}${path}`,
  ];
}

async function probeOnce(url: string): Promise<ProbeResult | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: BROWSER_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const type = res.headers.get("content-type") ?? "";
    let html = "";
    if (res.ok && /text\/html|application\/xhtml/i.test(type)) {
      // Bound the read — a grading pass never needs more than this.
      html = (await res.text().catch(() => "")).slice(0, 600_000);
    } else {
      // Drain/discard so the connection is released.
      await res.arrayBuffer().catch(() => undefined);
    }
    return {
      verdict: classifyProbe(res.status),
      status: res.status,
      html,
      finalUrl: res.url || url,
    };
  } catch {
    return null; // network error / timeout — try the next variant
  }
}

/**
 * Visit the site like a browser would, trying sensible URL variants before
 * concluding anything. Never throws. "down" is only returned when EVERY
 * variant fails at the network level.
 */
export async function probeSite(raw: string): Promise<ProbeResult> {
  const variants = probeVariants(raw);
  let best: ProbeResult | null = null;
  for (const url of variants) {
    const result = await probeOnce(url);
    if (!result) continue;
    if (result.verdict === "up") return result;
    // Remember the most informative non-up answer (any response beats none).
    if (!best) best = result;
  }
  return best ?? { verdict: "down", status: 0, html: "", finalUrl: "" };
}
