"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, WebLeadStatus } from "@/lib/types";
import { generateWebReport, analyseChatSessions } from "@/lib/web-analytics/report";
import {
  checkInsightProgress as runProgressCheck,
  pollInsightScan,
  startInsightScan,
  type ProgressCheckResult,
  type ScanPoll,
} from "@/lib/web-analytics/insights";
import { setLedgerStatus } from "@/lib/web-analytics/ledger";
import { rebuildWebAnalytics } from "@/lib/web-analytics/rebuild";
import { rollupDay } from "@/lib/web-analytics/rollup";
import { FULL_STEP_MS, runWebAnalyticsStep, type StepResult } from "@/lib/web-analytics/run";
import { pingWebsiteSource } from "@/lib/web-analytics/source";

/**
 * Everything the Web Analytics page can trigger by hand.
 *
 * All of it also happens on a schedule — these exist for the moments when
 * waiting for the next tick is the wrong answer: right after wiring the
 * credentials up, or when a report is needed for a meeting in ten minutes.
 *
 * Writes go through the service-role client because the pipeline upserts
 * into tables whose RLS only grants `authenticated` a read. `requireAdmin`
 * runs first, so the privilege is bounded by who is asking, not by the
 * client that carries it out.
 */

/** What one step of the job looked like, for the page to show and to decide whether to call again. */
export type SyncStepView = {
  /** No job is active any more — nothing left to continue. */
  done: boolean;
  status: StepResult["status"];
  phase: string | null;
  rows: number;
  days: number;
  chats: number;
  daysLeft: number;
  errors: string[];
};

const NOT_CONFIGURED =
  "Website source not configured — add WEBSITE_SUPABASE_URL and " +
  "WEBSITE_SUPABASE_SERVICE_ROLE_KEY to the environment.";

function stepView(result: StepResult): SyncStepView {
  return {
    done: result.done,
    status: result.status,
    phase: result.summary.phase,
    rows: result.step?.rows ?? 0,
    days: result.step?.days ?? 0,
    chats: result.step?.chats ?? 0,
    daysLeft: result.summary.days_left,
    errors: result.step?.errors ?? [],
  };
}

/**
 * Pull now: start a sync job (or join the one running) and do its first
 * bounded step — sync, roll up, label new conversations.
 *
 * One step is all a serverless call can safely do, so this returns with
 * `done: false` when there is more to do. The page then calls
 * `continueSync` until it is finished; if the page is closed instead, the
 * automation tick finishes the job on its own within a few ticks.
 */
export async function syncNow(): Promise<ActionResult<SyncStepView>> {
  await requireAdmin();
  try {
    const result = await runWebAnalyticsStep(createAdminClient(), {
      budgetMs: FULL_STEP_MS,
      request: { start: true, analyse_chats: true },
    });
    if (result.status === "unconfigured") return { ok: false, error: NOT_CONFIGURED };
    revalidatePath("/web-analytics");
    return { ok: true, ...stepView(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Sync failed." };
  }
}

/** One more bounded step of whatever job is running. Idle if there is none. */
export async function continueSync(): Promise<ActionResult<SyncStepView>> {
  await requireAdmin();
  try {
    const result = await runWebAnalyticsStep(createAdminClient(), { budgetMs: FULL_STEP_MS });
    if (result.status === "unconfigured") return { ok: false, error: NOT_CONFIGURED };
    revalidatePath("/web-analytics");
    return { ok: true, ...stepView(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Sync failed." };
  }
}

/**
 * Re-read everything and recompute it, ignoring both watermarks.
 *
 * `syncNow` is the incremental path: it pulls what has arrived since the
 * last run and rolls up the days that changed. That is the right default
 * and it is useless after a bug fix, because the rows the fix was written
 * for are behind the cursor and the days they belong to already have a
 * rollup. Pressing "Sync now" then reports a cheerful success and changes
 * nothing, which is exactly how a shipped fix comes to look like no fix.
 *
 * This is the other button: wind the cursors back, re-mirror the source
 * through the current mapping, and recompute every day in the window
 * whether or not anything about it changed. It opens a rebuild job and does
 * its first step; the page keeps stepping with `continueSync`.
 */
export async function rebuildNow(days: number): Promise<ActionResult<SyncStepView>> {
  await requireAdmin();
  try {
    const result = await rebuildWebAnalytics(createAdminClient(), { days });
    if (result.skipped) return { ok: false, error: result.skipped };
    if (result.status === "busy") {
      return {
        ok: false,
        error: "A sync step is running right now — try again in a minute.",
      };
    }
    revalidatePath("/web-analytics");
    return { ok: true, ...stepView(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Rebuild failed." };
  }
}

/** Write a report over the last day / week / month / quarter. */
export async function generateReport(
  kind: "daily" | "weekly" | "monthly" | "quarterly",
): Promise<ActionResult<{ id: string; usedAi: boolean }>> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  try {
    const report = await generateWebReport(createAdminClient(), kind, {
      createdBy: user?.id ?? null,
    });
    revalidatePath("/web-analytics");
    return { ok: true, id: report.id, usedAi: report.usedAi };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Report failed." };
  }
}

/** Read and label the website agent's newest unread conversations. */
export async function analyseChats(): Promise<ActionResult<{ analysed: number }>> {
  await requireAdmin();
  try {
    const { analysed } = await analyseChatSessions(createAdminClient(), 25);
    revalidatePath("/web-analytics");
    return { ok: true, analysed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Analysis failed." };
  }
}

/** Is the website's Supabase project reachable with the key we hold? */
export async function testConnection(): Promise<
  ActionResult<{ sessions: number }>
> {
  await requireAdmin();
  const result = await pingWebsiteSource();
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, sessions: result.sessions };
}

export async function deleteReport(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("web_reports").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/web-analytics");
  return { ok: true };
}

/**
 * Read every metric available and have a reasoning model say what it means.
 *
 * Starts the scan and returns at once: the model runs in the background at
 * OpenAI (a high-effort read takes minutes, and a serverless call here is
 * cut off at ~26 seconds). The page polls `pollScan` until it lands; if the
 * page is closed, the automation tick stores it instead.
 */
export async function scanInsights(
  days: number,
): Promise<ActionResult<{ started_at: string }>> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const result = await startInsightScan(createAdminClient(), {
    days,
    createdBy: user?.id ?? null,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, started_at: result.started_at };
}

/** Is the scan done yet? Stores it the moment it is. */
export async function pollScan(): Promise<ScanPoll> {
  await requireAdmin();
  const result = await pollInsightScan(createAdminClient());
  if (result.state === "complete" || result.state === "failed") {
    revalidatePath("/web-analytics");
  }
  return result;
}

/** Tick an improvement off — or untick it. */
export async function toggleInsightTask(
  id: string,
  done: boolean,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from("web_insight_tasks")
    .update({
      done,
      done_at: done ? new Date().toISOString() : null,
      done_by: done ? (user?.id ?? null) : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/web-analytics");
  return { ok: true };
}

/**
 * Take an item off the list without marking it done.
 *
 * Kept rather than deleted so a re-scan does not put it straight back —
 * "we are not doing this" is a decision, and it should stick.
 */
export async function dismissInsightTask(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase
    .from("web_insight_tasks")
    .update({ dismissed: true })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/web-analytics");
  return { ok: true };
}

/**
 * 0117 — send web-insight items to To-Dos.
 *
 * The AI scan produced a good checklist that lived on its own page, so it was
 * read once and forgotten while the actual work queue sat somewhere else.
 * These become real to-dos, and the two stay in step: finishing either one
 * finishes the other (see setTodoStatus).
 */
/** Insight priority → to-do priority. */
const TODO_PRIORITY: Record<string, "low" | "medium" | "high" | "urgent"> = {
  critical: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
};

export async function sendInsightToTodos(
  ids: string[],
): Promise<ActionResult<{ created: number }>> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const wanted = [...new Set(ids.filter(Boolean))].slice(0, 50);
  if (!wanted.length) return { ok: false, error: "Nothing selected." };

  const { data: tasks } = await supabase
    .from("web_insight_tasks")
    .select("id, title, detail, area, priority, todo_id, done")
    .in("id", wanted);
  if (!tasks?.length) return { ok: false, error: "Those items no longer exist." };

  let created = 0;
  for (const task of tasks) {
    // Already sent, or already done — sending it again would just make a
    // duplicate for somebody to close.
    if (task.todo_id || task.done) continue;

    const { data: todo, error } = await supabase
      .from("todos")
      .insert({
        title: task.title,
        description: [task.detail, `From the website scan · ${task.area}`]
          .filter(Boolean)
          .join("\n\n"),
        // The two scales don't line up: an insight can be "critical", a
        // to-do's top rung is "urgent". Mapped rather than cast, so a
        // critical finding doesn't quietly become a medium one.
        priority: TODO_PRIORITY[task.priority] ?? "medium",
        status: "todo" as const,
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error || !todo) continue;

    await supabase
      .from("web_insight_tasks")
      .update({ todo_id: todo.id })
      .eq("id", task.id);
    created += 1;
  }

  revalidatePath("/web-analytics");
  revalidatePath("/todos");
  return { ok: true, created };
}

/**
 * 0125 — a person's verdict on a lead-ledger row: lead, spam, test, or back
 * to needs-review. Final — the ledger's rules never overwrite it.
 *
 * The day's rollup reads its conversion count from the ledger, so it is
 * stale the moment a verdict changes; that one day is recomputed here so the
 * totals and the funnel move with the decision rather than on the next sync.
 */
export async function setWebLeadStatus(
  id: string,
  status: WebLeadStatus,
): Promise<ActionResult<{ day: string }>> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const admin = createAdminClient();
  const result = await setLedgerStatus(admin, id, status, user?.id ?? null);
  if (!result.ok) return { ok: false, error: result.error };
  await rollupDay(admin, result.day).catch(() => undefined);
  revalidatePath("/web-analytics");
  return { ok: true, day: result.day };
}

/**
 * 0125 — read the current numbers against every open checklist item and
 * tick off the ones the data shows are done. One request on the chat model,
 * meant to be pressed before a re-scan so the list can be trusted first.
 */
export async function checkInsightProgress(
  days: number,
): Promise<ActionResult<ProgressCheckResult>> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  try {
    const result = await runProgressCheck(createAdminClient(), {
      days,
      userId: user?.id ?? null,
    });
    revalidatePath("/web-analytics");
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The check failed." };
  }
}
