import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { ProjectsView, type ProjectCard } from "./projects-view";

export const metadata = { title: "Projects" };

/**
 * The board's data.
 *
 * Everything a card needs to answer "is this job healthy and is it making
 * money" is aggregated here rather than fetched per card: the workspace is
 * single-tenant and these are small tables, so a handful of flat reads beats
 * N round-trips and lets the filters and sorts run on real numbers.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const supabase = await createClient();
  const { archived } = await searchParams;
  const showArchived = archived === "1";

  // Built in two steps so the archive filter reads as what it is.
  let projectQuery = supabase
    .from("projects")
    // company_payments carry the money actually received against a project
    // (0083); `payments` is the project's own ledger (0006). Both count.
    .select(
      "*, client:clients(id, name, company), payments(id, amount, status, paid_at, method, notes), company_payments(id, price_lkr, is_paid, created_at, company_name)",
    );
  // 0090 — the archive is its own view.
  projectQuery = showArchived
    ? projectQuery.not("deleted_at", "is", null)
    : projectQuery.is("deleted_at", null);

  const [
    profile,
    projectsRes,
    clientsRes,
    expensesRes,
    membersRes,
    tasksRes,
    assetsRes,
    milestonesRes,
    commissionsRes,
    savedViewsRes,
  ] = await Promise.all([
    requireProfile(),
    projectQuery.order("created_at", { ascending: false }),
    supabase.from("clients").select("id, name, company").order("name"),
    supabase.from("project_expenses").select("project_id, amount, billable"),
    supabase
      .from("project_members")
      .select(
        "project_id, user_id, is_owner, profile:profiles!project_members_user_id_fkey(id, full_name, avatar_url)",
      ),
    supabase
      .from("todos")
      .select("project_id, status, due_date")
      .not("project_id", "is", null),
    supabase
      .from("project_document_requests")
      .select("project_id, status, required"),
    supabase
      .from("project_milestones")
      .select("project_id, status, due_date, kind"),
    supabase
      .from("commissions")
      .select("project_id, amount, percentage, basis"),
    // VIEW-2 (0097) — saved filter sets. Scoping happens below rather than in
    // the query: RLS is workspace-wide here, so the private/shared split is
    // applied against the profile we just resolved.
    supabase
      .from("project_views")
      .select("id, name, filters, owner_id, shared")
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  // A private view is only listed for the person who made it.
  const savedViews = (savedViewsRes.data ?? []).filter(
    (v) => v.shared || !v.owner_id || v.owner_id === profile.id,
  );

  return (
    <ProjectsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects={(projectsRes.data ?? []) as any as ProjectCard[]}
      clients={clientsRes.data ?? []}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expenses={(expensesRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team={(membersRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tasks={(tasksRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assets={(assetsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      milestones={(milestonesRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      savedViews={savedViews as any}
      isAdmin={profile.role === "admin"}
      showArchived={showArchived}
    />
  );
}
