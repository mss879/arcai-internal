import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Starting `position` for one or more brand-new leads so they land at the TOP
 * of their stage column.
 *
 * The board renders each column sorted by `position` ascending, so the top
 * card is the one with the smallest position. Rather than shifting every
 * existing row down (an update across the whole column), we slot the new
 * lead(s) just below the current minimum — cheap, touches no existing rows,
 * and the next drag renumbers the column back to 0..N anyway.
 *
 * Assign the returned value to the first new lead and increment for each
 * subsequent one; the whole batch then sits above every existing card, in
 * insertion order.
 *
 * @param count how many leads are being inserted (default 1)
 */
export async function topLeadPosition(
  supabase: DB,
  stageId: string | null,
  count = 1,
): Promise<number> {
  if (!stageId) return 0;
  const { data } = await supabase
    .from("leads")
    .select("position")
    .eq("stage_id", stageId)
    .is("deleted_at", null)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  // Empty column → start at 0. Otherwise sit `count` steps below the current
  // top so the batch (start, start+1, …) stays entirely above it.
  if (data == null) return 0;
  return data.position - count;
}

/**
 * Move a lead FORWARD to a pipeline stage matched by name — the shared
 * "the conversation progressed" helper for automated flows (WhatsApp agent,
 * cold outreach).
 *
 * - `stageNames` are tried in order, case-insensitively, against the lead's
 *   own pipeline, so it works with renamed/custom stages.
 * - Forward-only: a lead is never demoted — if the team already dragged it
 *   further right, this is a no-op. Won/lost/trashed leads are left alone.
 * - The DB trigger logs the stage_changed activity itself; `reason` adds one
 *   human-readable line explaining WHY the agent moved it.
 */
export async function moveLeadToStageByName(
  supabase: DB,
  leadId: string,
  stageNames: string[],
  reason?: string,
): Promise<{ moved: boolean; stageName?: string }> {
  const { data: lead } = await supabase
    .from("leads")
    .select("id, stage_id, pipeline_id, status, deleted_at")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead || lead.deleted_at || lead.status !== "open") return { moved: false };

  const { data: stages } = await supabase
    .from("pipeline_stages")
    .select("id, name, position")
    .eq("pipeline_id", lead.pipeline_id)
    .order("position", { ascending: true });
  if (!stages?.length) return { moved: false };

  const wanted = stageNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const target = wanted
    .map((w) => stages.find((s) => s.name.trim().toLowerCase() === w))
    .find(Boolean);
  if (!target) return { moved: false };

  const current = stages.find((s) => s.id === lead.stage_id);
  // Already there or further along — leave the board as the team set it.
  if (current && current.position >= target.position) return { moved: false };
  if (lead.stage_id === target.id) return { moved: false };

  let query = supabase
    .from("leads")
    .update({
      stage_id: target.id,
      // Land at the top of the new column, like any fresh arrival.
      position: await topLeadPosition(supabase, target.id),
    })
    .eq("id", leadId);
  // Fenced on the stage we read — if a human dragged it mid-flight, skip.
  query = lead.stage_id
    ? query.eq("stage_id", lead.stage_id)
    : query.is("stage_id", null);
  const { error } = await query;
  if (error) return { moved: false };

  if (reason) {
    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      kind: "automation",
      title: `Moved to ${target.name}`,
      body: reason,
      actor_id: null,
    });
  }
  return { moved: true, stageName: target.name };
}
