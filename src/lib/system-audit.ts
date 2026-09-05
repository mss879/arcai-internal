import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, SystemEventAction } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * What the system did on its own (T5.3, 0121).
 *
 * `member_changes` (0081) records what a person changed, by trigger, and the
 * Team page shows it. Nothing recorded the writes nobody clicked for: the
 * invoice the tick raised, the post that went to Instagram, the review put on
 * the website, the slip filed from a WhatsApp photo, the payout run. When one
 * of those was wrong there was no line to point at.
 *
 * One function, called from each core after the write it describes. It is
 * best-effort by design — an audit line must never fail the write it is
 * about, and on a database without 0121 the insert simply does not land.
 */

export type SystemWriteInput = {
  /** The job or core: 'recurringIncome', 'socialPublish', 'payout'… */
  job: string;
  /** `system:<job>` (default) | `assistant` | `automation:<id>` | `user:<uuid>`. */
  actor?: string | null;
  table: string;
  rowId?: string | null;
  action: SystemEventAction;
  /** One line, in words: "Invoice #00231 raised for Hosting — September 2026". */
  summary: string;
  meta?: Record<string, unknown>;
};

export async function logSystemWrite(db: DB, input: SystemWriteInput): Promise<void> {
  try {
    await db.from("system_events").insert({
      job: input.job,
      actor: input.actor?.trim() || `system:${input.job}`,
      table_name: input.table,
      row_id: input.rowId ?? null,
      action: input.action,
      summary: input.summary.slice(0, 500),
      meta: input.meta ?? {},
    });
  } catch {
    // 0121 not applied, or the insert failed. The write it describes stands.
  }
}

export type SystemEventRow = Database["public"]["Tables"]["system_events"]["Row"];

/** The latest system writes, newest first. Empty on a database without 0121. */
export async function listSystemEvents(
  db: DB,
  opts: { limit?: number; since?: string | null } = {},
): Promise<SystemEventRow[]> {
  try {
    let q = db
      .from("system_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Math.min(500, Math.max(1, opts.limit ?? 200)));
    if (opts.since) q = q.gte("created_at", opts.since);
    const { data, error } = await q;
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}
