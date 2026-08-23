import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { balanceDue, projectMargin, settledAmount } from "@/lib/projects";

type DB = SupabaseClient<Database>;

/**
 * What past projects actually cost, took and kept (AI-2, AI-6).
 *
 * The arithmetic behind both the estimate and the post-mortem, kept out of
 * either so they can never disagree about what "a business website usually
 * takes" means. No model is involved here at all — this is the ground truth
 * the model is then asked to explain.
 *
 * Every figure goes through `src/lib/projects.ts`, because deposit_paid and
 * the payment rows are the same money (invariant 1).
 */

export type FinishedProject = {
  id: string;
  name: string;
  serviceType: string | null;
  currency: string;
  quoted: number;
  received: number;
  expenses: number;
  commissions: number;
  profit: number;
  marginPercent: number | null;
  /** Calendar days from start to delivery. Null when either date is missing. */
  days: number | null;
  /** Billable extras raised after the project started. */
  extras: number;
  deliveredOn: string | null;
};

export type ServiceBenchmark = {
  serviceType: string;
  count: number;
  medianDays: number | null;
  medianQuoted: number;
  medianExtras: number;
  medianMarginPercent: number | null;
  currency: string;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Every project that actually finished, with what it really cost.
 *
 * "Finished" means completed or delivered — a cancelled project teaches you
 * about sales, not about delivery, and including it would drag every
 * benchmark toward zero.
 */
export async function finishedProjects(
  supabase: DB,
  opts?: { serviceType?: string | null; limit?: number },
): Promise<FinishedProject[]> {
  let q = supabase
    .from("projects")
    .select(
      "id, name, service_type, currency, total_value, deposit_paid, start_date, status, delivery_stage, delivery_stage_changed_at, payments(amount, status), company_payments(price_lkr, is_paid)",
    )
    .is("deleted_at", null)
    .or("status.eq.completed,delivery_stage.eq.delivered,delivery_stage.eq.aftercare")
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 60);

  if (opts?.serviceType) q = q.eq("service_type", opts.serviceType);

  const { data: rows } = await q;
  if (!rows?.length) return [];

  const ids = rows.map((r) => r.id);
  const [{ data: expenses }, { data: commissions }] = await Promise.all([
    supabase
      .from("project_expenses")
      .select("project_id, amount, billable")
      .in("project_id", ids),
    supabase
      .from("commissions")
      .select("project_id, amount, percentage, basis")
      .in("project_id", ids),
  ]);

  return rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = row as any;
    const received = settledAmount({
      deposit_paid: r.deposit_paid,
      payments: r.payments ?? [],
      company_payments: r.company_payments ?? [],
    });
    const mine = (expenses ?? []).filter((e) => e.project_id === r.id);
    const myCommissions = (commissions ?? []).filter((c) => c.project_id === r.id);

    const margin = projectMargin({
      totalValue: Number(r.total_value) || 0,
      expenses: mine,
      commissions: myCommissions.map((c) => ({
        // Percent-basis commissions are earned against what came IN, so the
        // historical figure has to be worked out the same way the live one is.
        amount:
          c.basis === "percent_of_received" && c.percentage
            ? (received * Number(c.percentage)) / 100
            : Number(c.amount) || 0,
      })),
    });

    const days =
      r.start_date && r.delivery_stage_changed_at
        ? Math.max(
            0,
            Math.round(
              (Date.parse(r.delivery_stage_changed_at) -
                Date.parse(`${r.start_date}T00:00:00Z`)) /
                (24 * 3600_000),
            ),
          )
        : null;

    return {
      id: r.id,
      name: r.name,
      serviceType: r.service_type,
      currency: r.currency || "LKR",
      quoted: Number(r.total_value) || 0,
      received,
      expenses: margin.expenses,
      commissions: margin.commissions,
      profit: margin.profit,
      marginPercent: margin.percent,
      days,
      extras: mine
        .filter((e) => e.billable)
        .reduce((sum, e) => sum + Number(e.amount ?? 0), 0),
      deliveredOn: r.delivery_stage_changed_at ?? null,
    };
  });
}

/**
 * Benchmarks per service type.
 *
 * Medians, not means: one job that ran three months over a public holiday
 * should not become "how long a website takes". A service type with fewer
 * than two finished projects is dropped — an average of one is an anecdote.
 */
export function benchmarkByService(
  projects: FinishedProject[],
): ServiceBenchmark[] {
  const groups = new Map<string, FinishedProject[]>();
  for (const p of projects) {
    const key = p.serviceType || "other";
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  return [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([serviceType, list]) => ({
      serviceType,
      count: list.length,
      medianDays: median(
        list.map((p) => p.days).filter((d): d is number => d !== null),
      ),
      medianQuoted: median(list.map((p) => p.quoted)) ?? 0,
      medianExtras: median(list.map((p) => p.extras)) ?? 0,
      medianMarginPercent: median(
        list
          .map((p) => p.marginPercent)
          .filter((m): m is number => m !== null),
      ),
      currency: list[0].currency,
    }))
    .sort((a, b) => b.count - a.count);
}

/** One project's own numbers, for the post-mortem (AI-6). */
export async function projectOutcome(
  supabase: DB,
  projectId: string,
): Promise<{
  outcome: FinishedProject;
  stageDays: { stage: string; days: number }[];
  loggedMinutes: number;
  balance: number;
} | null> {
  const [one] = await finishedProjects(supabase, { limit: 1 }).then((all) =>
    all.filter((p) => p.id === projectId),
  );

  // The project may not be "finished" by the query's definition yet — a
  // post-mortem asked for by hand should still work, so fall back to a
  // direct read.
  const outcome =
    one ??
    (await finishedProjects(supabase, { limit: 200 }).then((all) =>
      all.find((p) => p.id === projectId),
    ));
  if (!outcome) return null;

  const [{ data: events }, { data: time }, { data: project }] = await Promise.all([
    supabase
      .from("delivery_events")
      .select("meta, created_at")
      .eq("project_id", projectId)
      .eq("kind", "stage_changed")
      .order("created_at", { ascending: true }),
    supabase.from("time_entries").select("minutes").eq("project_id", projectId),
    supabase
      .from("projects")
      .select("total_value, deposit_paid, payments(amount, status), company_payments(price_lkr, is_paid)")
      .eq("id", projectId)
      .maybeSingle(),
  ]);

  const stageDays: { stage: string; days: number }[] = [];
  const list = events ?? [];
  for (let i = 0; i < list.length - 1; i++) {
    const stage = (list[i].meta as { new_stage?: string } | null)?.new_stage;
    if (!stage) continue;
    stageDays.push({
      stage,
      days: Math.max(
        0,
        Math.round(
          (Date.parse(list[i + 1].created_at) - Date.parse(list[i].created_at)) /
            (24 * 3600_000),
        ),
      ),
    });
  }

  return {
    outcome,
    stageDays,
    loggedMinutes: (time ?? []).reduce((sum, t) => sum + Number(t.minutes ?? 0), 0),
    balance: project
      ? balanceDue({
          total_value: project.total_value,
          deposit_paid: project.deposit_paid,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payments: (project as any).payments ?? [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          company_payments: (project as any).company_payments ?? [],
        })
      : 0,
  };
}
