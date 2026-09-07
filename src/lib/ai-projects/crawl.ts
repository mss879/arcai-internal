import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { firecrawlCrawlStart, firecrawlCrawlStatus, isFirecrawlConfigured } from "@/lib/ai/firecrawl";
import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";
import { logSystemWrite } from "@/lib/system-audit";
import type { AiCrawlJob } from "@/lib/types";

import {
  ACTIVE_CRAWL_STATUSES,
  STALE_DELETE_AFTER_DAYS,
  beginStep,
  decidePage,
  endStep,
  foldCrawlStatus,
  isSourceStale,
  leaseIsFree,
  leaseUntil,
  nextPhase,
  scheduleNext,
  scrapingTimedOut,
  type CrawlJobLite,
} from "./crawl-core";
import { ingestSource } from "./kb";
import { MAX_SOURCE_CHARS, contentHash, titleForPage } from "./kb-core";

type DB = SupabaseClient<Database>;

/**
 * The crawl job stepper (0126).
 *
 * One call advances one job by one bounded step under a lease — the same
 * shape as the web-analytics job. Phases:
 *
 *   queued → starting   ask Firecrawl to crawl the site
 *   → crawling          poll; when done, read the pages a response-page at a
 *                       time, and file each as new / changed / unchanged
 *   → ingesting         embed the changed pages (resumable, via ingestSource)
 *   → finalising        pages the run did not see become `stale`; old stale
 *                       pages are deleted; the project's clock advances
 *   → completed
 *
 * Every step persists where it got to before returning, so the five-minute
 * tick or the "Crawl now" button simply carries on.
 */

const TICK_BUDGET_MS = 6_000;
const INGEST_PER_STEP = 4;

export type CrawlStepResult = {
  status: "idle" | "busy" | "stepped" | "done" | "unconfigured";
  jobId: string | null;
  phase: string | null;
};

type Lite = CrawlJobLite & Pick<AiCrawlJob, "id" | "project_id" | "firecrawl_id" | "next_url" | "total" | "completed" | "pages_seen" | "pages_changed" | "pages_unchanged" | "pages_stale" | "chunks_written" | "embedding_tokens" | "triggered_by">;

function lite(row: AiCrawlJob): Lite {
  return {
    ...row,
    errors: Array.isArray(row.errors) ? row.errors.map(String) : [],
  };
}

async function persist(db: DB, job: Lite, extra: Partial<Database["public"]["Tables"]["ai_crawl_jobs"]["Update"]> = {}): Promise<void> {
  const { error } = await db
    .from("ai_crawl_jobs")
    .update({
      status: job.status,
      killed: job.killed,
      steps: job.steps,
      errors: job.errors,
      error: job.error,
      firecrawl_id: job.firecrawl_id,
      next_url: job.next_url,
      total: job.total,
      completed: job.completed,
      pages_seen: job.pages_seen,
      pages_changed: job.pages_changed,
      pages_unchanged: job.pages_unchanged,
      pages_stale: job.pages_stale,
      chunks_written: job.chunks_written,
      embedding_tokens: job.embedding_tokens,
      ...extra,
    })
    .eq("id", job.id);
  if (error) throw new Error(`crawl job update failed: ${error.message}`);
}

async function finish(db: DB, job: Lite, status: "completed" | "failed", error?: string): Promise<void> {
  const nowIso = new Date().toISOString();
  job.status = status;
  if (error) {
    job.error = error;
    job.errors = [...job.errors, error].slice(-20);
  }
  await persist(db, job, { finished_at: nowIso, lease_until: null });

  // The project's clock advances on success AND failure, so a broken site
  // is retried on its interval rather than every five minutes.
  const { data: project } = await db.from("ai_projects").select("crawl_interval_days").eq("id", job.project_id).maybeSingle();
  await db
    .from("ai_projects")
    .update({
      ...(status === "completed" ? { last_crawl_at: nowIso } : {}),
      next_crawl_at: scheduleNext(nowIso, project?.crawl_interval_days ?? null),
    })
    .eq("id", job.project_id);

  await logSystemWrite(db, {
    job: "aiCrawl",
    table: "ai_crawl_jobs",
    rowId: job.id,
    action: "updated",
    summary:
      status === "completed"
        ? `Crawl finished: ${job.pages_seen} pages, ${job.pages_changed} changed, ${job.pages_stale} removed, ${job.chunks_written} chunks`
        : `Crawl failed: ${error ?? "unknown error"}`,
    meta: { project_id: job.project_id, triggered_by: job.triggered_by },
  });
}

/** One bounded step of one job. */
export async function stepCrawlJob(db: DB, jobId: string, opts: { budgetMs?: number } = {}): Promise<CrawlStepResult> {
  if (!isFirecrawlConfigured()) return { status: "unconfigured", jobId, phase: null };
  const deadline = Date.now() + (opts.budgetMs ?? TICK_BUDGET_MS);

  const { data: row } = await db.from("ai_crawl_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!row || !(ACTIVE_CRAWL_STATUSES as readonly string[]).includes(row.status)) {
    return { status: "idle", jobId, phase: row?.status ?? null };
  }
  const nowIso = new Date().toISOString();
  if (!leaseIsFree(row.lease_until, nowIso)) return { status: "busy", jobId, phase: row.status };

  // Take the lease with a compare-and-set on the version counter.
  const { data: leased } = await db
    .from("ai_crawl_jobs")
    .update({ lease_until: leaseUntil(Date.now()), version: row.version + 1 })
    .eq("id", jobId)
    .eq("version", row.version)
    .select("id")
    .maybeSingle();
  if (!leased) return { status: "busy", jobId, phase: row.status };

  let job = lite(row);
  const begun = beginStep(job);
  job = { ...job, ...begun.job };
  if (begun.abandoned) {
    await finish(db, job, "failed", job.error ?? "abandoned");
    return { status: "done", jobId, phase: "failed" };
  }
  await persist(db, job);

  try {
    // Work through phases while time remains; each phase persists as it goes.
    while (Date.now() < deadline && (ACTIVE_CRAWL_STATUSES as readonly string[]).includes(job.status)) {
      const before = job.status;
      const proceed = await runPhase(db, job, deadline);
      if (!proceed || job.status === before) break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await captureError(e, { source: "tick", path: "ai/crawl", meta: { job: jobId, phase: job.status } });
    await finish(db, job, "failed", message);
    return { status: "done", jobId, phase: "failed" };
  }

  if (!(ACTIVE_CRAWL_STATUSES as readonly string[]).includes(job.status)) {
    return { status: "done", jobId, phase: job.status };
  }
  job = { ...job, ...endStep(job) };
  await persist(db, job, { lease_until: null });
  return { status: "stepped", jobId, phase: job.status };
}

/**
 * Advance one phase. Returns true when the loop may go straight on to the
 * next phase in the same step, false when it should wait for the next call
 * (the crawl is still running on Firecrawl's side, or time is up).
 */
async function runPhase(db: DB, job: Lite, deadline: number): Promise<boolean> {
  switch (job.status) {
    case "queued":
      job.status = "starting";
      await persist(db, job);
      return true;

    case "starting": {
      const { data: project } = await db.from("ai_projects").select("website_url, crawl_limit").eq("id", job.project_id).maybeSingle();
      if (!project?.website_url) {
        await finish(db, job, "failed", "The project has no website to crawl.");
        return false;
      }
      const started = await firecrawlCrawlStart(project.website_url, { limit: project.crawl_limit });
      if (!started) {
        await finish(db, job, "failed", "Firecrawl refused to start the crawl.");
        return false;
      }
      job.firecrawl_id = started.id;
      job.status = "crawling";
      await persist(db, job);
      return false; // give Firecrawl time before the first poll
    }

    case "crawling": {
      if (!job.firecrawl_id) {
        await finish(db, job, "failed", "The crawl lost its Firecrawl id.");
        return false;
      }
      const page = await firecrawlCrawlStatus(job.next_url ?? job.firecrawl_id);
      if (!page) {
        // A transient read failure: try again next step, unless it has gone on too long.
        if (scrapingTimedOut(job.started_at, new Date().toISOString())) {
          await finish(db, job, "failed", "Firecrawl did not answer for thirty minutes.");
        }
        return false;
      }
      job.total = page.total;
      job.completed = page.completed;
      const folded = foldCrawlStatus(page.status);
      if (folded === "failed") {
        await finish(db, job, "failed", "Firecrawl reported the crawl as failed.");
        return false;
      }
      if (folded === "scraping" && !job.next_url) {
        if (scrapingTimedOut(job.started_at, new Date().toISOString())) {
          await finish(db, job, "failed", "The crawl ran for thirty minutes without finishing.");
          return false;
        }
        await persist(db, job);
        return false; // still crawling — poll again next step
      }

      await filePages(db, job, page.pages);
      if (page.next) {
        job.next_url = page.next;
        await persist(db, job);
        return Date.now() < deadline; // more pages: keep going if there is time
      }
      job.next_url = null;
      job.status = nextPhase("crawling");
      await persist(db, job);
      return true;
    }

    case "ingesting": {
      const { data: pending } = await db
        .from("ai_kb_sources")
        .select("id")
        .eq("project_id", job.project_id)
        .eq("crawl_job_id", job.id)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(INGEST_PER_STEP);
      if (!pending?.length) {
        job.status = nextPhase("ingesting");
        await persist(db, job);
        return true;
      }
      for (const source of pending) {
        if (Date.now() > deadline) return false;
        const res = await ingestSource(db, source.id, { deadline });
        if (res.ok) {
          job.chunks_written += res.complete ? res.chunks : 0;
          job.embedding_tokens += res.tokens;
          if (!res.complete) return false;
        } else if (!res.retry) {
          job.errors = [...job.errors, `${source.id}: ${res.error}`].slice(-20);
        }
        await persist(db, job);
      }
      return Date.now() < deadline;
    }

    case "finalising": {
      const { data: crawled } = await db
        .from("ai_kb_sources")
        .select("id, last_seen_at, status, updated_at")
        .eq("project_id", job.project_id)
        .eq("source_kind", "crawl");
      const staleIds = (crawled ?? [])
        .filter((s) => s.status !== "stale" && isSourceStale(s.last_seen_at, job.started_at))
        .map((s) => s.id);
      if (staleIds.length) {
        await db.from("ai_kb_chunks").delete().in("source_id", staleIds);
        await db.from("ai_kb_sources").update({ status: "stale", chunk_count: 0 }).in("id", staleIds);
        job.pages_stale += staleIds.length;
      }
      const cutoff = new Date(Date.now() - STALE_DELETE_AFTER_DAYS * 86_400_000).toISOString();
      const oldStale = (crawled ?? []).filter((s) => s.status === "stale" && s.updated_at < cutoff).map((s) => s.id);
      if (oldStale.length) await db.from("ai_kb_sources").delete().in("id", oldStale);
      await finish(db, job, "completed");
      return false;
    }

    default:
      return false;
  }
}

/** File one response-page of crawled pages as new / changed / unchanged. */
async function filePages(db: DB, job: Lite, pages: { url: string; title: string; markdown: string }[]): Promise<void> {
  if (!pages.length) return;
  const nowIso = new Date().toISOString();
  const urls = pages.map((p) => p.url);
  const { data: existing } = await db
    .from("ai_kb_sources")
    .select("id, url, content_hash, status")
    .eq("project_id", job.project_id)
    .in("url", urls);
  const byUrl = new Map((existing ?? []).map((e) => [e.url, e] as const));

  const unchanged: string[] = [];
  const inserts: Database["public"]["Tables"]["ai_kb_sources"]["Insert"][] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    job.pages_seen += 1;
    const text = (page.markdown ?? "").trim();
    if (!text) {
      job.errors = [...job.errors, `${page.url}: no text`].slice(-20);
      continue;
    }
    const hash = contentHash(text);
    const current = byUrl.get(page.url) ?? null;
    const decision = decidePage(current, hash);
    if (decision === "unchanged" && current) {
      unchanged.push(current.id);
      job.pages_unchanged += 1;
    } else if (current) {
      job.pages_changed += 1;
      await db
        .from("ai_kb_sources")
        .update({
          title: titleForPage(page.url, page.title),
          content: text.slice(0, MAX_SOURCE_CHARS),
          content_hash: null,
          chunk_count: 0,
          status: "pending",
          error: null,
          crawl_job_id: job.id,
          last_seen_at: nowIso,
          source_kind: "crawl",
        })
        .eq("id", current.id);
    } else {
      job.pages_changed += 1;
      inserts.push({
        project_id: job.project_id,
        source_kind: "crawl",
        url: page.url,
        title: titleForPage(page.url, page.title),
        content: text.slice(0, MAX_SOURCE_CHARS),
        status: "pending",
        crawl_job_id: job.id,
        last_seen_at: nowIso,
      });
    }
  }
  if (unchanged.length) {
    await db.from("ai_kb_sources").update({ last_seen_at: nowIso, crawl_job_id: job.id }).in("id", unchanged);
  }
  if (inserts.length) {
    const { error } = await db.from("ai_kb_sources").insert(inserts);
    if (error) throw new Error(`crawl page insert failed: ${error.message}`);
  }
}

export type CrawlPassResult = { enqueued: number; stepped: string | null; phase: string | null };

/**
 * The `aiCrawl` tick pass: start crawls that are due, then advance the
 * oldest running job by one step. One job per tick keeps the pass inside
 * its share of the function window.
 */
export async function processAiCrawl(db: DB, now = new Date()): Promise<CrawlPassResult> {
  const result: CrawlPassResult = { enqueued: 0, stepped: null, phase: null };
  if (!isFirecrawlConfigured()) return result;
  try {
    const nowIso = now.toISOString();
    const { data: due } = await db
      .from("ai_projects")
      .select("id, crawl_interval_days, next_crawl_at")
      .in("status", ["draft", "active"])
      .not("crawl_interval_days", "is", null)
      .not("website_url", "is", null)
      .lte("next_crawl_at", nowIso)
      .limit(5);
    for (const project of due ?? []) {
      const { data: active } = await db
        .from("ai_crawl_jobs")
        .select("id")
        .eq("project_id", project.id)
        .in("status", [...ACTIVE_CRAWL_STATUSES])
        .limit(1)
        .maybeSingle();
      if (active) continue;
      // Claim by advancing the clock first (compare-and-set on the old value).
      const { data: claimed } = await db
        .from("ai_projects")
        .update({ next_crawl_at: scheduleNext(nowIso, project.crawl_interval_days) })
        .eq("id", project.id)
        .eq("next_crawl_at", project.next_crawl_at ?? "")
        .select("id")
        .maybeSingle();
      if (!claimed) continue;
      await db.from("ai_crawl_jobs").insert({ project_id: project.id, status: "queued", triggered_by: "schedule", errors: [] });
      result.enqueued += 1;
    }

    const { data: job } = await db
      .from("ai_crawl_jobs")
      .select("id")
      .in("status", [...ACTIVE_CRAWL_STATUSES])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (job) {
      const step = await stepCrawlJob(db, job.id, { budgetMs: TICK_BUDGET_MS });
      result.stepped = job.id;
      result.phase = step.phase;
    }
  } catch (e) {
    await captureError(e, { source: "tick", path: "ai/crawl-pass" });
  }
  return result;
}
