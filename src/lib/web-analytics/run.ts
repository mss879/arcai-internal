import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import {
  advance,
  beginStep,
  coerceState,
  emptyState,
  endStep,
  finishJob,
  isDue,
  leaseIsFree,
  mergeRequest,
  openJob,
  summarise,
  type ActiveJob,
  type JobRequest,
  type JobState,
  type JobSummary,
} from "./job-core";
import { generateWebReport, analyseChatSessions } from "./report";
import { daysTouchedSince, findUnrolledDays, rollupDay, rollupJourneys } from "./rollup";
import { SITE, isWebsiteSourceConfigured } from "./source";
import { prepareSync, stitchIdentities, syncStep } from "./sync";

type DB = SupabaseClient<Database>;

/**
 * The whole pipeline, as a job that advances in bounded steps.
 *
 *   sync    → the raw mirror is brought up to date, a page at a time
 *   rollup  → the days that changed are recomputed, a day at a time
 *   chats   → the AI labels new conversations, a few at a time
 *   report  → the daily/weekly report is written from the fresh rollups
 *
 * Why steps: this runs on serverless functions that the platform kills at
 * roughly 26 seconds, and the version that tried to do all of the above
 * in one call was killed on every run for six days — 27,000 half-finished
 * runs, no rollup after 31 August, and a "last run" stamp that only moved
 * when a person pressed the button. Every step here persists where it got
 * to before returning, so whoever calls next — the five-minute automation
 * tick, the twice-daily schedule, the Sync now button — simply carries on.
 *
 * Why a lease: with no gate at the START of a run, a killed run never
 * stamped the gate, so the next caller saw the pipeline as "due" and
 * started another — several at once, twenty seconds apart. The lease is
 * taken with a compare-and-set before any work and released at the end;
 * a killed step leaves it to expire ninety seconds later.
 */

const STATE_KEY = "web_analytics_job";
const REQUEST_KEY = "web_analytics_request";

/** Longer than any function the platform will let run, shorter than a tick. */
const LEASE_MS = 90_000;

const DEFAULT_INTERVAL_HOURS = 12;

/** How often a job starts on its own. Overridable per install. */
export function syncIntervalHours(): number {
  const raw = Number(process.env.WEB_ANALYTICS_SYNC_INTERVAL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_HOURS;
  return Math.min(7 * 24, Math.max(1, hours));
}

export function syncIntervalMs(): number {
  return syncIntervalHours() * 3_600_000;
}

/** The tick's per-step budget: it shares its function window with ~30 other passes. */
const TICK_STEP_MS = Number(process.env.WEB_ANALYTICS_STEP_MS) || 6_000;

/** What a caller that has its own function window is allowed. */
export const FULL_STEP_MS = 18_000;

export type StepResult = {
  status: "idle" | "busy" | "unconfigured" | "stepped";
  /** No job is active once this step returned. */
  done: boolean;
  summary: JobSummary;
  step?: {
    rows: number;
    days: number;
    chats: number;
    reportId: string | null;
    errors: string[];
    durationMs: number;
  };
};

// ── persistence ─────────────────────────────────────────────────────────────

async function readState(db: DB): Promise<JobState> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", STATE_KEY)
    .maybeSingle();
  return data ? coerceState(data.value) : emptyState();
}

async function readRequest(db: DB): Promise<JobRequest | null> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", REQUEST_KEY)
    .maybeSingle();
  const v = data?.value as JobRequest | undefined;
  if (!v || (!v.start && !v.report && !v.analyse_chats)) return null;
  return v;
}

/**
 * Ask for work without holding the lease.
 *
 * The request lives in its own row so it can be written while a step is
 * running, and it is folded into the job by the next step that holds the
 * lease. Merged rather than replaced: two callers asking for different
 * things in the same minute should both be honoured.
 */
export async function requestWebAnalyticsJob(db: DB, req: JobRequest): Promise<void> {
  const current = (await readRequest(db)) ?? {};
  const now = new Date().toISOString();
  await db.from("app_settings").upsert(
    {
      key: REQUEST_KEY,
      value: {
        start: Boolean(current.start || req.start),
        report: req.report ?? current.report ?? null,
        analyse_chats: Boolean(current.analyse_chats || req.analyse_chats),
        requested_at: now,
      },
      updated_at: now,
    },
    { onConflict: "key" },
  );
}

async function clearRequest(db: DB): Promise<void> {
  await db.from("app_settings").delete().eq("key", REQUEST_KEY);
}

/**
 * Take the lease, or learn that somebody else holds it.
 *
 * A compare-and-set on the version we read: the update only lands if the
 * row still carries that version AND the lease is free. Two callers that
 * read the same state race here and exactly one wins; a caller holding a
 * stale copy loses even if the lease happens to be free, so it can never
 * overwrite a newer state with an older one.
 */
async function acquireLease(db: DB, state: JobState): Promise<JobState | null> {
  const nowIso = new Date().toISOString();
  if (!leaseIsFree(state, nowIso)) return null;

  // The row has to exist for the compare-and-set to have anything to hit.
  if (state.version === 0) {
    await db
      .from("app_settings")
      .upsert(
        { key: STATE_KEY, value: emptyState(), updated_at: nowIso },
        { onConflict: "key", ignoreDuplicates: true },
      );
  }

  const next: JobState = {
    ...state,
    version: state.version + 1,
    lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
  };
  const { data } = await db
    .from("app_settings")
    .update({ value: next, updated_at: nowIso })
    .eq("key", STATE_KEY)
    .eq("value->>version", String(state.version))
    .select("key");
  return data?.length ? next : null;
}

/** Write the state. Only ever called by the lease holder. */
async function saveState(
  db: DB,
  state: JobState,
  opts: { release?: boolean } = {},
): Promise<JobState> {
  const next: JobState = {
    ...state,
    version: state.version + 1,
    lease_until: opts.release ? null : new Date(Date.now() + LEASE_MS).toISOString(),
  };
  await db
    .from("app_settings")
    .update({ value: next, updated_at: new Date().toISOString() })
    .eq("key", STATE_KEY);
  return next;
}

/**
 * The `pipeline` row in `web_sync_state`, kept for the Setup tab's table:
 * when the whole job last finished, and whether it was clean.
 */
async function stampPipeline(db: DB, job: ActiveJob): Promise<void> {
  const now = new Date().toISOString();
  await db.from("web_sync_state").upsert(
    {
      stream: "pipeline",
      last_run_at: now,
      last_ok_at: job.errors.length ? undefined : now,
      last_error: job.errors.length ? job.errors.join(" · ").slice(0, 1000) : null,
      updated_at: now,
    },
    { onConflict: "stream" },
  );
}

/** For the page and the API — never takes the lease. */
export async function readJobStatus(db: DB): Promise<JobSummary> {
  return summarise(await readState(db), new Date().toISOString());
}

const uniqDesc = (days: string[]): string[] => [...new Set(days)].sort().reverse();

// ── the step ────────────────────────────────────────────────────────────────

/**
 * Do up to `budgetMs` of whatever the job needs next, then stop.
 *
 * The budget is a deadline for STARTING work: a page, a day, a
 * conversation that has already begun runs to its end. Callers with their
 * own function window pass ~18s; the automation tick passes ~6s because it
 * has thirty other passes to fit beside this one.
 *
 * `request` asks for a job (or for a report / chat labelling on the
 * current one). `rebuild` opens a rebuild job that supersedes whatever is
 * running, after `before` has wound the cursors back under the lease.
 */
export async function runWebAnalyticsStep(
  db: DB,
  opts: {
    budgetMs: number;
    request?: JobRequest;
    rebuild?: { days: string[]; before: () => Promise<void> };
  },
): Promise<StepResult> {
  const started = Date.now();
  const nowIso = () => new Date().toISOString();

  if (!isWebsiteSourceConfigured()) {
    return { status: "unconfigured", done: true, summary: summarise(await readState(db), nowIso()) };
  }

  if (opts.request) await requestWebAnalyticsJob(db, opts.request);

  // The lease, with one retry: a version conflict means somebody wrote
  // between our read and our compare-and-set, which is not the same as
  // somebody holding the lease.
  let state = await readState(db);
  let leased = await acquireLease(db, state);
  if (!leased) {
    state = await readState(db);
    leased = await acquireLease(db, state);
  }
  if (!leased) return { status: "busy", done: false, summary: summarise(state, nowIso()) };
  state = leased;

  const deadline = started + Math.max(1_000, opts.budgetMs);
  const stats = {
    rows: 0,
    days: 0,
    chats: 0,
    reportId: null as string | null,
    errors: [] as string[],
  };

  // ---- open, continue, or go back to sleep ----------------------------------
  const pending = await readRequest(db);
  let job = state.job;

  if (opts.rebuild) {
    await opts.rebuild.before();
    job = openJob({ ...(pending ?? {}), ...(opts.request ?? {}), start: true }, nowIso(), {
      rebuild: { days: opts.rebuild.days },
    });
    if (pending) await clearRequest(db);
  } else if (!job) {
    if (pending?.start || isDue(state, nowIso())) {
      job = openJob(pending ?? {}, nowIso());
      if (pending) await clearRequest(db);
    } else {
      state = await saveState(db, state, { release: true });
      return { status: "idle", done: true, summary: summarise(state, nowIso()) };
    }
  } else if (pending) {
    const merged = mergeRequest(job, pending);
    job = merged.job;
    if (merged.consumed) await clearRequest(db);
  }

  // The kill counter goes up BEFORE any work — see job-core.beginStep.
  const begun = beginStep(job);
  job = begun.job;
  if (begun.abandonedPhase) stats.errors.push(job.errors[job.errors.length - 1]);
  state = await saveState(db, { ...state, job });

  const save = async () => {
    state = await saveState(db, { ...state, job });
  };
  const fail = (message: string) => {
    job = { ...job!, errors: [...job!.errors, message].slice(0, 40) };
    stats.errors.push(message);
  };
  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // ---- sync -----------------------------------------------------------------
  const syncPhase = async (): Promise<boolean> => {
    if (!job!.prepared) {
      const { cutover, prunedDays } = await prepareSync(db);
      job = {
        ...job!,
        prepared: true,
        cutover,
        extra_days: uniqDesc([...job!.extra_days, ...prunedDays]),
      };
      await save();
    }

    // Keep pulling until every stream is up to date or the time is gone. A
    // stream that stops for its own reasons — the chat stream rebuilds a
    // bounded number of conversations per pass — is simply called again;
    // returning early here left two thirds of an 18-second budget unused.
    let exhausted = false;
    while (Date.now() < deadline) {
      const result = await syncStep(db, {
        deadline,
        cutover: job!.cutover,
        skip: job!.failed_streams as Parameters<typeof syncStep>[1]["skip"],
      });
      job = { ...job!, rows: job!.rows + result.totalRows };
      stats.rows += result.totalRows;
      for (const stream of result.streams) {
        if (stream.ok) continue;
        job = { ...job!, failed_streams: [...job!.failed_streams, stream.stream] };
        fail(`${stream.stream}: ${stream.error}`);
      }
      if (result.exhausted) {
        exhausted = true;
        break;
      }
      await save();
    }
    if (!exhausted) return false;

    // The mirror is current. Stitch, then work out which days to redo.
    await stitchIdentities(db).catch(() => 0);
    const today = nowIso().slice(0, 10);
    let pendingDays: string[];
    if (job!.rebuild) {
      pendingDays = uniqDesc([...(job!.pending_days ?? []), ...job!.extra_days]);
      // A rebuild recomputes journeys from nothing rather than merging.
      await db.from("web_journeys").delete().eq("site", SITE);
    } else {
      const touched = await daysTouchedSince(db, job!.sync_started_at).catch(() => [] as string[]);
      const backlog = await findUnrolledDays(db, 40).catch(() => [] as string[]);
      pendingDays = uniqDesc([...touched, ...job!.extra_days, ...backlog, today]);
    }
    job = advance({ ...job!, sync_finished_at: nowIso(), pending_days: pendingDays });
    await save();
    return true;
  };

  // ---- rollup ---------------------------------------------------------------
  const rollupPhase = async (): Promise<boolean> => {
    const days = [...(job!.pending_days ?? [])];
    while (days.length && Date.now() < deadline) {
      const day = days[0];
      try {
        await rollupDay(db, day, { clearPages: job!.rebuild });
      } catch (e) {
        fail(`rollup ${day}: ${describe(e)}`);
      }
      days.shift();
      job = { ...job!, pending_days: days, days_done: job!.days_done + 1 };
      stats.days += 1;
      // One write per day, so a killed step loses one day's work at most.
      await save();
    }
    if (days.length) return false;

    try {
      const end = new Date();
      const start = new Date(end.getTime() - 29 * 86_400_000);
      await rollupJourneys(
        db,
        start.toISOString().slice(0, 10),
        end.toISOString().slice(0, 10),
      );
    } catch (e) {
      fail(`journeys: ${describe(e)}`);
    }
    job = advance(job!);
    await save();
    return true;
  };

  // ---- chats ----------------------------------------------------------------
  // Each conversation is one model call of up to 20s. A step does not start
  // one with less than eight seconds left unless the step has only just
  // begun — in which case it is the step's whole job and it goes ahead.
  const chatsPhase = async (): Promise<boolean> => {
    for (;;) {
      const remaining = deadline - Date.now();
      const fresh = Date.now() - started < 1_000;
      if (remaining < 8_000 && !fresh) return false;
      const limit = Math.max(1, Math.min(10, Math.floor(Math.max(remaining, 8_000) / 5_000)));
      let analysed: number;
      try {
        ({ analysed } = await analyseChatSessions(db, limit));
      } catch (e) {
        fail(`chat analysis: ${describe(e)}`);
        job = advance(job!);
        await save();
        return true;
      }
      job = { ...job!, chats: job!.chats + analysed };
      stats.chats += analysed;
      await save();
      if (analysed < limit) {
        job = advance(job!);
        await save();
        return true;
      }
    }
  };

  // ---- report ---------------------------------------------------------------
  // One model call of up to 20s on top of the stats queries. Deferred to a
  // fresh step rather than squeezed into the tail of a busy one.
  const reportPhase = async (): Promise<boolean> => {
    const fresh = Date.now() - started < 1_500;
    if (!fresh && deadline - Date.now() < 15_000) return false;
    if (job!.report) {
      try {
        const report = await generateWebReport(db, job!.report);
        job = { ...job!, report_id: report.id };
        stats.reportId = report.id;
      } catch (e) {
        fail(`report: ${describe(e)}`);
      }
    }
    job = advance(job!);
    await save();
    return true;
  };

  // ---- run phases until the deadline or the end --------------------------------
  try {
    while (job.phase !== "done" && Date.now() < deadline) {
      const progressed =
        job.phase === "sync"
          ? await syncPhase()
          : job.phase === "rollup"
            ? await rollupPhase()
            : job.phase === "chats"
              ? await chatsPhase()
              : await reportPhase();
      if (!progressed) break;
    }
  } catch (e) {
    // A phase that throws out of its own handling is recorded and skipped;
    // the alternative is a job that throws the same way every step.
    fail(`${job.phase}: ${describe(e)}`);
    job = advance(job);
  }

  // ---- close the step ----------------------------------------------------------
  job = endStep(job);
  if (job.phase === "done") {
    state = finishJob(state, job, nowIso(), syncIntervalMs());
    await stampPipeline(db, job).catch(() => undefined);
  } else {
    state = { ...state, job };
  }
  state = await saveState(db, state, { release: true });

  return {
    status: "stepped",
    done: state.job === null,
    summary: summarise(state, nowIso()),
    step: { ...stats, durationMs: Date.now() - started },
  };
}

/**
 * The automation tick's entry point: one bounded step, every tick, only
 * when there is something to do.
 *
 * Silent and cheap when idle — a single read — so it can sit in the ring
 * beside thirty other passes. A job starts on its own once the interval
 * has elapsed since the last one finished; the twice-daily schedule and
 * the Sync now button start one sooner. Either way, once a job exists this
 * is what finishes it: a step every five minutes until it is done.
 */
export async function processWebAnalytics(db: DB): Promise<StepResult | null> {
  if (!isWebsiteSourceConfigured()) return null;
  const state = await readState(db);
  const nowIso = new Date().toISOString();
  if (!state.job && !isDue(state, nowIso)) {
    const pending = await readRequest(db);
    if (!pending?.start) return null;
  }
  return runWebAnalyticsStep(db, { budgetMs: TICK_STEP_MS });
}
