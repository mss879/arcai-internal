"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { generateWebReport, analyseChatSessions } from "@/lib/web-analytics/report";
import { runInsightScan } from "@/lib/web-analytics/insights";
import { rebuildWebAnalytics } from "@/lib/web-analytics/rebuild";
import { runWebAnalyticsPipeline } from "@/lib/web-analytics/run";
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

/** Pull now: sync, roll up, and label any new conversations. */
export async function syncNow(): Promise<
  ActionResult<{ rows: number; days: number; errors: string[] }>
> {
  await requireAdmin();
  try {
    const result = await runWebAnalyticsPipeline(createAdminClient(), {
      analyseChats: true,
    });
    if (result.skipped) return { ok: false, error: result.skipped };
    revalidatePath("/web-analytics");
    return {
      ok: true,
      rows: result.sync?.totalRows ?? 0,
      days: result.daysRolledUp,
      errors: result.errors,
    };
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
 * whether or not anything about it changed.
 */
export async function rebuildNow(
  days: number,
): Promise<
  ActionResult<{ rows: number; days: number; incomplete: boolean; errors: string[] }>
> {
  await requireAdmin();
  try {
    const result = await rebuildWebAnalytics(createAdminClient(), { days });
    if (result.skipped) return { ok: false, error: result.skipped };
    revalidatePath("/web-analytics");
    return {
      ok: true,
      rows: result.rowsPulled,
      days: result.daysRebuilt,
      incomplete: result.incomplete,
      errors: result.errors,
    };
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
 * Slow on purpose — it runs a high-effort model over the whole export, so
 * the caller shows a working state rather than expecting this back quickly.
 */
export async function scanInsights(
  days: number,
): Promise<ActionResult<{ id: string }>> {
  await requireAdmin();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const result = await runInsightScan(createAdminClient(), {
    days,
    createdBy: user?.id ?? null,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/web-analytics");
  return { ok: true, id: result.id };
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
