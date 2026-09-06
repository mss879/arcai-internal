/**
 * The web-analytics job, as pure state.
 *
 * Everything here is deliberately free of I/O so it can be tested, and so
 * the persistence layer in `run.ts` stays a thin read/modify/write around
 * it. The shape it describes is the answer to one hard constraint: the CRM
 * runs on serverless functions that are killed at roughly 26 seconds, and
 * a pull that re-reads a year of history, rebuilds a hundred chat
 * transcripts and recomputes ninety days of rollups does not fit in one.
 * So the pipeline is a job that advances in bounded STEPS, each of which
 * persists where it got to before it returns — and a step that is killed
 * mid-way loses only that step's work, never the job.
 */

export type JobPhase = "sync" | "rollup" | "chats" | "report" | "done";

export type ReportKind = "daily" | "weekly" | "monthly";

export type ActiveJob = {
  started_at: string;
  phase: JobPhase;
  /** Every row this job mirrors carries `synced_at >= sync_started_at`. */
  sync_started_at: string;
  sync_finished_at: string | null;
  /** True once the cutover was read and the post-cutover prune ran. */
  prepared: boolean;
  cutover: string | null;
  report: ReportKind | null;
  analyse_chats: boolean;
  rebuild: boolean;
  /** Days still to roll up, newest first. Null until the rollup phase begins. */
  pending_days: string[] | null;
  /** Days the prune disturbed — rolled up whether or not the sync touched them. */
  extra_days: string[];
  /** Streams that threw during this job; not retried until the next job. */
  failed_streams: string[];
  steps: number;
  /** Steps that started in the current phase and never finished — the kill counter. */
  killed: number;
  rows: number;
  days_done: number;
  chats: number;
  report_id: string | null;
  errors: string[];
};

export type LastRun = {
  started_at: string;
  finished_at: string;
  ok: boolean;
  rows: number;
  days: number;
  chats: number;
  report_id: string | null;
  errors: string[];
  steps: number;
  rebuild: boolean;
};

export type JobState = {
  /** Bumped on every write; the lease is taken with a compare-and-set on it. */
  version: number;
  /** Held while a step is running. A step that dies leaves it to expire. */
  lease_until: string | null;
  job: ActiveJob | null;
  /** When the next automatic job may start. Null means "as soon as possible". */
  next_due_at: string | null;
  last: LastRun | null;
};

/** What a caller can ask for. Stored separately so it survives a held lease. */
export type JobRequest = {
  /** Start a job now even if the schedule says it is not due. */
  start?: boolean;
  report?: ReportKind | null;
  analyse_chats?: boolean;
  requested_at?: string;
};

/** After this many consecutive killed steps, the phase is abandoned. */
export const MAX_KILLED_STEPS = 3;

const PHASES: JobPhase[] = ["sync", "rollup", "chats", "report", "done"];

const phaseIndex = (p: JobPhase): number => PHASES.indexOf(p);

export function emptyState(): JobState {
  return { version: 0, lease_until: null, job: null, next_due_at: null, last: null };
}

/**
 * Read whatever was stored back into a well-formed state.
 *
 * Tolerant on purpose: a row written by an older build, or hand-edited, must
 * come back as a usable state rather than throw inside the tick.
 */
export function coerceState(raw: unknown): JobState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const job = r.job && typeof r.job === "object" ? (r.job as ActiveJob) : null;
  return {
    version: Number.isFinite(Number(r.version)) ? Number(r.version) : 0,
    lease_until: typeof r.lease_until === "string" ? r.lease_until : null,
    job: job && PHASES.includes(job.phase) ? { ...defaultJobFields(), ...job } : null,
    next_due_at: typeof r.next_due_at === "string" ? r.next_due_at : null,
    last: r.last && typeof r.last === "object" ? (r.last as LastRun) : null,
  };
}

function defaultJobFields(): Omit<ActiveJob, "started_at" | "phase" | "sync_started_at"> {
  return {
    sync_finished_at: null,
    prepared: false,
    cutover: null,
    report: null,
    analyse_chats: false,
    rebuild: false,
    pending_days: null,
    extra_days: [],
    failed_streams: [],
    steps: 0,
    killed: 0,
    rows: 0,
    days_done: 0,
    chats: 0,
    report_id: null,
    errors: [],
  };
}

/** Is the lease free (never taken, or expired) at this instant? */
export function leaseIsFree(state: JobState, nowIso: string): boolean {
  return !state.lease_until || state.lease_until < nowIso;
}

/** Should a new job start on its own, with nobody asking? */
export function isDue(state: JobState, nowIso: string): boolean {
  if (state.job) return false;
  return !state.next_due_at || state.next_due_at <= nowIso;
}

export function openJob(
  req: JobRequest,
  nowIso: string,
  opts: { rebuild?: { days: string[] } } = {},
): ActiveJob {
  return {
    ...defaultJobFields(),
    started_at: nowIso,
    phase: "sync",
    sync_started_at: nowIso,
    report: req.report ?? null,
    analyse_chats: Boolean(req.analyse_chats),
    rebuild: Boolean(opts.rebuild),
    // A rebuild knows its window up front; an ordinary job derives its days
    // from what the sync actually touched, once the sync is done.
    pending_days: opts.rebuild ? [...opts.rebuild.days] : null,
  };
}

/**
 * Fold a request into a running job.
 *
 * A request for a report or chat labelling can only be honoured if the job
 * has not already gone past that phase. If it has, the request is left
 * pending — `consumed: false` — so the next job picks it up instead of it
 * being silently dropped.
 */
export function mergeRequest(job: ActiveJob, req: JobRequest): { job: ActiveJob; consumed: boolean } {
  const wantsReport = Boolean(req.report);
  const wantsChats = Boolean(req.analyse_chats);
  if (!wantsReport && !wantsChats) return { job, consumed: true };

  const reportOk = !wantsReport || phaseIndex(job.phase) <= phaseIndex("report");
  const chatsOk = !wantsChats || phaseIndex(job.phase) <= phaseIndex("chats");
  if (!reportOk || !chatsOk) return { job, consumed: false };

  return {
    consumed: true,
    job: {
      ...job,
      report: wantsReport ? (req.report ?? null) : job.report,
      analyse_chats: job.analyse_chats || wantsChats,
    },
  };
}

/** The phase after this one, skipping the optional ones that were not asked for. */
export function nextPhase(job: ActiveJob): JobPhase {
  switch (job.phase) {
    case "sync":
      return "rollup";
    case "rollup":
      return job.analyse_chats ? "chats" : job.report ? "report" : "done";
    case "chats":
      return job.report ? "report" : "done";
    case "report":
      return "done";
    default:
      return "done";
  }
}

export function advance(job: ActiveJob): ActiveJob {
  return { ...job, phase: nextPhase(job), killed: 0 };
}

/**
 * Mark a step as started.
 *
 * `killed` is bumped BEFORE any work and reset only when a step returns
 * normally, so a step the platform kills leaves the count one higher. Three
 * in a row and the phase is abandoned with a recorded error: the alternative
 * is a job that is retried every five minutes forever, which is exactly the
 * failure this whole design exists to end.
 */
export function beginStep(job: ActiveJob): { job: ActiveJob; abandonedPhase: JobPhase | null } {
  if (job.killed >= MAX_KILLED_STEPS) {
    const abandoned = job.phase;
    const next = advance({
      ...job,
      errors: [
        ...job.errors,
        `${abandoned}: abandoned after ${job.killed} steps were cut off by the platform time limit`,
      ],
    });
    return { job: { ...next, steps: next.steps + 1, killed: 1 }, abandonedPhase: abandoned };
  }
  return { job: { ...job, steps: job.steps + 1, killed: job.killed + 1 }, abandonedPhase: null };
}

export function endStep(job: ActiveJob): ActiveJob {
  return { ...job, killed: 0 };
}

export function finishJob(state: JobState, job: ActiveJob, nowIso: string, intervalMs: number): JobState {
  const last: LastRun = {
    started_at: job.started_at,
    finished_at: nowIso,
    ok: job.errors.length === 0,
    rows: job.rows,
    days: job.days_done,
    chats: job.chats,
    report_id: job.report_id,
    errors: job.errors.slice(0, 20),
    steps: job.steps,
    rebuild: job.rebuild,
  };
  return {
    ...state,
    job: null,
    last,
    next_due_at: new Date(new Date(nowIso).getTime() + intervalMs).toISOString(),
  };
}

// ── cursor arithmetic shared by the streams ─────────────────────────────────

/**
 * Where a `>=` timestamp cursor goes after a page.
 *
 * `>=` rather than `>` because two rows can share a millisecond and `>`
 * would skip the second forever. The cost is re-reading the tied rows on
 * the next page — harmless, every write is an upsert — except in one case:
 * a FULL page whose rows all share one timestamp would be re-read forever.
 * Nudging past it then costs at most those tied rows.
 */
export function nudgeCursor(last: string, since: string, pageFull: boolean): string {
  return last === since && pageFull
    ? new Date(new Date(last).getTime() + 1).toISOString()
    : last;
}

/**
 * Drop rows read twice across page boundaries.
 *
 * A `>=` cursor re-reads the last row of every page at the top of the next.
 * That is fine when each page is upserted on its own, and fatal when the
 * pages are assembled into one batch: Postgres refuses an upsert whose
 * batch touches the same key twice ("ON CONFLICT DO UPDATE command cannot
 * affect row a second time"), and refuses the whole batch — which is how
 * the legacy page-visit history came to fail on every single run.
 */
export function dedupeById<T extends { id?: unknown }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = String(row.id ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Where the chat cursor goes after a step that rebuilt only SOME of the
 * conversations on the page.
 *
 * Conversations are processed in order of first appearance. If the deadline
 * cut the list short, the cursor moves to the first message of the first
 * conversation NOT processed, so the next step starts exactly there — some
 * already-rebuilt conversations may reappear and be rebuilt again, which is
 * idempotent, but nothing is skipped and the cursor strictly advances.
 */
export function chatCursorAfter(input: {
  since: string;
  order: string[];
  firstAt: Map<string, string>;
  processed: number;
  lastCreatedAt: string;
  pageFull: boolean;
}): { since: string; exhausted: boolean } {
  const { since, order, firstAt, processed, lastCreatedAt, pageFull } = input;
  if (processed >= order.length) {
    return { since: nudgeCursor(lastCreatedAt, since, pageFull), exhausted: !pageFull };
  }
  const next = firstAt.get(order[processed]) ?? since;
  return { since: next < since ? since : next, exhausted: false };
}

/** Every UTC day in a window, newest first. */
export function daysInWindow(days: number, now = new Date(), cap = 180): string[] {
  const capped = Math.min(cap, Math.max(1, Math.round(days)));
  const out: string[] = [];
  for (let i = 0; i < capped; i++) {
    out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** A compact, serialisable picture of the job for the page and the API. */
export type JobSummary = {
  running: boolean;
  /** A step is executing right now (the lease is held). */
  stepping: boolean;
  phase: JobPhase | null;
  started_at: string | null;
  steps: number;
  rows: number;
  days_done: number;
  days_left: number;
  chats: number;
  rebuild: boolean;
  errors: string[];
  next_due_at: string | null;
  last: LastRun | null;
};

export function summarise(state: JobState, nowIso: string): JobSummary {
  const job = state.job;
  return {
    running: Boolean(job),
    stepping: !leaseIsFree(state, nowIso),
    phase: job?.phase ?? null,
    started_at: job?.started_at ?? null,
    steps: job?.steps ?? 0,
    rows: job?.rows ?? 0,
    days_done: job?.days_done ?? 0,
    days_left: job?.pending_days?.length ?? 0,
    chats: job?.chats ?? 0,
    rebuild: job?.rebuild ?? false,
    errors: job?.errors ?? [],
    next_due_at: state.next_due_at,
    last: state.last,
  };
}
