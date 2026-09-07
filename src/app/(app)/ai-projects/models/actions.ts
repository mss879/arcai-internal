"use server";

import { revalidatePath } from "next/cache";

import { invalidatePriceCatalog } from "@/lib/ai-projects/usage";
import { addDays, isDay } from "@/lib/ai-projects/time-core";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, AiModelKind } from "@/lib/types";

/**
 * The price catalog's actions (0126).
 *
 * Prices are never edited in place: a new price is a new effective-dated
 * row, and the previous open-ended row for that model is closed the day
 * before, so every usage row ever written still points at the price it was
 * costed with.
 */

export type ModelPriceInput = {
  model: string;
  kind: AiModelKind;
  label: string;
  inputPerM: number;
  cachedPerM: number;
  outputPerM: number;
  effectiveFrom: string;
  effectiveTo: string;
  note: string;
};

function money(n: unknown, what: string): number | string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return `${what} must be a number of at least 0.`;
  return Math.round(v * 1e6) / 1e6;
}

export async function addModelPrice(input: ModelPriceInput): Promise<ActionResult<{ closedPrevious: boolean }>> {
  await requireAdmin();
  const supabase = await createClient();

  const model = input.model.trim();
  if (!model || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(model)) {
    return { ok: false, error: "Enter the model id exactly as OpenAI names it, e.g. gpt-5.6-luna." };
  }
  if (input.kind !== "chat" && input.kind !== "embedding") return { ok: false, error: "Pick chat or embedding." };
  const inputPerM = money(input.inputPerM, "The input price");
  if (typeof inputPerM === "string") return { ok: false, error: inputPerM };
  const cachedPerM = money(input.cachedPerM, "The cached-input price");
  if (typeof cachedPerM === "string") return { ok: false, error: cachedPerM };
  const outputPerM = money(input.outputPerM, "The output price");
  if (typeof outputPerM === "string") return { ok: false, error: outputPerM };
  if (!isDay(input.effectiveFrom)) return { ok: false, error: "Pick the date the price takes effect." };
  const effectiveTo = input.effectiveTo.trim();
  if (effectiveTo && (!isDay(effectiveTo) || effectiveTo < input.effectiveFrom)) {
    return { ok: false, error: "The end date must be on or after the start date." };
  }

  // Close the open-ended row this one replaces.
  let closedPrevious = false;
  const { data: open } = await supabase
    .from("ai_model_prices")
    .select("id, effective_from")
    .eq("model", model)
    .is("effective_to", null)
    .lt("effective_from", input.effectiveFrom)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open) {
    const { error } = await supabase
      .from("ai_model_prices")
      .update({ effective_to: addDays(input.effectiveFrom, -1) })
      .eq("id", open.id);
    if (error) return { ok: false, error: error.message };
    closedPrevious = true;
  }

  const { error } = await supabase.from("ai_model_prices").insert({
    model,
    kind: input.kind,
    label: input.label.trim().slice(0, 80) || null,
    input_per_m: inputPerM,
    cached_input_per_m: cachedPerM,
    output_per_m: outputPerM,
    effective_from: input.effectiveFrom,
    effective_to: effectiveTo || null,
    note: input.note.trim().slice(0, 200) || null,
  });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "A price for that model already starts on that date. End it or pick another date." };
    return { ok: false, error: error.message };
  }

  invalidatePriceCatalog();
  revalidatePath("/ai-projects/models");
  return { ok: true, closedPrevious };
}

export async function endModelPrice(id: string, effectiveTo: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  if (!isDay(effectiveTo)) return { ok: false, error: "Pick an end date." };
  const { data: row } = await supabase.from("ai_model_prices").select("id, effective_from").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "That price no longer exists." };
  if (effectiveTo < row.effective_from) return { ok: false, error: "The end date must be on or after the start date." };
  const { error } = await supabase.from("ai_model_prices").update({ effective_to: effectiveTo }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidatePriceCatalog();
  revalidatePath("/ai-projects/models");
  return { ok: true };
}

/** Hide or show a model on the Agent tab. Every row of the model, so an old
 * price and a new one cannot disagree about whether it is offered. */
export async function setModelActive(model: string, active: boolean): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_model_prices").update({ is_active: active }).eq("model", model);
  if (error) return { ok: false, error: error.message };
  invalidatePriceCatalog();
  revalidatePath("/ai-projects/models");
  return { ok: true };
}

/** Usage rows keep their snapshot; only the pointer is cleared. */
export async function deleteModelPrice(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_model_prices").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidatePriceCatalog();
  revalidatePath("/ai-projects/models");
  return { ok: true };
}
