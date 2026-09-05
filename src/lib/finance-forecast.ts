import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  detectStandingCosts,
  forecastCash,
  monthlyInflows,
  monthlyOutflows,
  projectStandingCosts,
  type ForecastWeek,
  type StandingCost,
} from "@/lib/finance-math";

type DB = SupabaseClient<Database>;

/**
 * The 90-day cash view (0119), assembled once for every screen that shows it.
 *
 * Intelligence's Forecast tab and the Finance overview read the same object,
 * so they cannot disagree. All of the arithmetic is in finance-math.ts and
 * tested there; this file only decides which rows to feed it:
 *
 *   in, committed   — unpaid instalments and pending recurring months with a
 *                     due date ahead of today. (Open invoices join once 0120
 *                     gives an invoice a due date.)
 *   in, run rate    — what actually arrived over the last 90 days, through
 *                     monthlyInflows(), the one definition of "money in".
 *   out, committed  — standing costs, worked out from the ledger.
 *   out, run rate   — everything spent over the last 90 days.
 */

export type CashForecast = {
  weeks: ForecastWeek[];
  /** The standing costs the projection assumed, largest first. */
  standing: StandingCost[];
  /** ISO date the forecast was built for. */
  asOf: string;
};

const LOOKBACK_DAYS = 120;
const LOOKAHEAD_DAYS = 120;

export async function loadCashForecast(
  db: DB,
  now = new Date(),
  weeks = 13,
): Promise<CashForecast> {
  const today = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const until = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000).toISOString().slice(0, 10);

  const [paymentsRes, installmentsRes, recurringRes, expensesRes] = await Promise.all([
    db
      .from("payments")
      .select("amount, paid_at, created_at")
      .eq("status", "paid")
      .gte("created_at", `${since}T00:00:00Z`)
      .limit(2000),
    db
      .from("payment_installments")
      .select("amount, status, paid_at, due_date")
      .gte("due_date", since)
      .lte("due_date", until)
      .limit(2000),
    db
      .from("recurring_income")
      .select("entries:recurring_income_entries(amount, status, received_on, due_date)")
      .limit(500),
    db
      .from("expenses")
      .select("expense_date, amount, vendor, description")
      .gte("expense_date", since)
      .limit(3000),
  ]);

  const payments = paymentsRes.data ?? [];
  const installments = installmentsRes.data ?? [];
  const recurring = (recurringRes.data ?? []) as unknown as {
    entries: { amount: number | string; status: string; received_on: string | null; due_date: string }[];
  }[];
  const expenses = expensesRes.data ?? [];

  const scheduledIn = [
    ...installments
      .filter((i) => i.status === "pending" && i.due_date >= today)
      .map((i) => ({ date: i.due_date, amount: Number(i.amount) || 0 })),
    ...recurring.flatMap((r) =>
      (r.entries ?? [])
        .filter((e) => e.status === "pending" && e.due_date >= today)
        .map((e) => ({ date: e.due_date.slice(0, 10), amount: Number(e.amount) || 0 })),
    ),
  ];

  return {
    weeks: forecastCash(
      {
        scheduledIn,
        scheduledOut: projectStandingCosts(expenses, now),
        historyIn: monthlyInflows({ payments, installments, recurring }),
        historyOut: monthlyOutflows(expenses),
      },
      now,
      weeks,
    ),
    standing: detectStandingCosts(expenses, now),
    asOf: today,
  };
}
