"use server";

/**
 * The planning half of a project (0092).
 *
 * Who is on it, what the phases are, what has to pass before it can be called
 * delivered, and where the hours went. Kept apart from actions.ts, which is
 * about the money.
 */

import { revalidatePath } from "next/cache";

import {
  AFTERCARE_TASKS,
  DEFAULT_LAUNCH_CHECKS,
} from "@/lib/constants";
import { createClient } from "@/lib/supabase/server";
import type {
  ActionResult,
  MilestoneKind,
  MilestoneStatus,
  TodoPriority,
} from "@/lib/types";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

function touch(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

// ---------------------------------------------------------------------------
// Who is on the project (PLAN-3)
// ---------------------------------------------------------------------------

export async function addProjectMember(
  projectId: string,
  userId: string,
  role?: string | null,
  isOwner = false,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!userId) return { ok: false, error: "Choose someone to add." };

  const { error } = await supabase.from("project_members").upsert(
    {
      project_id: projectId,
      user_id: userId,
      role: role?.trim() || null,
      is_owner: isOwner,
      added_by: user.id,
    },
    { onConflict: "project_id,user_id" },
  );
  if (error) return { ok: false, error: error.message };

  // Being put on a project is exactly the kind of thing worth a notification —
  // it's how someone finds out there is work waiting for them.
  if (userId !== user.id) {
    const { data: project } = await supabase
      .from("projects")
      .select("name")
      .eq("id", projectId)
      .maybeSingle();
    await supabase.from("notifications").insert({
      user_id: userId,
      actor_id: user.id,
      // No dedicated "project" notification type exists; being put on a job
      // is an assignment, which is what the bell already understands.
      type: "assignment",
      title: isOwner ? "You now own a project" : "You were added to a project",
      body: project?.name ?? "Open it to see what's outstanding.",
      link: `/projects/${projectId}`,
    });
  }

  touch(projectId);
  return { ok: true };
}

export async function removeProjectMember(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase.from("project_members").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  touch(projectId);
  return { ok: true };
}

/**
 * Hand the project to someone else.
 *
 * Clears the flag on everyone else first: two owners is a state the schema
 * tolerates (a handover), but it should never be where a click leaves you.
 */
export async function setProjectOwner(
  projectId: string,
  memberId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const cleared = await supabase
    .from("project_members")
    .update({ is_owner: false })
    .eq("project_id", projectId);
  if (cleared.error) return { ok: false, error: cleared.error.message };

  const { error } = await supabase
    .from("project_members")
    .update({ is_owner: true })
    .eq("id", memberId);
  if (error) return { ok: false, error: error.message };

  touch(projectId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Milestones and launch checks (PLAN-2, PLAN-10)
// ---------------------------------------------------------------------------

export type MilestoneInput = {
  id?: string;
  project_id: string;
  title: string;
  detail?: string | null;
  kind?: MilestoneKind;
  due_date?: string | null;
  owner_id?: string | null;
  client_visible?: boolean;
  position?: number;
  /** 0093 — text the client when this milestone is completed. */
  notify_sms?: boolean;
};

export async function saveMilestone(
  input: MilestoneInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title?.trim()) return { ok: false, error: "Give the milestone a name." };

  const kind: MilestoneKind = input.kind ?? "milestone";
  const payload = {
    project_id: input.project_id,
    title: input.title.trim(),
    detail: input.detail?.trim() || null,
    kind,
    due_date: input.due_date || null,
    owner_id: input.owner_id || null,
    // A launch check is an internal gate; showing it to a client would read as
    // a list of things that might be wrong with their site.
    client_visible: kind === "launch_check" ? false : input.client_visible ?? true,
    // A launch check is never something the client hears about.
    notify_sms: kind === "launch_check" ? false : input.notify_sms ?? false,
    ...(input.position !== undefined ? { position: input.position } : {}),
  };

  const { error } = input.id
    ? await supabase.from("project_milestones").update(payload).eq("id", input.id)
    : await supabase.from("project_milestones").insert(payload);

  if (error) return { ok: false, error: error.message };
  touch(input.project_id);
  return { ok: true };
}

export async function setMilestoneStatus(
  id: string,
  projectId: string,
  status: MilestoneStatus,
): Promise<ActionResult & { smsError?: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("project_milestones")
    .update({
      status,
      completed_at: status === "done" ? new Date().toISOString() : null,
      completed_by: status === "done" ? user.id : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // 0093 — a milestone marked "tell the client" texts them the moment it's
  // done. textMilestone() refuses a second send on its own (notified_at), so
  // ticking and un-ticking can't turn into a stream of messages.
  let smsError: string | undefined;
  if (status === "done") {
    const { data: milestone } = await supabase
      .from("project_milestones")
      .select("notify_sms, notified_at, title, kind")
      .eq("id", id)
      .maybeSingle();

    // 0096 — a milestone landing is a trigger of its own. Keyed on the
    // milestone id, so un-ticking and re-ticking can't re-run the flow.
    if (milestone) {
      const { fireMilestoneCompleted } = await import("@/lib/project-events");
      await fireMilestoneCompleted(supabase, projectId, {
        id,
        title: milestone.title,
        kind: milestone.kind,
      });
    }
    if (milestone?.notify_sms && !milestone.notified_at) {
      const { textMilestone } = await import("./client-sms-actions");
      const res = await textMilestone(id);
      // Soft: the milestone IS done whether or not the text made it out. The
      // team is told so they can send it by hand.
      if (!res.ok) smsError = res.error;
    }
  }

  touch(projectId);
  return { ok: true, ...(smsError ? { smsError } : {}) };
}

export async function deleteMilestone(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase.from("project_milestones").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  touch(projectId);
  return { ok: true };
}

/** Put the standard pre-delivery gate on a project, skipping any already there. */
export async function seedLaunchChecklist(
  projectId: string,
): Promise<ActionResult & { seeded?: number }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: existing } = await supabase
    .from("project_milestones")
    .select("title")
    .eq("project_id", projectId)
    .eq("kind", "launch_check");
  const have = new Set((existing ?? []).map((m) => m.title.toLowerCase()));

  const rows = DEFAULT_LAUNCH_CHECKS.filter(
    (c) => !have.has(c.title.toLowerCase()),
  ).map((c, i) => ({
    project_id: projectId,
    title: c.title,
    detail: c.detail,
    kind: "launch_check" as const,
    client_visible: false,
    position: i,
  }));
  if (rows.length === 0) return { ok: true, seeded: 0 };

  const { error } = await supabase.from("project_milestones").insert(rows);
  if (error) return { ok: false, error: error.message };

  touch(projectId);
  return { ok: true, seeded: rows.length };
}

// ---------------------------------------------------------------------------
// Time (PLAN-5)
// ---------------------------------------------------------------------------

/**
 * Log time against a project.
 *
 * Deliberately a single "how long" field rather than a start/stop timer:
 * timers get left running, and an agency that has never tracked time at all
 * will actually fill in "90m" at the end of a job.
 */
export async function logTime(input: {
  project_id: string;
  minutes: number;
  todo_id?: string | null;
  note?: string | null;
  worked_on?: string | null;
  /** Admins may log on someone else's behalf; everyone else logs their own. */
  user_id?: string | null;
}): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const minutes = Math.round(Number(input.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0)
    return { ok: false, error: "Enter how long it took." };
  if (minutes > 24 * 60)
    return { ok: false, error: "That's more than a day — split it across entries." };

  // RLS enforces this too; checking here turns a policy rejection into a
  // sentence someone can act on.
  let targetUser = user.id;
  if (input.user_id && input.user_id !== user.id) {
    const { data: me } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (me?.role !== "admin")
      return { ok: false, error: "Only an admin can log time for someone else." };
    targetUser = input.user_id;
  }

  const { error } = await supabase.from("time_entries").insert({
    project_id: input.project_id,
    todo_id: input.todo_id || null,
    user_id: targetUser,
    minutes,
    note: input.note?.trim() || null,
    worked_on: input.worked_on || new Date().toISOString().slice(0, 10),
  });
  if (error) return { ok: false, error: error.message };

  touch(input.project_id);
  return { ok: true };
}

export async function deleteTimeEntry(
  id: string,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase.from("time_entries").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  touch(projectId);
  return { ok: true };
}

/** The hourly cost that turns logged time into a margin figure. Admin only. */
export async function setMemberHourlyCost(
  userId: string,
  hourlyCost: number | null,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (me?.role !== "admin")
    return { ok: false, error: "Only an admin can set cost rates." };
  if (hourlyCost !== null && (!Number.isFinite(hourlyCost) || hourlyCost < 0))
    return { ok: false, error: "Enter a valid hourly cost." };

  const { error } = await supabase
    .from("profiles")
    .update({ hourly_cost: hourlyCost })
    .eq("id", userId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/team");
  revalidatePath(`/team/${userId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Task dependencies (PLAN-11)
// ---------------------------------------------------------------------------

/**
 * Make one task wait for another.
 *
 * Cycles are rejected here rather than in SQL, because the useful outcome is a
 * sentence explaining which chain would loop — not a constraint violation.
 */
export async function setTaskDependency(
  todoId: string,
  dependsOnId: string | null,
  projectId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (dependsOnId === todoId)
    return { ok: false, error: "A task can't wait for itself." };

  if (dependsOnId) {
    // Walk the chain upward; if we arrive back at this task, it's a loop.
    const seen = new Set<string>([todoId]);
    let cursor: string | null = dependsOnId;
    for (let hops = 0; cursor && hops < 50; hops++) {
      if (seen.has(cursor))
        return { ok: false, error: "That would make the tasks wait on each other." };
      seen.add(cursor);
      const { data }: { data: { depends_on_id: string | null } | null } =
        await supabase
          .from("todos")
          .select("depends_on_id")
          .eq("id", cursor)
          .maybeSingle();
      cursor = data?.depends_on_id ?? null;
    }
  }

  const { error } = await supabase
    .from("todos")
    .update({ depends_on_id: dependsOnId })
    .eq("id", todoId);
  if (error) return { ok: false, error: error.message };

  touch(projectId);
  revalidatePath("/todos");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Templates (PLAN-1)
// ---------------------------------------------------------------------------

export type TemplateInput = {
  id?: string;
  name: string;
  service_type?: string | null;
  description?: string | null;
  default_value?: number | null;
  default_currency?: string;
  default_days?: number | null;
  is_active?: boolean;
};

export async function saveTemplate(
  input: TemplateInput,
): Promise<ActionResult & { id?: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.name?.trim()) return { ok: false, error: "Name the template." };

  const payload = {
    name: input.name.trim(),
    service_type: input.service_type || null,
    description: input.description?.trim() || null,
    default_value: input.default_value ?? null,
    default_currency: input.default_currency || "LKR",
    default_days: input.default_days ?? null,
    is_active: input.is_active ?? true,
  };

  const res = input.id
    ? await supabase
        .from("project_templates")
        .update(payload)
        .eq("id", input.id)
        .select("id")
        .single()
    : await supabase.from("project_templates").insert(payload).select("id").single();

  if (res.error) return { ok: false, error: res.error.message };
  revalidatePath("/projects/templates");
  return { ok: true, id: res.data.id };
}

export async function deleteTemplate(id: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase.from("project_templates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects/templates");
  return { ok: true };
}

export type TemplateItemInput = {
  id?: string;
  template_id: string;
  kind?: "task" | "asset" | "milestone" | "launch_check";
  title: string;
  detail?: string | null;
  category?: string | null;
  offset_days?: number | null;
  required?: boolean;
  role?: string | null;
  priority?: TodoPriority;
  position?: number;
};

export async function saveTemplateItem(
  input: TemplateItemInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.title?.trim()) return { ok: false, error: "Give the item a title." };

  const payload = {
    template_id: input.template_id,
    kind: input.kind ?? "task",
    title: input.title.trim(),
    detail: input.detail?.trim() || null,
    category: input.category?.trim() || null,
    offset_days: input.offset_days ?? null,
    required: input.required ?? true,
    role: input.role?.trim() || null,
    priority: input.priority ?? "medium",
    ...(input.position !== undefined ? { position: input.position } : {}),
  };

  const { error } = input.id
    ? await supabase.from("project_template_items").update(payload).eq("id", input.id)
    : await supabase.from("project_template_items").insert(payload);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects/templates");
  return { ok: true };
}

export async function deleteTemplateItem(id: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase
    .from("project_template_items")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects/templates");
  return { ok: true };
}

export type ApplyTemplateResult = ActionResult & {
  tasks?: number;
  assets?: number;
  milestones?: number;
  checks?: number;
};

/**
 * Seed a project from a template.
 *
 * Idempotent by title within each kind, so applying a template twice — or
 * applying a second, overlapping template — tops the project up rather than
 * duplicating everything. Dates are computed from the project's start date;
 * an item with no offset simply has no date.
 */
export async function applyTemplate(
  projectId: string,
  templateId: string,
): Promise<ApplyTemplateResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  // The seeding itself lives in @/lib/project-templates so the automation
  // engine's seed_task_template step (0096) produces an identical project.
  const { applyProjectTemplate } = await import("@/lib/project-templates");
  const res = await applyProjectTemplate(supabase, projectId, templateId);
  if (!res.ok) return { ok: false, error: res.error };

  touch(projectId);
  revalidatePath("/todos");
  revalidatePath("/delivery");

  return {
    ok: true,
    tasks: res.tasks,
    assets: res.assets,
    milestones: res.milestones,
    checks: res.checks,
  };
}

/**
 * Turn a project that has been planned by hand into a reusable template.
 *
 * The fastest way to get templates worth having: finish one job properly,
 * then press this.
 */
export async function templateFromProject(
  projectId: string,
  name: string,
): Promise<ActionResult & { id?: string }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!name.trim()) return { ok: false, error: "Name the template." };

  const [projectRes, todosRes, assetsRes, milestonesRes] = await Promise.all([
    supabase
      .from("projects")
      .select("service_type, total_value, currency, start_date, due_date")
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("todos")
      .select("title, description, priority, position")
      .eq("project_id", projectId)
      .order("position"),
    supabase
      .from("project_document_requests")
      .select("title, description, category, required, position")
      .eq("project_id", projectId)
      .order("position"),
    supabase
      .from("project_milestones")
      .select("title, detail, kind, position")
      .eq("project_id", projectId)
      .order("position"),
  ]);

  const project = projectRes.data;
  if (!project) return { ok: false, error: "Project not found." };

  const days =
    project.start_date && project.due_date
      ? Math.max(
          1,
          Math.round(
            (new Date(project.due_date).getTime() -
              new Date(project.start_date).getTime()) /
              86_400_000,
          ),
        )
      : null;

  const created = await supabase
    .from("project_templates")
    .insert({
      name: name.trim(),
      service_type: project.service_type,
      default_value: project.total_value,
      default_currency: project.currency,
      default_days: days,
    })
    .select("id")
    .single();
  if (created.error) return { ok: false, error: created.error.message };
  const templateId = created.data.id;

  const items = [
    ...(todosRes.data ?? []).map((t, i) => ({
      template_id: templateId,
      kind: "task" as const,
      title: t.title,
      detail: t.description,
      priority: t.priority,
      position: t.position ?? i,
    })),
    ...(assetsRes.data ?? []).map((a, i) => ({
      template_id: templateId,
      kind: "asset" as const,
      title: a.title,
      detail: a.description,
      category: a.category,
      required: a.required,
      position: a.position ?? i,
    })),
    ...(milestonesRes.data ?? []).map((m, i) => ({
      template_id: templateId,
      kind: m.kind,
      title: m.title,
      detail: m.detail,
      position: m.position ?? i,
    })),
  ];

  if (items.length) {
    const { error } = await supabase.from("project_template_items").insert(items);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath("/projects/templates");
  return { ok: true, id: templateId };
}

// ---------------------------------------------------------------------------
// The other build tracker (PLAN-9)
// ---------------------------------------------------------------------------

/** Point a /website-progress row at the project it belongs to. */
export async function linkWebsiteProject(
  websiteProjectId: string,
  projectId: string | null,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("website_projects")
    .update({ project_id: projectId })
    .eq("id", websiteProjectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/website-progress");
  if (projectId) touch(projectId);
  return { ok: true };
}

/**
 * Create this month's aftercare tasks for a delivered project.
 *
 * Also reachable from the tick (PLAN-12); exposed here so the team can pull
 * the month forward by hand without waiting for the 1st.
 */
export async function seedAftercareTasks(
  projectId: string,
): Promise<ActionResult & { seeded?: number }> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const month = new Date().toISOString().slice(0, 7);
  const { data: existing } = await supabase
    .from("todos")
    .select("title")
    .eq("project_id", projectId)
    .ilike("title", `%(${month})`);
  if ((existing ?? []).length > 0)
    return { ok: true, seeded: 0 };

  const { data: owner } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("is_owner", true)
    .maybeSingle();

  const rows = AFTERCARE_TASKS.map((t, i) => ({
    title: `${t.title} (${month})`,
    description: t.description,
    project_id: projectId,
    assigned_to: owner?.user_id ?? null,
    priority: "medium" as const,
    position: i,
  }));

  const { error } = await supabase.from("todos").insert(rows);
  if (error) return { ok: false, error: error.message };

  await supabase
    .from("projects")
    .update({ aftercare_last_run_on: new Date().toISOString().slice(0, 10) })
    .eq("id", projectId);

  touch(projectId);
  revalidatePath("/todos");
  return { ok: true, seeded: rows.length };
}
