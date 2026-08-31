"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { generateWebReport, analyseChatSessions } from "@/lib/web-analytics/report";
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
