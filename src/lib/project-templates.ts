import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AssetCategory, Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Seeding a project from a plan template (PLAN-1).
 *
 * Lifted out of the Apply-template button (0092) when the automation engine
 * grew a `seed_task_template` step (AUTO-2, 0096): a template applied by a
 * recipe and one applied by hand have to produce exactly the same project, or
 * "assets complete → seed the build plan" quietly becomes a second dialect of
 * the same feature.
 *
 * Idempotent by title, so re-applying a template — or a recipe running twice —
 * adds only what is missing.
 */

/** Template categories are free text; the asset checklist's are not. */
const ASSET_CATEGORIES = new Set<AssetCategory>([
  "brand",
  "content",
  "photos",
  "access",
]);

function asAssetCategory(value: string | null): AssetCategory | null {
  const v = (value ?? "").toLowerCase() as AssetCategory;
  return ASSET_CATEGORIES.has(v) ? v : null;
}

export type SeedTemplateResult =
  | { ok: true; tasks: number; assets: number; milestones: number; checks: number }
  | { ok: false; error: string };

export async function applyProjectTemplate(
  supabase: DB,
  projectId: string,
  templateId: string,
): Promise<SeedTemplateResult> {
  const [projectRes, itemsRes, membersRes] = await Promise.all([
    supabase
      .from("projects")
      .select("id, start_date, currency")
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("project_template_items")
      .select("*")
      .eq("template_id", templateId)
      .order("kind", { ascending: true })
      .order("position", { ascending: true }),
    supabase
      .from("project_members")
      .select("user_id, role")
      .eq("project_id", projectId),
  ]);

  const project = projectRes.data;
  if (!project) return { ok: false, error: "Project not found." };
  const items = itemsRes.data ?? [];
  if (items.length === 0)
    return { ok: false, error: "That template has no items in it yet." };

  const start = project.start_date
    ? new Date(`${project.start_date}T00:00:00`)
    : new Date();
  const dateFor = (offset: number | null): string | null => {
    if (offset === null || offset === undefined) return null;
    const d = new Date(start);
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  // Template items name a ROLE; the project names PEOPLE. Match them up so a
  // seeded task lands on whoever holds that role on this project.
  const byRole = new Map<string, string>();
  for (const m of membersRes.data ?? []) {
    if (m.role) byRole.set(m.role.toLowerCase(), m.user_id);
  }

  const [todosRes, requestsRes, milestonesRes] = await Promise.all([
    supabase.from("todos").select("title").eq("project_id", projectId),
    supabase
      .from("project_document_requests")
      .select("title")
      .eq("project_id", projectId),
    supabase
      .from("project_milestones")
      .select("title, kind")
      .eq("project_id", projectId),
  ]);
  const haveTodos = new Set(
    (todosRes.data ?? []).map((t) => t.title.toLowerCase()),
  );
  const haveAssets = new Set(
    (requestsRes.data ?? []).map((r) => r.title.toLowerCase()),
  );
  const haveMilestones = new Set(
    (milestonesRes.data ?? []).map((m) => `${m.kind}:${m.title.toLowerCase()}`),
  );

  const todoRows = [];
  const assetRows = [];
  const milestoneRows = [];

  for (const item of items) {
    if (item.kind === "task") {
      if (haveTodos.has(item.title.toLowerCase())) continue;
      const due = dateFor(item.offset_days);
      todoRows.push({
        title: item.title,
        description: item.detail,
        priority: item.priority,
        project_id: projectId,
        assigned_to: item.role ? byRole.get(item.role.toLowerCase()) ?? null : null,
        due_date: due ? `${due}T17:00:00` : null,
        position: item.position,
      });
    } else if (item.kind === "asset") {
      if (haveAssets.has(item.title.toLowerCase())) continue;
      assetRows.push({
        project_id: projectId,
        title: item.title,
        description: item.detail,
        category: asAssetCategory(item.category),
        required: item.required,
        position: item.position,
        source: "team" as const,
      });
    } else {
      const key = `${item.kind}:${item.title.toLowerCase()}`;
      if (haveMilestones.has(key)) continue;
      milestoneRows.push({
        project_id: projectId,
        title: item.title,
        detail: item.detail,
        kind: item.kind as "milestone" | "launch_check",
        due_date: dateFor(item.offset_days),
        position: item.position,
        client_visible: item.kind === "milestone",
        owner_id: item.role ? byRole.get(item.role.toLowerCase()) ?? null : null,
      });
    }
  }

  if (todoRows.length) {
    const { error } = await supabase.from("todos").insert(todoRows);
    if (error) return { ok: false, error: error.message };
  }
  if (assetRows.length) {
    const { error } = await supabase
      .from("project_document_requests")
      .insert(assetRows);
    if (error) return { ok: false, error: error.message };
  }
  if (milestoneRows.length) {
    const { error } = await supabase
      .from("project_milestones")
      .insert(milestoneRows);
    if (error) return { ok: false, error: error.message };
  }

  await supabase
    .from("projects")
    .update({ template_id: templateId })
    .eq("id", projectId);

  return {
    ok: true,
    tasks: todoRows.length,
    assets: assetRows.length,
    milestones: milestoneRows.filter((m) => m.kind === "milestone").length,
    checks: milestoneRows.filter((m) => m.kind === "launch_check").length,
  };
}
