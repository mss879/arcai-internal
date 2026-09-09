import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isOpenAIConfigured } from "@/lib/ai/openai";
import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";

import { EVENT_RETENTION_DAYS } from "./office-core";
import { runOfficeStep } from "./runtime";

type DB = SupabaseClient<Database>;

/** The pass's own budget inside the shared tick. Background responses mean
 * it never awaits a model; this covers a couple of polls and a start. */
const TICK_BUDGET_MS = Number(process.env.OFFICE_TICK_BUDGET_MS) || 6_000;
const JANITOR_KEY = "office_janitor";
const JANITOR_EVERY_MS = 6 * 60 * 60_000;

/**
 * The `contentOffice` pass on the automation tick (0130).
 *
 * One cheap read when idle; otherwise a bounded `runOfficeStep`. Unattended
 * missions advance one step per five minutes this way; the open page drives
 * them every few seconds through the same function.
 */
export async function processContentOffice(db: DB): Promise<Record<string, unknown>> {
  if (!isOpenAIConfigured()) return { skipped: "OPENAI_API_KEY unset" };
  try {
    const nowIso = new Date().toISOString();
    const [{ data: work }, { data: due }] = await Promise.all([
      db.from("office_tasks").select("id").in("status", ["ready", "running", "queued"]).limit(1),
      db
        .from("office_schedules")
        .select("id")
        .eq("is_active", true)
        .not("next_run_at", "is", null)
        .lte("next_run_at", nowIso)
        .limit(1),
    ]);
    if (!work?.length && !due?.length) {
      await janitor(db);
      return { idle: true };
    }
    const summary = await runOfficeStep(db, { budgetMs: TICK_BUDGET_MS });
    return { ...summary };
  } catch (e) {
    await captureError(e, { source: "tick", path: "contentOffice" });
    return { ok: false, error: (e as Error).message };
  }
}

/** Trim the feed every few hours; the stamp lives in app_settings. */
async function janitor(db: DB): Promise<void> {
  try {
    const { data } = await db.from("app_settings").select("value").eq("key", JANITOR_KEY).maybeSingle();
    const last = Number((data?.value as Record<string, unknown> | null)?.ran_at ?? 0);
    if (Date.now() - last < JANITOR_EVERY_MS) return;
    await db
      .from("app_settings")
      .upsert({ key: JANITOR_KEY, value: { ran_at: Date.now() }, updated_at: new Date().toISOString() });
    const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
    const { data: old } = await db.from("office_events").select("id").lt("created_at", cutoff).order("id").limit(500);
    if (old?.length) {
      await db
        .from("office_events")
        .delete()
        .in(
          "id",
          old.map((e) => e.id),
        );
    }
  } catch {
    // Housekeeping only.
  }
}
