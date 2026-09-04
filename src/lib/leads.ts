import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { markReferralWon } from "@/lib/referrals";

type DB = SupabaseClient<Database>;

/**
 * Closing a lead (0112).
 *
 * `setLeadStatus(id, "won")` stamped the outcome and nothing else; the card
 * stayed in whatever column it was in and the signed quote never told the
 * pipeline anything. This is the one place a lead is marked won: the status
 * and the stamp, plus a best-effort move to the pipeline's "Won" stage —
 * stages are free-text rows (0009), so the match is by name and simply
 * skipped when the pipeline has no such column.
 */
export async function markLeadWon(
  supabase: DB,
  leadId: string,
): Promise<{ ok: true; movedToStage: boolean } | { ok: false; error: string }> {
  const { data: lead } = await supabase
    .from("leads")
    .select("id, pipeline_id, stage_id, status")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "Lead not found." };

  let wonStageId: string | null = null;
  if (lead.pipeline_id) {
    const { data: stage } = await supabase
      .from("pipeline_stages")
      .select("id")
      .eq("pipeline_id", lead.pipeline_id)
      .ilike("name", "won")
      .limit(1)
      .maybeSingle();
    wonStageId = stage?.id ?? null;
  }

  const { error } = await supabase
    .from("leads")
    .update({
      status: "won",
      won_at: new Date().toISOString(),
      lost_at: null,
      lost_reason: null,
      ...(wonStageId && wonStageId !== lead.stage_id ? { stage_id: wonStageId } : {}),
    })
    .eq("id", leadId);
  if (error) return { ok: false, error: error.message };

  // 0117 — if somebody introduced them, credit the introduction now. Never
  // throws: winning the lead is what matters, the credit is bookkeeping.
  await markReferralWon(supabase, leadId);

  return { ok: true, movedToStage: Boolean(wonStageId && wonStageId !== lead.stage_id) };
}
