import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, TargetKind } from "@/lib/database.types";
import { monthlyInflows, totalForMonth } from "@/lib/finance-math";

type DB = SupabaseClient<Database>;

/**
 * Targets, and how the month is actually going (0119).
 *
 * The dashboard reported what happened. Nothing said what was supposed to
 * happen, so "are we having a good month?" was a feeling somebody had, and
 * two people could hold opposite ones from the same numbers.
 *
 * Revenue reads through monthlyInflows() rather than counting rows here — the
 * Finance page's total and this one have to be the same number, or the
 * feature makes things worse rather than better.
 */

export type TargetProgress = {
  kind: TargetKind;
  /** null = the whole team. */
  userId: string | null;
  name: string | null;
  target: number;
  actual: number;
  /** 0-100+, uncapped: beating a target is worth seeing. */
  percent: number;
};

/** `2026-09-01` — the shape `targets.period` stores. */
export function periodFor(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

/**
 * Every target for a month, with what has actually happened against it.
 *
 * A target with no matching actual still comes back, at zero — a goal nobody
 * has moved on is exactly the one worth showing.
 */
export async function targetsProgress(
  db: DB,
  period: string,
): Promise<TargetProgress[]> {
  const month = period.slice(0, 7);
  const monthStart = `${month}-01`;
  const next = new Date(`${monthStart}T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const monthEnd = next.toISOString().slice(0, 10);

  const { data: targets } = await db
    .from("targets")
    .select("id, user_id, period, kind, amount")
    .eq("period", monthStart);
  if (!targets?.length) return [];

  const wanted = new Set(targets.map((t) => t.kind));

  const [revenue, deals, deliveries, leads, hours, names] = await Promise.all([
    wanted.has("revenue") ? revenueFor(db, month) : Promise.resolve(new Map()),
    wanted.has("deals_won")
      ? countBy(db, "leads", "assigned_to", "won_at", monthStart, monthEnd)
      : Promise.resolve(new Map()),
    wanted.has("deliveries") ? deliveriesFor(db, monthStart, monthEnd) : Promise.resolve(new Map()),
    wanted.has("leads")
      ? countBy(db, "leads", "assigned_to", "created_at", monthStart, monthEnd)
      : Promise.resolve(new Map()),
    wanted.has("hours") ? hoursFor(db, monthStart, monthEnd) : Promise.resolve(new Map()),
    memberNames(db, targets.map((t) => t.user_id).filter(Boolean) as string[]),
  ]);

  const actualFor = (kind: TargetKind, userId: string | null): number => {
    const source =
      kind === "revenue"
        ? revenue
        : kind === "deals_won"
          ? deals
          : kind === "deliveries"
            ? deliveries
            : kind === "leads"
              ? leads
              : hours;
    // A team target is the sum of everybody's, including work nobody owns.
    if (!userId) {
      return [...source.values()].reduce((sum, n) => sum + n, 0);
    }
    return source.get(userId) ?? 0;
  };

  return targets
    .map((t) => {
      const target = Number(t.amount) || 0;
      const actual = actualFor(t.kind, t.user_id);
      return {
        kind: t.kind,
        userId: t.user_id,
        name: t.user_id ? (names.get(t.user_id) ?? "Someone") : null,
        target,
        actual,
        percent: target > 0 ? Math.round((actual / target) * 100) : 0,
      };
    })
    .sort((a, b) => {
      // Team targets first, then by how far behind — the ones that need
      // attention are the ones worth reading first.
      if (!a.userId && b.userId) return -1;
      if (a.userId && !b.userId) return 1;
      return a.percent - b.percent;
    });
}

/**
 * Revenue per person for a month.
 *
 * Attributed to whoever owns the PROJECT, since that is who was responsible
 * for the work the money paid for. Money against no project counts toward the
 * team total but nobody's personal one — inventing an owner for it would be
 * worse than leaving it unattributed.
 */
async function revenueFor(db: DB, month: string): Promise<Map<string, number>> {
  const [paymentsRes, installmentsRes, recurringRes] = await Promise.all([
    db
      .from("payments")
      .select("amount, status, paid_at, created_at, project_id")
      .eq("status", "paid"),
    // An instalment belongs to a PLAN, and the plan to a project — there is
    // no project_id on the instalment itself.
    db
      .from("payment_installments")
      .select("amount, status, paid_at, due_date, plan:payment_plans(project_id)"),
    db
      .from("recurring_income")
      .select("project_id, entries:recurring_income_entries(amount, status, received_on, due_date)"),
  ]);

  const payments = paymentsRes.data ?? [];
  const installments = (installmentsRes.data ?? []) as unknown as {
    amount: number | string;
    status: string;
    paid_at: string | null;
    due_date: string;
    plan: { project_id: string | null } | null;
  }[];
  const recurring = (recurringRes.data ?? []) as unknown as {
    project_id: string | null;
    entries: {
      amount: number | string;
      status: string;
      received_on: string | null;
      due_date: string;
    }[];
  }[];

  // Project owners, so revenue lands on a person.
  const projectIds = [
    ...new Set(
      [
        ...payments.map((p) => p.project_id),
        ...installments.map((i) => i.plan?.project_id ?? null),
        ...recurring.map((r) => r.project_id),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const owners = new Map<string, string>();
  if (projectIds.length) {
    const { data } = await db
      .from("projects")
      .select("id, created_by")
      .in("id", projectIds);
    for (const p of data ?? []) if (p.created_by) owners.set(p.id, p.created_by);
  }

  const byOwner = new Map<string, number>();
  const add = (projectId: string | null, rows: { date: string; amount: number }[]) => {
    const total = totalForMonth(rows, month);
    if (!total) return;
    // "" is the bucket for unowned money: it still counts toward the team.
    const key = (projectId && owners.get(projectId)) || "";
    byOwner.set(key, (byOwner.get(key) ?? 0) + total);
  };

  for (const p of payments) {
    add(p.project_id, monthlyInflows({ payments: [p], installments: [], recurring: [] }));
  }
  for (const i of installments) {
    add(
      i.plan?.project_id ?? null,
      monthlyInflows({ payments: [], installments: [i], recurring: [] }),
    );
  }
  for (const r of recurring) {
    add(r.project_id, monthlyInflows({ payments: [], installments: [], recurring: [r] }));
  }
  return byOwner;
}

/** Rows in a month, grouped by a person column. */
async function countBy(
  db: DB,
  table: "leads",
  ownerColumn: "assigned_to",
  dateColumn: "won_at" | "created_at",
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const { data } = await db
    .from(table)
    .select(`${ownerColumn}, ${dateColumn}`)
    .gte(dateColumn, from)
    .lt(dateColumn, to)
    .is("deleted_at", null)
    .limit(2000);

  const out = new Map<string, number>();
  for (const row of (data ?? []) as Record<string, string | null>[]) {
    const owner = row[ownerColumn] ?? "";
    out.set(owner, (out.get(owner) ?? 0) + 1);
  }
  return out;
}

/** Projects delivered in the month, by project owner. */
async function deliveriesFor(
  db: DB,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const { data } = await db
    .from("delivery_events")
    .select("project_id, kind, created_at")
    .eq("kind", "assets_complete")
    .gte("created_at", from)
    .lt("created_at", to)
    .limit(1000);

  const projectIds = [...new Set((data ?? []).map((e) => e.project_id))];
  if (!projectIds.length) return new Map();

  const { data: projects } = await db
    .from("projects")
    .select("id, created_by")
    .in("id", projectIds);
  const owners = new Map((projects ?? []).map((p) => [p.id, p.created_by ?? ""]));

  const out = new Map<string, number>();
  for (const e of data ?? []) {
    const owner = owners.get(e.project_id) ?? "";
    out.set(owner, (out.get(owner) ?? 0) + 1);
  }
  return out;
}

/** Hours logged in the month, per member. */
async function hoursFor(db: DB, from: string, to: string): Promise<Map<string, number>> {
  const { data } = await db
    .from("time_entries")
    .select("user_id, minutes, worked_on")
    .gte("worked_on", from)
    .lt("worked_on", to)
    .limit(5000);

  const out = new Map<string, number>();
  for (const e of data ?? []) {
    const key = e.user_id ?? "";
    out.set(key, (out.get(key) ?? 0) + Number(e.minutes ?? 0) / 60);
  }
  // Whole hours read better than 7.316666.
  for (const [k, v] of out) out.set(k, Math.round(v * 10) / 10);
  return out;
}

async function memberNames(db: DB, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { data } = await db
    .from("profiles")
    .select("id, full_name")
    .in("id", [...new Set(ids)]);
  return new Map((data ?? []).map((p) => [p.id, p.full_name]));
}
