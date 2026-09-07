import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";

import { colomboDay, daysAgo } from "./time-core";
import { rollupDay } from "./usage";

type DB = SupabaseClient<Database>;

/**
 * The `aiRollup` tick pass (0126): recompute today's and yesterday's
 * rollups for every live project, every fifteen minutes. Each chat turn
 * already rolls its own day up; this is the self-heal for turns that were
 * cut off before they could, and for the day boundary. Gated by a stamp in
 * `app_settings`, claimed before the work.
 */

const STAMP_KEY = "ai_rollup";
const INTERVAL_MS = 15 * 60_000;
const MAX_PROJECTS = 100;

export type AiRollupResult = { skipped: boolean; projects: number; days: number };

export async function processAiRollup(db: DB, now = new Date()): Promise<AiRollupResult> {
  const result: AiRollupResult = { skipped: true, projects: 0, days: 0 };
  try {
    const { data: stamp } = await db.from("app_settings").select("value").eq("key", STAMP_KEY).maybeSingle();
    const last = Date.parse(String((stamp?.value as { at?: string } | null)?.at ?? "")) || 0;
    if (now.getTime() - last < INTERVAL_MS) return result;
    await db
      .from("app_settings")
      .upsert({ key: STAMP_KEY, value: { at: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: "key" });
    result.skipped = false;

    const { data: projects } = await db
      .from("ai_projects")
      .select("id")
      .neq("status", "archived")
      .limit(MAX_PROJECTS);
    const today = colomboDay(now);
    const yesterday = daysAgo(today, 1);
    for (const project of projects ?? []) {
      await rollupDay(db, project.id, today);
      await rollupDay(db, project.id, yesterday);
      result.projects += 1;
      result.days += 2;
    }
  } catch (e) {
    await captureError(e, { source: "tick", path: "ai/rollup-pass" });
  }
  return result;
}
