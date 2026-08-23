import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * What a project actually cost — from BOTH ledgers (0100).
 *
 * A project's costs live in two tables and always have:
 *
 *   • `project_expenses` (0087) — costs raised on the project. Most are
 *     billable extras that go onto the client's invoice, so they appear on
 *     both sides of the margin and net to zero.
 *   • `expenses` (0021) — the company ledger. Salaries, rent, software,
 *     hosting, ads. Until 0100 these belonged to nothing, so a project whose
 *     real costs were all booked in Finance read as pure profit.
 *
 * `projectMargin()` takes one list, so somebody has to merge them. That
 * somebody is this file, and only this file — margin appears on the board,
 * the project page, the profitability report, the risk radar, the budget
 * alert and two AI features, and seven call sites each doing their own
 * merge is how they drift apart.
 *
 * A Finance expense is always ABSORBED (`billable: false`). The agency paid
 * it and is not re-billing it; anything meant to go back on the invoice
 * belongs in `project_expenses`, where `billable` says exactly that. That
 * keeps the two ledgers distinct and stops a cost being counted twice.
 */

/** The shape `projectMargin()` consumes. */
export type ProjectCostRow = {
  project_id: string;
  amount: number;
  billable: boolean;
  /** Which ledger it came from — the UI says so rather than blurring them. */
  source: "project" | "finance";
  description: string;
  category: string | null;
  incurred_on: string;
};

/**
 * Every cost for a set of projects, keyed by project id.
 *
 * Two flat reads rather than a join: both tables are small, and a project
 * with no costs in one of them must still come back with the other.
 */
export async function projectCostsByProject(
  supabase: DB,
  projectIds: string[],
): Promise<Map<string, ProjectCostRow[]>> {
  const map = new Map<string, ProjectCostRow[]>();
  if (projectIds.length === 0) return map;

  const push = (row: ProjectCostRow) => {
    const list = map.get(row.project_id);
    if (list) list.push(row);
    else map.set(row.project_id, [row]);
  };

  const [own, finance] = await Promise.all([
    supabase
      .from("project_expenses")
      .select("project_id, amount, billable, description, category, incurred_on")
      .in("project_id", projectIds),
    supabase
      .from("expenses")
      .select("project_id, amount, description, category, expense_date")
      .in("project_id", projectIds),
  ]);

  for (const e of own.data ?? []) {
    push({
      project_id: e.project_id,
      amount: Number(e.amount ?? 0),
      billable: e.billable ?? true,
      source: "project",
      description: e.description,
      category: e.category,
      incurred_on: e.incurred_on,
    });
  }

  for (const e of finance.data ?? []) {
    if (!e.project_id) continue;
    push({
      project_id: e.project_id,
      amount: Number(e.amount ?? 0),
      // Never billable — see the header.
      billable: false,
      source: "finance",
      description: e.description,
      category: e.category,
      incurred_on: e.expense_date,
    });
  }

  return map;
}

/** One project's costs, for the pages that only ever load one. */
export async function projectCosts(
  supabase: DB,
  projectId: string,
): Promise<ProjectCostRow[]> {
  const map = await projectCostsByProject(supabase, [projectId]);
  return map.get(projectId) ?? [];
}

/**
 * The Finance half only, for the places that already have `project_expenses`
 * loaded and just need what Finance adds.
 *
 * Returned in `projectMargin()`'s shape so a caller can concatenate without
 * thinking about it.
 */
export async function financeCostsByProject(
  supabase: DB,
  projectIds: string[],
): Promise<Map<string, { amount: number; billable: boolean }[]>> {
  const map = new Map<string, { amount: number; billable: boolean }[]>();
  if (projectIds.length === 0) return map;

  const { data } = await supabase
    .from("expenses")
    .select("project_id, amount")
    .in("project_id", projectIds);

  for (const e of data ?? []) {
    if (!e.project_id) continue;
    const row = { amount: Number(e.amount ?? 0), billable: false };
    const list = map.get(e.project_id);
    if (list) list.push(row);
    else map.set(e.project_id, [row]);
  }
  return map;
}

/** Flat list of Finance costs across every project, for board-wide reads. */
export async function allFinanceProjectCosts(
  supabase: DB,
): Promise<{ project_id: string; amount: number; billable: boolean }[]> {
  const { data } = await supabase
    .from("expenses")
    .select("project_id, amount")
    .not("project_id", "is", null);

  return (data ?? [])
    .filter((e): e is typeof e & { project_id: string } => !!e.project_id)
    .map((e) => ({
      project_id: e.project_id,
      amount: Number(e.amount ?? 0),
      billable: false,
    }));
}
