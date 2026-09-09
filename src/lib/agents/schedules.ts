import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { logSystemWrite } from "@/lib/system-audit";

import { emitOfficeEvent } from "./events";
import { createMission } from "./manager";
import { nextRunAt } from "./office-core";

type DB = SupabaseClient<Database>;

const MAX_PER_PASS = 5;

/**
 * Timers (0130): open a mission when a schedule is due.
 *
 * The claim is a compare-and-set on `next_run_at` — the same shape as the
 * crawl scheduler in AI Projects — so two ticks can never open two missions
 * for one firing. A schedule whose previous mission is still running is
 * skipped (and says so in the feed) rather than stacked.
 */
export async function processOfficeSchedules(db: DB, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const { data: due } = await db
    .from("office_schedules")
    .select("*")
    .eq("is_active", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(MAX_PER_PASS);
  if (!due?.length) return 0;

  let fired = 0;
  for (const sched of due) {
    const next = nextRunAt(sched, nowIso);
    // Claim by advancing the clock first.
    const { data: claimed } = await db
      .from("office_schedules")
      .update({ next_run_at: next, last_run_at: nowIso })
      .eq("id", sched.id)
      .eq("next_run_at", sched.next_run_at as string)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    if (sched.last_mission_id) {
      const { data: prev } = await db
        .from("office_missions")
        .select("status, title")
        .eq("id", sched.last_mission_id)
        .maybeSingle();
      if (prev && ["planning", "running"].includes(prev.status)) {
        await emitOfficeEvent(db, {
          missionId: sched.last_mission_id,
          agentKey: "manager",
          kind: "schedule",
          message: `Timer “${sched.name}” skipped — “${prev.title}” is still running`,
          meta: { schedule_id: sched.id },
        });
        continue;
      }
    }

    const res = await createMission(db, {
      goal: sched.goal,
      mode: sched.mode,
      options: sched.options ?? {},
      clientId: sched.client_id,
      brandProfileId: sched.brand_profile_id,
      scheduleId: sched.id,
      createdBy: sched.created_by,
      agentKey: sched.agent_key,
      title: sched.name,
    });
    if (!res.ok) {
      await emitOfficeEvent(db, {
        agentKey: "manager",
        kind: "schedule",
        message: `Timer “${sched.name}” could not open a mission: ${res.error}`,
        meta: { schedule_id: sched.id },
      });
      continue;
    }
    fired += 1;
    await db.from("office_schedules").update({ last_mission_id: res.mission.id }).eq("id", sched.id);
    await emitOfficeEvent(db, {
      missionId: res.mission.id,
      agentKey: "manager",
      kind: "schedule",
      message: `Timer “${sched.name}” opened a mission`,
      meta: { schedule_id: sched.id, next_run_at: next },
    });
    await logSystemWrite(db, {
      job: "contentOffice",
      table: "office_schedules",
      rowId: sched.id,
      action: "created",
      summary: `Timer "${sched.name}" opened mission ${res.mission.id}`,
    });
  }
  return fired;
}
