/**
 * The crawl job's decisions (0126), without the database.
 *
 * A crawl runs as bounded steps under a lease, the way the web-analytics job
 * does (`web-analytics/job-core.ts`): the platform kills a function at
 * ~26 seconds, so every step persists where it got to and the next caller —
 * the five-minute tick or the "Crawl now" button — carries on. The row in
 * `ai_crawl_jobs` IS the job state; these functions decide what to do with
 * it and are pinned by tests because every bug here is a crawl that either
 * never finishes or never stops.
 */

export type CrawlPhase =
  | "queued"
  | "starting"
  | "crawling"
  | "ingesting"
  | "finalising"
  | "completed"
  | "failed"
  | "cancelled";

export const ACTIVE_CRAWL_STATUSES: readonly CrawlPhase[] = [
  "queued",
  "starting",
  "crawling",
  "ingesting",
  "finalising",
];

/** Longer than any function the platform will let run, shorter than a tick. */
export const CRAWL_LEASE_MS = 90_000;
/** Three killed steps in a row and the job is failed rather than retried forever. */
export const MAX_KILLED_STEPS = 3;
/** Firecrawl reporting `scraping` for longer than this is a hung crawl. */
export const CRAWL_SCRAPING_TIMEOUT_MS = 30 * 60_000;
/** A page not seen by any crawl for this long is deleted, chunks and all. */
export const STALE_DELETE_AFTER_DAYS = 30;

export type CrawlJobLite = {
  status: CrawlPhase;
  killed: number;
  steps: number;
  errors: string[];
  error: string | null;
  started_at: string;
  lease_until: string | null;
  version: number;
};

export function isActiveCrawl(status: string): status is CrawlPhase {
  return (ACTIVE_CRAWL_STATUSES as readonly string[]).includes(status);
}

/** Free when never taken or expired. */
export function leaseIsFree(leaseUntil: string | null, nowIso: string): boolean {
  return !leaseUntil || leaseUntil < nowIso;
}

export function leaseUntil(nowMs: number): string {
  return new Date(nowMs + CRAWL_LEASE_MS).toISOString();
}

/**
 * Mark a step as started. `killed` is bumped BEFORE any work and reset only
 * when the step returns normally, so a step the platform kills leaves the
 * count one higher. Three in a row fails the job with a recorded reason.
 */
export function beginStep(job: CrawlJobLite): { job: CrawlJobLite; abandoned: boolean } {
  if (job.killed >= MAX_KILLED_STEPS) {
    const reason = `${job.status}: abandoned after ${job.killed} steps were cut off by the platform time limit`;
    return {
      job: {
        ...job,
        status: "failed",
        error: reason,
        errors: [...job.errors, reason].slice(-20),
        steps: job.steps + 1,
        killed: 0,
      },
      abandoned: true,
    };
  }
  return { job: { ...job, steps: job.steps + 1, killed: job.killed + 1 }, abandoned: false };
}

export function endStep(job: CrawlJobLite): CrawlJobLite {
  return { ...job, killed: 0 };
}

/** The phase after this one. */
export function nextPhase(phase: CrawlPhase): CrawlPhase {
  switch (phase) {
    case "queued":
      return "starting";
    case "starting":
      return "crawling";
    case "crawling":
      return "ingesting";
    case "ingesting":
      return "finalising";
    case "finalising":
      return "completed";
    default:
      return phase;
  }
}

export type PageDecision = "new" | "changed" | "unchanged";

/**
 * What to do with a crawled page. Only a READY source with the same hash is
 * skipped; a failed or stale one with the same text is re-ingested, because
 * its chunks are gone or never existed.
 */
export function decidePage(
  existing: { content_hash: string | null; status: string } | null,
  hash: string,
): PageDecision {
  if (!existing) return "new";
  if (existing.status === "ready" && existing.content_hash === hash) return "unchanged";
  return "changed";
}

/** Firecrawl has been "scraping" for too long. */
export function scrapingTimedOut(startedAtIso: string, nowIso: string): boolean {
  const started = Date.parse(startedAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(started) || !Number.isFinite(now)) return false;
  return now - started > CRAWL_SCRAPING_TIMEOUT_MS;
}

/** When the next scheduled crawl is due; null for a manual-only project. A
 * failed run still advances the clock so a broken site is not retried every
 * five minutes. */
export function scheduleNext(nowIso: string, intervalDays: number | null): string | null {
  if (!intervalDays || intervalDays <= 0) return null;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;
  return new Date(now + intervalDays * 86_400_000).toISOString();
}

/** A crawl source the finished run did not see is stale. */
export function isSourceStale(lastSeenAtIso: string | null, jobStartedAtIso: string): boolean {
  if (!lastSeenAtIso) return true;
  return lastSeenAtIso < jobStartedAtIso;
}

/** Firecrawl's job status, folded to what the stepper cares about. */
export function foldCrawlStatus(status: string | null | undefined): "scraping" | "completed" | "failed" {
  const s = (status ?? "").toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed" || s === "cancelled") return "failed";
  return "scraping";
}

/** One line for the job card. */
export function summariseCrawl(job: {
  status: CrawlPhase;
  pages_seen: number;
  pages_changed: number;
  pages_unchanged: number;
  pages_stale: number;
  chunks_written: number;
}): string {
  switch (job.status) {
    case "queued":
      return "Waiting to start";
    case "starting":
      return "Starting the crawl";
    case "crawling":
      return `Reading pages — ${job.pages_seen} seen so far`;
    case "ingesting":
      return `Indexing ${job.pages_changed} changed page${job.pages_changed === 1 ? "" : "s"}`;
    case "finalising":
      return "Tidying up";
    case "completed":
      return `${job.pages_seen} pages · ${job.pages_changed} changed · ${job.pages_unchanged} unchanged · ${job.pages_stale} removed · ${job.chunks_written} chunks`;
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}
