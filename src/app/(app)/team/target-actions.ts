"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import type { TargetKind } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/**
 * Setting what a month is supposed to look like (0119).
 *
 * Admin-only: a target somebody sets for themselves is a note, not a target.
 */

export type TargetInput = {
  /** null = the whole team. */
  userId: string | null;
  /** Any date in the month; stored as its first day. */
  period: string;
  kind: TargetKind;
  amount: number;
  note?: string | null;
};

export async function saveTargets(inputs: TargetInput[]): Promise<ActionResult> {
  const admin = await requireAdmin();
  const supabase = await createClient();

  const rows = inputs
    .filter((i) => Number.isFinite(i.amount))
    .map((i) => ({
      user_id: i.userId,
      period: `${i.period.slice(0, 7)}-01`,
      kind: i.kind,
      amount: Math.max(0, Number(i.amount)),
      note: i.note?.trim() || null,
      created_by: admin.id,
    }));
  if (!rows.length) return { ok: false, error: "Nothing to save." };

  // A target of zero is a removal — keeping it would show a permanent 0%.
  const toDelete = rows.filter((r) => r.amount === 0);
  const toKeep = rows.filter((r) => r.amount > 0);

  for (const row of toDelete) {
    let query = supabase
      .from("targets")
      .delete()
      .eq("period", row.period)
      .eq("kind", row.kind);
    query = row.user_id
      ? query.eq("user_id", row.user_id)
      : query.is("user_id", null);
    await query;
  }

  for (const row of toKeep) {
    // Upsert by hand: the unique index is partial (team targets have a NULL
    // user_id, and NULL never equals NULL), so onConflict can't express it.
    let existing = supabase
      .from("targets")
      .select("id")
      .eq("period", row.period)
      .eq("kind", row.kind);
    existing = row.user_id
      ? existing.eq("user_id", row.user_id)
      : existing.is("user_id", null);
    const { data: found } = await existing.maybeSingle();

    const { error } = found
      ? await supabase
          .from("targets")
          .update({ amount: row.amount, note: row.note })
          .eq("id", found.id)
      : await supabase.from("targets").insert(row);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath("/team");
  revalidatePath("/dashboard");
  revalidatePath("/intelligence");
  return { ok: true };
}
