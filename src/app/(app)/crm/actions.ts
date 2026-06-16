"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import type { ActionResult } from "@/lib/types";

// --- Pipelines -------------------------------------------------
export async function createPipeline(
  name: string,
  description?: string,
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!name?.trim()) return { ok: false, error: "Pipeline name is required." };

  const { count } = await supabase
    .from("pipelines")
    .select("*", { count: "exact", head: true });

  const { data: pipe, error } = await supabase
    .from("pipelines")
    .insert({
      name: name.trim(),
      description: description?.trim() || null,
      position: count ?? 0,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  await supabase.from("pipeline_stages").insert(
    DEFAULT_PIPELINE_STAGES.map((s, i) => ({
      pipeline_id: pipe.id,
      name: s.name,
      color: s.color,
      position: i,
    })),
  );

  revalidatePath("/crm");
  return { ok: true, id: pipe.id };
}

export async function deletePipeline(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("pipelines").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

// --- Stages ----------------------------------------------------
export async function createStage(
  pipelineId: string,
  name: string,
  color: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  if (!name?.trim()) return { ok: false, error: "Stage name is required." };

  const { count } = await supabase
    .from("pipeline_stages")
    .select("*", { count: "exact", head: true })
    .eq("pipeline_id", pipelineId);

  const { error } = await supabase.from("pipeline_stages").insert({
    pipeline_id: pipelineId,
    name: name.trim(),
    color,
    position: count ?? 0,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

export async function updateStage(
  id: string,
  patch: { name?: string; color?: string },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("pipeline_stages")
    .update(patch)
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

export async function deleteStage(
  id: string,
  pipelineId: string,
): Promise<ActionResult> {
  const supabase = await createClient();

  // Move any leads in this stage to the first remaining stage.
  const { data: others } = await supabase
    .from("pipeline_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .neq("id", id)
    .order("position")
    .limit(1);

  const fallback = others?.[0]?.id ?? null;
  await supabase.from("leads").update({ stage_id: fallback }).eq("stage_id", id);

  const { error } = await supabase
    .from("pipeline_stages")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

// --- Leads -----------------------------------------------------
export type LeadInput = {
  id?: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  company?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  value?: number | null;
  currency?: string;
  notes?: string;
  assigned_to?: string | null;
  client_id?: string | null;
};

export async function saveLead(input: LeadInput): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title?.trim()) return { ok: false, error: "Lead title is required." };

  const base = {
    pipeline_id: input.pipeline_id,
    stage_id: input.stage_id,
    title: input.title.trim(),
    company: input.company?.trim() || null,
    contact_name: input.contact_name?.trim() || null,
    contact_email: input.contact_email?.trim() || null,
    contact_phone: input.contact_phone?.trim() || null,
    value: input.value ?? null,
    currency: input.currency || "LKR",
    notes: input.notes?.trim() || null,
    assigned_to: input.assigned_to || null,
    client_id: input.client_id || null,
  };

  if (input.id) {
    const { error } = await supabase
      .from("leads")
      .update(base)
      .eq("id", input.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { count } = await supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("stage_id", input.stage_id);
    const { error } = await supabase
      .from("leads")
      .insert({ ...base, position: count ?? 0 });
    if (error) return { ok: false, error: error.message };

    if (input.assigned_to && input.assigned_to !== user.id) {
      await supabase.from("notifications").insert({
        user_id: input.assigned_to,
        actor_id: user.id,
        type: "assignment",
        title: "You were assigned a lead",
        body: input.title.trim(),
        link: "/crm",
      });
    }
  }

  revalidatePath("/crm");
  return { ok: true };
}

export async function deleteLead(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

/** Persist new stage + ordering for affected leads after a drag. */
export async function updateLeadPositions(
  updates: { id: string; stage_id: string; position: number }[],
): Promise<ActionResult> {
  const supabase = await createClient();
  for (const u of updates) {
    const { error } = await supabase
      .from("leads")
      .update({ stage_id: u.stage_id, position: u.position })
      .eq("id", u.id);
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/crm");
  return { ok: true };
}
