import { allEstimates } from "@/lib/ai/project-estimate";
import { requireProfile } from "@/lib/auth";
import { allFinanceProjectCosts } from "@/lib/project-costs";
import { getMembers } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";

import { ReportsView } from "./reports-view";

export const metadata = { title: "Project reports" };

/**
 * What the projects add up to (MON-10, PLAN-4, PLAN-6).
 *
 * Three questions the month board can't answer: which work actually makes
 * money, who is carrying how much of it, and what lands when.
 */
export default async function ProjectReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const supabase = await createClient();
  const { tab } = await searchParams;

  const [
    profile,
    members,
    projectsRes,
    expensesRes,
    financeCosts,
    commissionsRes,
    timeRes,
    teamRes,
    tasksRes,
    costRatesRes,
    stageEventsRes,
    estimates,
  ] = await Promise.all([
    requireProfile(),
    getMembers(),
    supabase
      .from("projects")
      .select(
        "id, name, status, service_type, currency, total_value, deposit_paid, budget, start_date, due_date, created_at, delivery_stage, client:clients(id, name), payments(amount, status), company_payments(price_lkr, is_paid)",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase.from("project_expenses").select("project_id, amount, billable, category"),
    // 0100 — the company ledger's share of each project's cost.
    allFinanceProjectCosts(supabase),
    supabase
      .from("commissions")
      .select("project_id, amount, percentage, basis"),
    supabase.from("time_entries").select("project_id, user_id, minutes"),
    supabase.from("project_members").select("project_id, user_id, is_owner"),
    supabase
      .from("todos")
      .select("project_id, assigned_to, status, due_date")
      .not("project_id", "is", null),
    supabase.from("profiles").select("id, hourly_cost"),
    // VIEW-3 — every stage change ever recorded (0084). The whole of
    // cycle-time analytics is a read over this one table.
    supabase
      .from("delivery_events")
      .select("project_id, kind, meta, created_at")
      .eq("kind", "stage_changed")
      .order("created_at", { ascending: true }),
    // AI-2 — medians per service type. Arithmetic, so it loads with the page.
    allEstimates(supabase),
  ]);

  // 0100 — both cost ledgers. Finance costs carry no project-expense category,
  // so they land under the breakdown's "other" rather than pretending to one
  // they never had.
  const reportExpenses = [
    ...(expensesRes.data ?? []),
    ...financeCosts.map((c) => ({ ...c, category: null })),
  ];

  return (
    <ReportsView
      isAdmin={profile.role === "admin"}
      members={members}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects={(projectsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expenses={reportExpenses as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commissions={(commissionsRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      time={(timeRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team={(teamRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tasks={(tasksRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      costRates={(costRatesRes.data ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stageEvents={(stageEventsRes.data ?? []) as any}
      estimates={estimates}
      initialTab={tab}
    />
  );
}
