import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, OfficeEventKind } from "@/lib/database.types";

import { clampMeta } from "./office-core";

type DB = SupabaseClient<Database>;

export type OfficeEventInput = {
  missionId?: string | null;
  taskId?: string | null;
  agentKey: string;
  kind: OfficeEventKind;
  message: string;
  meta?: Record<string, unknown>;
};

/**
 * One line in the office's live feed (0130). Best-effort: a feed line must
 * never fail the work it describes. The floor animates from these rows, so
 * `kind` is chosen for what a robot should visibly do, not for logging.
 */
export async function emitOfficeEvent(db: DB, input: OfficeEventInput): Promise<void> {
  try {
    await db.from("office_events").insert({
      mission_id: input.missionId ?? null,
      task_id: input.taskId ?? null,
      agent_key: input.agentKey,
      kind: input.kind,
      message: input.message.slice(0, 500),
      meta: clampMeta(input.meta),
    });
  } catch {
    // 0130 not applied, or a transient insert failure. The work stands.
  }
}
