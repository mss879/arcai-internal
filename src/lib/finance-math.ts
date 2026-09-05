/**
 * The money-in and money-out arrays, computed once (0119).
 *
 * Three screens now need to know what came in and when: Finance Overview's
 * chart, the Tax page's totals, and targets-vs-actual. They were each about
 * to build their own version of "an inflow", and the moment two of them
 * disagree the whole page becomes untrustworthy — the same failure the money
 * maths in projects.ts exists to prevent.
 *
 * So there is one definition of an inflow, here, and everything reads it.
 *
 * Client-safe and pure: no Supabase import, no `server-only`. The caller
 * fetches; this decides what counts.
 */

/** One dated amount. Dates are `YYYY-MM-DD`, so they sort and group as text. */
export type CashRow = { date: string; amount: number };

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** `2026-09` from any ISO-ish date. */
export function monthKey(date: string): string {
  return (date ?? "").slice(0, 7);
}

/** The first day of a month, as the `targets.period` column stores it. */
export function periodStart(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

export type InflowSources = {
  /** `payments` rows already filtered to paid. */
  payments: { amount: number | string; paid_at?: string | null; created_at: string }[];
  /** `payment_installments` — every status; only paid ones count. */
  installments: {
    amount: number | string;
    status: string;
    paid_at?: string | null;
    due_date: string;
  }[];
  /** `recurring_income` with its entries. */
  recurring: {
    entries: {
      amount: number | string;
      status: string;
      received_on?: string | null;
      due_date: string;
    }[];
  }[];
};

/**
 * Every rupee actually received, dated.
 *
 * The rule that matters: only money that ARRIVED. A pending installment is a
 * promise, and a promise in a cash-flow chart is how a month looks fine right
 * up until payroll. Forecasting is a separate function, and says so.
 */
export function monthlyInflows(sources: InflowSources): CashRow[] {
  return [
    ...sources.payments.map((p) => ({
      date: (p.paid_at ?? p.created_at).slice(0, 10),
      amount: num(p.amount),
    })),
    ...sources.installments
      .filter((i) => i.status === "paid")
      .map((i) => ({
        date: (i.paid_at ?? i.due_date).slice(0, 10),
        amount: num(i.amount),
      })),
    ...sources.recurring.flatMap((r) =>
      (r.entries ?? [])
        .filter((e) => e.status === "received")
        .map((e) => ({
          date: (e.received_on ?? e.due_date).slice(0, 10),
          amount: num(e.amount),
        })),
    ),
  ];
}

/** Money out. Expenses are already "spent" by the time they are a row. */
export function monthlyOutflows(
  expenses: { expense_date: string; amount: number | string }[],
): CashRow[] {
  return expenses.map((e) => ({
    date: e.expense_date,
    amount: num(e.amount),
  }));
}

/** Total for one `YYYY-MM`. */
export function totalForMonth(rows: CashRow[], month: string): number {
  return rows
    .filter((r) => monthKey(r.date) === month)
    .reduce((sum, r) => sum + r.amount, 0);
}

/** Totals per month, oldest first, for the last `months` months including this one. */
export function seriesByMonth(
  rows: CashRow[],
  months: string[],
): { month: string; total: number }[] {
  return months.map((month) => ({ month, total: totalForMonth(rows, month) }));
}

/** The last N month keys, oldest first, ending with the month `now` is in. */
export function recentMonths(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

export type ForecastWeek = {
  /** Monday of the week, `YYYY-MM-DD`. */
  weekStart: string;
  /** What is actually scheduled to land — instalments, recurring, invoices. */
  committed: number;
  /** Committed plus the run-rate the last few months suggest. */
  expected: number;
  outflow: number;
};

export type ForecastSources = {
  /** Dated money we have a specific reason to expect. */
  scheduledIn: CashRow[];
  /** Dated money we have a specific reason to pay. */
  scheduledOut: CashRow[];
  /** What actually came in, for the run rate. */
  historyIn: CashRow[];
  /** What actually went out, for the run rate. */
  historyOut: CashRow[];
};

/** Monday of the week `date` falls in, in UTC. */
export function weekStart(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay: 0 = Sunday. Monday-based weeks, so Sunday belongs to the week
  // that began six days earlier.
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/**
 * Cash, week by week, for the next `weeks` weeks.
 *
 * Two numbers rather than one, on purpose. `committed` is only money with a
 * date and a reason — an instalment, a recurring month, an unpaid invoice.
 * `expected` adds the run rate from recent history, which is the honest way
 * to say "and probably some more". A single blended figure hides which half
 * you are betting on, and the answer to "can we make payroll" depends
 * entirely on that.
 */
export function forecastCash(
  sources: ForecastSources,
  now: Date,
  weeks = 13,
): ForecastWeek[] {
  const thisWeek = weekStart(now);

  // Run rate from the last 90 days, per week.
  const ninetyAgo = new Date(now.getTime() - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const recentIn = sources.historyIn.filter((r) => r.date >= ninetyAgo);
  const recentOut = sources.historyOut.filter((r) => r.date >= ninetyAgo);
  const weeklyIn = recentIn.reduce((s, r) => s + r.amount, 0) / 13;
  const weeklyOut = recentOut.reduce((s, r) => s + r.amount, 0) / 13;

  const out: ForecastWeek[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(`${thisWeek}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() + i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    const inWindow = (rows: CashRow[]) =>
      rows.filter((r) => r.date >= from && r.date < to).reduce((s, r) => s + r.amount, 0);

    const committed = inWindow(sources.scheduledIn);
    out.push({
      weekStart: from,
      committed,
      // The run rate is what USUALLY happens on top of what is booked — so it
      // is added, not maxed. This week is excluded from the guess because it
      // is already partly spent.
      expected: committed + (i === 0 ? 0 : Math.max(0, weeklyIn)),
      outflow: inWindow(sources.scheduledOut) + (i === 0 ? 0 : Math.max(0, weeklyOut)),
    });
  }
  return out;
}
