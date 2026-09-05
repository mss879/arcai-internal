"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import type { TargetKind } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { upsertTarget } from "@/lib/targets";
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

  const rows = inputs.filter((i) => Number.isFinite(i.amount));
  if (!rows.length) return { ok: false, error: "Nothing to save." };

  // One writer for targets (upsertTarget), so the assistant's set_target and
  // this modal can never disagree about what a zero means.
  for (const row of rows) {
    const res = await upsertTarget(supabase, {
      userId: row.userId,
      period: row.period,
      kind: row.kind,
      amount: row.amount,
      note: row.note,
      createdBy: admin.id,
    });
    if (!res.ok) return res;
  }

  revalidatePath("/team");
  revalidatePath("/dashboard");
  revalidatePath("/intelligence");
  return { ok: true };
}
