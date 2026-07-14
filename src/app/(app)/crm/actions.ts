"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { fireAutomationTrigger } from "@/lib/automation";
import { createClient } from "@/lib/supabase/server";
import { startLeadResearch } from "@/lib/research";
import { isResearchConfigured } from "@/lib/ai/lead-research";
import {
  buildRecipients,
  drainOutreachRow,
  sendLeadOutreach,
} from "@/lib/lead-outreach";
import { sendPushToUser } from "@/lib/push";
import { sendSmsToUser } from "@/lib/sms-alerts";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import type { ActionResult, Lead } from "@/lib/types";
import type { CrmFieldKind, LeadScore } from "@/lib/database.types";

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

/** Rename a pipeline / tune its stale-deal threshold. */
export async function updatePipeline(
  id: string,
  patch: { name?: string; stale_after_days?: number },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("pipelines").update(patch).eq("id", id);
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
  company_website?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  value?: number | null;
  currency?: string;
  notes?: string;
  assigned_to?: string | null;
  client_id?: string | null;
  company_id?: string | null;
  tags?: string[];
  source?: string;
  expected_close_date?: string | null;
  probability?: number | null;
  score?: LeadScore | null;
  custom?: Record<string, unknown>;
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
    company_website: input.company_website?.trim() || null,
    contact_name: input.contact_name?.trim() || null,
    contact_email: input.contact_email?.trim() || null,
    contact_phone: input.contact_phone?.trim() || null,
    value: input.value ?? null,
    currency: input.currency || "LKR",
    notes: input.notes?.trim() || null,
    assigned_to: input.assigned_to || null,
    client_id: input.client_id || null,
    company_id: input.company_id || null,
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.expected_close_date !== undefined
      ? { expected_close_date: input.expected_close_date || null }
      : {}),
    ...(input.probability !== undefined ? { probability: input.probability } : {}),
    ...(input.score !== undefined ? { score: input.score } : {}),
    ...(input.custom !== undefined ? { custom: input.custom } : {}),
  };

  if (input.id) {
    // Detect freshly-added tags (tag_added automations) and a changed
    // assignee (assignment alerts) in one snapshot.
    const { data: before } = await supabase
      .from("leads")
      .select("tags, assigned_to")
      .eq("id", input.id)
      .single();

    const { data: updated, error } = await supabase
      .from("leads")
      .update(base)
      .eq("id", input.id)
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };

    if (updated && input.tags) {
      const oldTags = new Set(before?.tags ?? []);
      for (const tag of input.tags) {
        if (!oldTags.has(tag)) {
          await fireAutomationTrigger(supabase, {
            trigger: "tag_added",
            lead: updated as Lead,
            payload: { tag },
          });
        }
      }
    }

    // Reassigned to someone new — tell them, same as on create.
    if (
      input.assigned_to &&
      input.assigned_to !== user.id &&
      input.assigned_to !== (before?.assigned_to ?? null)
    ) {
      await notifyLeadAssignment(supabase, {
        userId: input.assigned_to,
        actorId: user.id,
        leadTitle: input.title.trim(),
      });
    }
  } else {
    const { count } = await supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("stage_id", input.stage_id);
    const { data: created, error } = await supabase
      .from("leads")
      .insert({ ...base, position: count ?? 0 })
      .select("*")
      .single();
    if (error) return { ok: false, error: error.message };

    if (created) {
      await fireAutomationTrigger(supabase, {
        trigger: "lead_created",
        lead: created as Lead,
        triggerKey: `${created.id}:created`,
      });

      // Kick off prospect research for a lead that names a company.
      // Runs after the response so the "Add lead" click stays snappy;
      // the automation tick retries if this call runs out of time.
      const company = created.company?.trim();
      if (company && isResearchConfigured()) {
        const leadId = created.id;
        const actorId = user.id;
        after(async () => {
          await startLeadResearch(supabase, {
            leadId,
            company,
            requestedBy: actorId,
          });
        });
      }
    }

    if (input.assigned_to && input.assigned_to !== user.id) {
      await notifyLeadAssignment(supabase, {
        userId: input.assigned_to,
        actorId: user.id,
        leadTitle: input.title.trim(),
      });
    }
  }

  revalidatePath("/crm");
  return { ok: true };
}

/** In-app notification + push + SMS for a lead assignment. */
async function notifyLeadAssignment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  opts: { userId: string; actorId: string; leadTitle: string },
) {
  await supabase.from("notifications").insert({
    user_id: opts.userId,
    actor_id: opts.actorId,
    type: "assignment",
    title: "You were assigned a lead",
    body: opts.leadTitle,
    link: "/crm",
  });
  await sendPushToUser({
    userId: opts.userId,
    title: "You were assigned a lead",
    body: opts.leadTitle,
    link: "/crm",
  });
  await sendSmsToUser({
    userId: opts.userId,
    message: `ARC AI: you were assigned a lead — "${opts.leadTitle}". Check the CRM pipeline.`,
  });
}

/** Soft-delete into the trash (restorable). */
export async function trashLead(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("leads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

export async function restoreLead(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("leads")
    .update({ deleted_at: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

/** Permanent delete (from the trash view). */
export async function deleteLead(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

/** Mark won / lost / back to open. */
export async function setLeadStatus(
  id: string,
  status: "open" | "won" | "lost",
  lostReason?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const patch =
    status === "won"
      ? { status, won_at: new Date().toISOString(), lost_at: null, lost_reason: null }
      : status === "lost"
        ? {
            status,
            lost_at: new Date().toISOString(),
            lost_reason: lostReason?.trim() || null,
            won_at: null,
          }
        : { status, won_at: null, lost_at: null, lost_reason: null };
  const { error } = await supabase.from("leads").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

/** Persist new stage + ordering for affected leads after a drag. */
export async function updateLeadPositions(
  updates: { id: string; stage_id: string; position: number }[],
): Promise<ActionResult> {
  const supabase = await createClient();

  // Snapshot stages first so real moves can fire stage_changed automations.
  const ids = updates.map((u) => u.id);
  const { data: before } = await supabase
    .from("leads")
    .select("id, stage_id, position")
    .in("id", ids);
  const beforeById = new Map((before ?? []).map((l) => [l.id, l]));

  // The client sends every card in both affected columns, but usually only
  // a couple actually changed — skip the no-ops and write the rest in
  // parallel so the drop isn't held up by sequential round-trips.
  const changed = updates.filter((u) => {
    const prev = beforeById.get(u.id);
    return !prev || prev.stage_id !== u.stage_id || prev.position !== u.position;
  });
  const results = await Promise.all(
    changed.map((u) =>
      supabase
        .from("leads")
        .update({ stage_id: u.stage_id, position: u.position })
        .eq("id", u.id),
    ),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) return { ok: false, error: failed.error.message };

  // Fire stage_changed automations after the response is sent — they can
  // send SMS/webhooks and must not hold up the drop.
  const movedStageById = new Map(
    changed
      .filter((u) => beforeById.get(u.id)?.stage_id !== u.stage_id)
      .map((u) => [u.id, u.stage_id]),
  );
  if (movedStageById.size) {
    after(async () => {
      const { data: movedLeads } = await supabase
        .from("leads")
        .select("*")
        .in("id", [...movedStageById.keys()]);
      for (const lead of movedLeads ?? []) {
        await fireAutomationTrigger(supabase, {
          trigger: "stage_changed",
          lead: lead as Lead,
          payload: { stage_id: movedStageById.get(lead.id) ?? lead.stage_id },
        });
      }
    });
  }

  revalidatePath("/crm");
  return { ok: true };
}

// --- Bulk actions ------------------------------------------------

export type BulkAction =
  | { kind: "move_stage"; stage_id: string }
  | { kind: "assign"; user_id: string | null }
  | { kind: "add_tag"; tag: string }
  | { kind: "remove_tag"; tag: string }
  | { kind: "trash" };

export async function bulkUpdateLeads(
  ids: string[],
  action: BulkAction,
): Promise<ActionResult<{ affected: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  if (action.kind === "move_stage") {
    const { error } = await supabase
      .from("leads")
      .update({ stage_id: action.stage_id })
      .in("id", ids);
    if (error) return { ok: false, error: error.message };
  } else if (action.kind === "assign") {
    const { error } = await supabase
      .from("leads")
      .update({ assigned_to: action.user_id })
      .in("id", ids);
    if (error) return { ok: false, error: error.message };
  } else if (action.kind === "trash") {
    const { error } = await supabase
      .from("leads")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", ids);
    if (error) return { ok: false, error: error.message };
  } else {
    // Tags need per-row updates.
    const { data: rows } = await supabase
      .from("leads")
      .select("id, tags")
      .in("id", ids);
    for (const row of rows ?? []) {
      const tags = new Set(row.tags ?? []);
      if (action.kind === "add_tag") tags.add(action.tag);
      else tags.delete(action.tag);
      await supabase.from("leads").update({ tags: Array.from(tags) }).eq("id", row.id);
    }
    if (action.kind === "add_tag") {
      const { data: updatedRows } = await supabase
        .from("leads")
        .select("*")
        .in("id", ids);
      for (const lead of updatedRows ?? []) {
        await fireAutomationTrigger(supabase, {
          trigger: "tag_added",
          lead: lead as Lead,
          payload: { tag: action.tag },
        });
      }
    }
  }

  revalidatePath("/crm");
  return { ok: true, affected: ids.length };
}

// --- Activities (timeline) ----------------------------------------

export async function addLeadActivity(input: {
  lead_id: string;
  kind: "note" | "call" | "email" | "sms" | "meeting";
  title: string;
  body?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title.trim()) return { ok: false, error: "Write something first." };

  const { error } = await supabase.from("lead_activities").insert({
    lead_id: input.lead_id,
    kind: input.kind,
    title: input.title.trim(),
    body: input.body?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/crm/lead/${input.lead_id}`);
  return { ok: true };
}

// --- Follow-up tasks ------------------------------------------------

export async function saveCrmTask(input: {
  id?: string;
  lead_id?: string | null;
  title: string;
  notes?: string | null;
  due_at?: string | null;
  assigned_to?: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title.trim()) return { ok: false, error: "Task needs a title." };

  const base = {
    lead_id: input.lead_id ?? null,
    title: input.title.trim(),
    notes: input.notes?.trim() || null,
    due_at: input.due_at || null,
    assigned_to: input.assigned_to || null,
  };

  // Only alert the assignee when they're NEW to the task.
  let prevAssignee: string | null = null;
  if (input.id) {
    const { data: prev } = await supabase
      .from("crm_tasks")
      .select("assigned_to")
      .eq("id", input.id)
      .maybeSingle();
    prevAssignee = prev?.assigned_to ?? null;
  }

  const { error } = input.id
    ? await supabase.from("crm_tasks").update(base).eq("id", input.id)
    : await supabase.from("crm_tasks").insert(base);
  if (error) return { ok: false, error: error.message };

  if (
    input.assigned_to &&
    input.assigned_to !== user.id &&
    input.assigned_to !== prevAssignee
  ) {
    await supabase.from("notifications").insert({
      user_id: input.assigned_to,
      actor_id: user.id,
      type: "assignment",
      title: "You were assigned a follow-up task",
      body: input.title.trim(),
      link: input.lead_id ? `/crm/lead/${input.lead_id}` : "/crm",
    });
    await sendPushToUser({
      userId: input.assigned_to,
      title: "You were assigned a follow-up task",
      body: input.title.trim(),
      link: input.lead_id ? `/crm/lead/${input.lead_id}` : "/crm",
    });
    await sendSmsToUser({
      userId: input.assigned_to,
      message: `ARC AI: you were assigned a follow-up task — "${input.title.trim()}". Check the CRM pipeline.`,
    });
  }

  revalidatePath("/crm");
  if (input.lead_id) revalidatePath(`/crm/lead/${input.lead_id}`);
  return { ok: true };
}

export async function toggleCrmTask(id: string, done: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("crm_tasks")
    .update({
      status: done ? "done" : "open",
      completed_at: done ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

export async function deleteCrmTask(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("crm_tasks").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

// --- Custom fields ----------------------------------------------------

export async function saveCrmField(input: {
  id?: string;
  label: string;
  kind: CrmFieldKind;
  options?: string[];
  required?: boolean;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  const label = input.label.trim();
  if (!label) return { ok: false, error: "Field label is required." };

  if (input.id) {
    const { error } = await supabase
      .from("crm_fields")
      .update({
        label,
        kind: input.kind,
        options: input.options ?? [],
        required: input.required ?? false,
      })
      .eq("id", input.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (!key) return { ok: false, error: "Label must contain letters or numbers." };
    const { count } = await supabase
      .from("crm_fields")
      .select("*", { count: "exact", head: true });
    const { error } = await supabase.from("crm_fields").insert({
      key,
      label,
      kind: input.kind,
      options: input.options ?? [],
      required: input.required ?? false,
      position: count ?? 0,
    });
    if (error)
      return {
        ok: false,
        error: error.message.includes("duplicate")
          ? `A field with key "${key}" already exists.`
          : error.message,
      };
  }
  revalidatePath("/crm");
  return { ok: true };
}

export async function deleteCrmField(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("crm_fields").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

// --- Smart segments ----------------------------------------------------

export type SegmentFilters = {
  q?: string;
  tag?: string;
  source?: string;
  assigned_to?: string;
  score?: string;
  status?: string;
  no_activity_days?: number;
};

export async function saveSegment(
  name: string,
  filters: SegmentFilters,
): Promise<ActionResult> {
  const supabase = await createClient();
  if (!name.trim()) return { ok: false, error: "Name the segment." };
  const { error } = await supabase
    .from("crm_segments")
    .insert({ name: name.trim(), filters: filters as Record<string, unknown> });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

export async function deleteSegment(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("crm_segments").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  return { ok: true };
}

// --- Companies -----------------------------------------------------------

export async function saveCompany(input: {
  id?: string;
  name: string;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  industry?: string | null;
  notes?: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();
  if (!input.name.trim()) return { ok: false, error: "Company name is required." };
  const base = {
    name: input.name.trim(),
    website: input.website?.trim() || null,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    city: input.city?.trim() || null,
    industry: input.industry?.trim() || null,
    notes: input.notes?.trim() || null,
  };
  const { error } = input.id
    ? await supabase.from("companies").update(base).eq("id", input.id)
    : await supabase.from("companies").insert(base);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm/companies");
  return { ok: true };
}

export async function deleteCompany(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("companies").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm/companies");
  return { ok: true };
}

// --- Merge duplicates ------------------------------------------------------

/** Merge duplicates into `keepId`: fill blanks, union tags, move children. */
export async function mergeLeads(
  keepId: string,
  mergeIds: string[],
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const others = mergeIds.filter((id) => id !== keepId);
  if (others.length === 0) return { ok: false, error: "Pick at least two leads." };

  const { data: keep } = await supabase.from("leads").select("*").eq("id", keepId).single();
  const { data: dupes } = await supabase.from("leads").select("*").in("id", others);
  if (!keep || !dupes?.length) return { ok: false, error: "Leads not found." };

  const patch: Record<string, unknown> = {};
  const tags = new Set(keep.tags ?? []);
  const custom = { ...(keep.custom ?? {}) };
  for (const d of dupes) {
    for (const f of [
      "company", "contact_name", "contact_email", "contact_phone",
      "value", "notes", "assigned_to", "client_id", "company_id",
      "expected_close_date", "probability",
    ] as const) {
      if (keep[f] == null && d[f] != null && patch[f] === undefined) patch[f] = d[f];
    }
    for (const t of d.tags ?? []) tags.add(t);
    for (const [k, v] of Object.entries(d.custom ?? {})) {
      if (!(k in custom)) custom[k] = v;
    }
  }
  patch.tags = Array.from(tags);
  patch.custom = custom;

  const { error: updateError } = await supabase
    .from("leads")
    .update(patch as Lead)
    .eq("id", keepId);
  if (updateError) return { ok: false, error: updateError.message };

  // Re-home children, then delete the duplicates.
  await supabase.from("lead_activities").update({ lead_id: keepId }).in("lead_id", others);
  await supabase.from("crm_tasks").update({ lead_id: keepId }).in("lead_id", others);
  await supabase.from("quotes").update({ lead_id: keepId }).in("lead_id", others);

  const { error: deleteError } = await supabase.from("leads").delete().in("id", others);
  if (deleteError) return { ok: false, error: deleteError.message };

  await supabase.from("lead_activities").insert({
    lead_id: keepId,
    kind: "merged",
    title: `Merged ${others.length} duplicate${others.length === 1 ? "" : "s"} into this lead`,
    meta: { merged_ids: others },
  });

  revalidatePath("/crm");
  return { ok: true };
}

// --- CSV import --------------------------------------------------------------

export type ImportRow = {
  title: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  company?: string;
  value?: number | null;
  notes?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
};

export async function importLeads(input: {
  pipeline_id: string;
  stage_id: string;
  rows: ImportRow[];
  /** Skip rows whose email or phone already exists in the CRM. */
  dedupe: boolean;
  /** When false, imported leads do NOT fire lead_created automations. */
  fireAutomations: boolean;
}): Promise<ActionResult<{ imported: number; skipped: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (input.rows.length === 0) return { ok: false, error: "No rows to import." };
  if (input.rows.length > 2000)
    return { ok: false, error: "Import at most 2,000 rows at a time." };

  let existingEmails = new Set<string>();
  let existingPhones = new Set<string>();
  if (input.dedupe) {
    const { data: existing } = await supabase
      .from("leads")
      .select("contact_email, contact_phone");
    existingEmails = new Set(
      (existing ?? [])
        .map((l) => l.contact_email?.toLowerCase().trim())
        .filter((v): v is string => Boolean(v)),
    );
    existingPhones = new Set(
      (existing ?? [])
        .map((l) => l.contact_phone?.replace(/[^\d]/g, ""))
        .filter((v): v is string => typeof v === "string" && v.length > 5),
    );
  }

  const { count } = await supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("stage_id", input.stage_id);
  let position = count ?? 0;

  let imported = 0;
  let skipped = 0;
  const createdIds: string[] = [];

  for (const row of input.rows) {
    if (!row.title?.trim()) {
      skipped++;
      continue;
    }
    if (input.dedupe) {
      const email = row.contact_email?.toLowerCase().trim();
      const phone = row.contact_phone?.replace(/[^\d]/g, "");
      if (
        (email && existingEmails.has(email)) ||
        (phone && phone.length > 5 && existingPhones.has(phone))
      ) {
        skipped++;
        continue;
      }
      if (email) existingEmails.add(email);
      if (phone && phone.length > 5) existingPhones.add(phone);
    }

    const { data: created, error } = await supabase
      .from("leads")
      .insert({
        pipeline_id: input.pipeline_id,
        stage_id: input.stage_id,
        title: row.title.trim(),
        contact_name: row.contact_name?.trim() || null,
        contact_email: row.contact_email?.trim() || null,
        contact_phone: row.contact_phone?.trim() || null,
        company: row.company?.trim() || null,
        value: row.value ?? null,
        notes: row.notes?.trim() || null,
        tags: row.tags ?? ["imported"],
        custom: row.custom ?? {},
        source: "import",
        position: position++,
      })
      .select("id")
      .single();
    if (error || !created) {
      skipped++;
      continue;
    }
    createdIds.push(created.id);
    imported++;
  }

  if (!input.fireAutomations && createdIds.length > 0) {
    // Consume each lead_created dedupe key with a cancelled run so the tick
    // scanner can't enroll imported leads into keep-warm flows.
    const { data: automations } = await supabase
      .from("automations")
      .select("id")
      .eq("trigger", "lead_created");
    for (const automation of automations ?? []) {
      await supabase.from("automation_runs").insert(
        createdIds.map((leadId) => ({
          automation_id: automation.id,
          lead_id: leadId,
          trigger_key: `${leadId}:created`,
          status: "cancelled" as const,
          subject_name: "",
          completed_at: new Date().toISOString(),
        })),
      );
    }
  } else if (input.fireAutomations) {
    const { data: createdLeads } = await supabase
      .from("leads")
      .select("*")
      .in("id", createdIds);
    for (const lead of createdLeads ?? []) {
      await fireAutomationTrigger(supabase, {
        trigger: "lead_created",
        lead: lead as Lead,
        triggerKey: `${lead.id}:created`,
      });
    }
  }

  revalidatePath("/crm");
  return { ok: true, imported, skipped };
}

// --- AI sales assistant -----------------------------------------------------

export async function aiLeadAssist(
  leadId: string,
  mode: "summary" | "next_action" | "draft_reply",
): Promise<ActionResult<{ text: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { isOpenAIConfigured, openaiChat } = await import("@/lib/ai/openai");
  if (!isOpenAIConfigured())
    return { ok: false, error: "Add OPENAI_API_KEY to enable the AI sales assistant." };

  const [{ data: lead }, { data: activities }, { data: quotes }] = await Promise.all([
    supabase.from("leads").select("*").eq("id", leadId).single(),
    supabase
      .from("lead_activities")
      .select("kind, title, body, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("quotes")
      .select("quote_number, status, grand_total")
      .eq("lead_id", leadId),
  ]);
  if (!lead) return { ok: false, error: "Lead not found." };

  const context = `Lead: ${JSON.stringify({
    title: lead.title,
    contact: lead.contact_name,
    company: lead.company,
    value: lead.value,
    currency: lead.currency,
    status: lead.status,
    score: lead.score,
    source: lead.source,
    tags: lead.tags,
    expected_close_date: lead.expected_close_date,
    notes: lead.notes,
  })}\nQuotes: ${JSON.stringify(quotes ?? [])}\nHistory (newest first):\n${(activities ?? [])
    .map((a) => `${a.created_at.slice(0, 16)} [${a.kind}] ${a.title}${a.body ? ` — ${a.body.slice(0, 200)}` : ""}`)
    .join("\n")}`;

  const prompts: Record<typeof mode, string> = {
    summary:
      "Summarize this lead's full history in 3-5 short plain-text bullet lines a rep can scan in 10 seconds. End with one line on deal health.",
    next_action:
      "Suggest the single best next action to move this deal forward, in 1-2 sentences. Be specific (what to say/send and when).",
    draft_reply:
      "Draft a short, warm reply message to this lead (SMS-length, max 300 chars, plain text) that moves the deal forward based on the latest history.",
  };

  try {
    const reply = await openaiChat([
      {
        role: "system",
        content:
          "You are the AI sales assistant for ARC AI, a Sri Lankan digital agency. Plain text only, no markdown symbols.",
      },
      { role: "user", content: `${prompts[mode]}\n\n${context}` },
    ]);
    const text = reply.content?.trim();
    if (!text) return { ok: false, error: "AI returned nothing." };

    if (mode === "summary") {
      await supabase.from("leads").update({ ai_summary: text }).eq("id", leadId);
    } else if (mode === "next_action") {
      await supabase.from("leads").update({ ai_next_action: text }).eq("id", leadId);
    }
    revalidatePath(`/crm/lead/${leadId}`);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "AI call failed." };
  }
}

// --- Automated outreach (research → audit → AI email → approve → send) ------

/**
 * Manually kick off an AI outreach draft for a lead (research + audit +
 * compose). Resets any prior draft to pending and drains the pipeline inline
 * so the "Approve & send" card appears shortly. Never sends by itself.
 */
export async function prepareLeadOutreach(leadId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const recipients = await buildRecipients(supabase, leadId);
  const { data, error } = await supabase
    .from("lead_outreach")
    .upsert(
      {
        lead_id: leadId,
        status: "pending",
        recipients,
        source: "manual",
        subject: "",
        body: "",
        error: null,
        sent_to: [],
        message_ids: [],
        sent_at: null,
        attempts: 0,
        requested_by: user.id,
      },
      { onConflict: "lead_id" },
    )
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  const id = data.id;
  after(async () => {
    await drainOutreachRow(supabase, id);
  });
  revalidatePath(`/crm/lead/${leadId}`);
  return { ok: true };
}

/** Approve the drafted email and send it to every valid recipient. */
export async function approveLeadOutreach(
  leadId: string,
): Promise<ActionResult<{ sent: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const res = await sendLeadOutreach(supabase, leadId, { actorId: user.id });
  revalidatePath(`/crm/lead/${leadId}`);
  if (!res.ok) return { ok: false, error: res.error ?? "Send failed." };
  return { ok: true, sent: res.sent ?? 0 };
}

/** Edit the drafted subject/body before approving. */
export async function saveOutreachDraft(
  leadId: string,
  subject: string,
  body: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!body.trim()) return { ok: false, error: "The email body can't be empty." };

  const { error } = await supabase
    .from("lead_outreach")
    .update({ subject: subject.trim().slice(0, 200), body: body.trim().slice(0, 4000) })
    .eq("lead_id", leadId)
    .eq("status", "ready");
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/crm/lead/${leadId}`);
  return { ok: true };
}

/** Discard a drafted outreach (keeps any already-sent history intact). */
export async function discardLeadOutreach(leadId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  await supabase
    .from("lead_outreach")
    .update({ status: "discarded" })
    .eq("lead_id", leadId)
    .in("status", ["ready", "failed", "pending", "drafting"]);

  // Drop the "Draft Ready" chip.
  const { data: lead } = await supabase
    .from("leads")
    .select("tags")
    .eq("id", leadId)
    .maybeSingle();
  if (lead?.tags?.includes("Draft Ready")) {
    await supabase
      .from("leads")
      .update({ tags: lead.tags.filter((t) => t !== "Draft Ready") })
      .eq("id", leadId);
  }
  revalidatePath(`/crm/lead/${leadId}`);
  return { ok: true };
}
