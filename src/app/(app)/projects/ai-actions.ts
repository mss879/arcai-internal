"use server";

/**
 * The AI layer's server actions (theme 5, 0098).
 *
 * Every one of these DRAFTS. None of them sends a message, bills a client or
 * closes a project on the model's word — the contract receipt.ts set in MON-8
 * and the whole theme keeps: the model removes the blank page, a person
 * decides.
 */

import { revalidatePath } from "next/cache";

import { draftProjectBrief, type ProjectBrief } from "@/lib/ai/project-brief";
import { estimateForService, type ProjectEstimate } from "@/lib/ai/project-estimate";
import { runProjectPostMortem } from "@/lib/ai/project-postmortem";
import { readProgressScreenshot, type ProgressNote } from "@/lib/ai/progress-note";
import { askProjects, type ProjectAnswer } from "@/lib/ai/project-query";
import { scanProjectScope, type ScopeFinding } from "@/lib/ai/scope-creep";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, ProjectLessonStatus } from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// ---------------------------------------------------------------------------
// AI-1 — the brief, from the sale
// ---------------------------------------------------------------------------

export async function draftBrief(input: {
  leadId?: string | null;
  quoteId?: string | null;
  clientId?: string | null;
}): Promise<{ ok: true; brief: ProjectBrief } | { ok: false; error: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  return draftProjectBrief(supabase, input);
}

// ---------------------------------------------------------------------------
// AI-2 — what this kind of work actually costs and takes
// ---------------------------------------------------------------------------

export async function getEstimate(
  serviceType: string,
): Promise<{ ok: true; estimate: ProjectEstimate } | { ok: false; error: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  return estimateForService(supabase, serviceType);
}

// ---------------------------------------------------------------------------
// AI-3 — scope creep
// ---------------------------------------------------------------------------

export async function checkScope(
  projectId: string,
): Promise<{ ok: true; findings: ScopeFinding[] } | { ok: false; error: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  // Forced: a person pressing the button means "look at the whole thread
  // again", not "look at whatever arrived since the tick last ran".
  const res = await scanProjectScope(supabase, projectId, { force: true });
  if (res.ok) revalidatePath(`/projects/${projectId}`);
  return res;
}

// ---------------------------------------------------------------------------
// AI-5 — a screenshot becomes an update
// ---------------------------------------------------------------------------

export async function readScreenshot(
  projectId: string,
  dataUrl: string,
  note?: string,
): Promise<{ ok: true; note: ProgressNote } | { ok: false; error: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("name, delivery_stage")
    .eq("id", projectId)
    .maybeSingle();

  return readProgressScreenshot(dataUrl, {
    projectName: project?.name,
    stage: project?.delivery_stage,
    note,
  });
}

/**
 * File the note the screenshot produced.
 *
 * A separate call from reading it, on purpose: the team edits the wording
 * before anything is written, and a draft they didn't like leaves no trace.
 */
export async function fileProgressNote(
  projectId: string,
  input: { headline: string; clientUpdate: string; internalNote: string },
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const rows = [
    input.internalNote.trim()
      ? {
          project_id: projectId,
          author_type: "team" as const,
          author_id: user.id,
          author_name: "Progress note",
          body: input.internalNote.trim(),
        }
      : null,
    input.clientUpdate.trim()
      ? {
          project_id: projectId,
          author_type: "team" as const,
          author_id: user.id,
          author_name: "Client update (draft)",
          body: input.clientUpdate.trim(),
        }
      : null,
  ].filter((r): r is NonNullable<typeof r> => !!r);

  if (rows.length === 0) return { ok: false, error: "Nothing to file." };

  const { error } = await supabase.from("project_comments").insert(rows);
  if (error) return { ok: false, error: error.message };

  const { logDeliveryEvent } = await import("@/lib/delivery");
  await logDeliveryEvent(
    supabase,
    projectId,
    "comment",
    input.headline.trim() || "Progress note filed",
    "team",
  );

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// AI-6 — the post-mortem
// ---------------------------------------------------------------------------

export async function runPostMortem(projectId: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const res = await runProjectPostMortem(supabase, projectId);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects/insights");
  return { ok: true };
}

/** Keep or dismiss a lesson. Only KEPT lessons are ever quoted into pricing. */
export async function decideLesson(
  id: string,
  status: ProjectLessonStatus,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("project_lessons")
    .update({
      status,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/projects/insights");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// AI-8 — ask your projects anything
// ---------------------------------------------------------------------------

export async function askAboutProjects(
  question: string,
): Promise<{ ok: true; result: ProjectAnswer } | { ok: false; error: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  return askProjects(supabase, question);
}

// ---------------------------------------------------------------------------
// AI-9 — anomaly guards
// ---------------------------------------------------------------------------

export async function resolveAnomaly(
  id: string,
  status: "dismissed" | "fixed",
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("project_anomalies")
    .update({
      status,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/projects/insights");
  return { ok: true };
}

/** Run the guards now rather than waiting for the tick. */
export async function rescanAnomalies(): Promise<ActionResult & { found?: number }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { processProjectAnomalies } = await import("@/lib/project-anomalies");
  const res = await processProjectAnomalies(supabase);
  revalidatePath("/projects/insights");
  return { ok: true, found: res.found };
}
