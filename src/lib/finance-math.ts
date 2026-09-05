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
  payments: {
    amount: number | string;
    paid_at?: string | null;
    created_at: string;
    /** For the export's description column. */
    notes?: string | null;
  }[];
  /** `payment_installments` — every status; only paid ones count. */
  installments: {
    amount: number | string;
    status: string;
    paid_at?: string | null;
    due_date: string;
    seq?: number;
    plan_id?: string;
  }[];
  /** `recurring_income` with its entries. */
  recurring: {
    id?: string;
    label?: string;
    entries: {
      amount: number | string;
      status: string;
      received_on?: string | null;
      due_date: string;
      period?: string;
    }[];
  }[];
};

/** One received amount with enough words to print on an export line. */
export type InflowLine = CashRow & {
  kind: "payment" | "installment" | "recurring";
  description: string;
  /** The plan (instalment) or arrangement (recurring) it came from. */
  ref: string | null;
};

/** "September 2026" for any date in the month. UTC, so it never shifts. */
export function monthLabel(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Every rupee actually received, dated and described — one line per
 * payment, per paid instalment, per received recurring month.
 *
 * This is what the Tax export prints. `monthlyInflows()` below is exactly
 * these lines with the words dropped, which is how Finance Overview's total
 * and the Tax tab's total are the same number by construction: the Tax tab
 * used to build its own income list from payments and instalments only, and
 * a received recurring month made the two tabs disagree.
 */
export function inflowLines(sources: InflowSources): InflowLine[] {
  return [
    ...sources.payments.map((p): InflowLine => ({
      date: (p.paid_at ?? p.created_at).slice(0, 10),
      amount: num(p.amount),
      kind: "payment",
      description: p.notes?.trim() || "Project payment",
      ref: null,
    })),
    ...sources.installments
      .filter((i) => i.status === "paid")
      .map((i): InflowLine => ({
        date: (i.paid_at ?? i.due_date).slice(0, 10),
        amount: num(i.amount),
        kind: "installment",
        description: i.seq ? `Installment #${i.seq}` : "Installment",
        ref: i.plan_id ?? null,
      })),
    ...sources.recurring.flatMap((r) =>
      (r.entries ?? [])
        .filter((e) => e.status === "received")
        .map((e): InflowLine => ({
          date: (e.received_on ?? e.due_date).slice(0, 10),
          amount: num(e.amount),
          kind: "recurring",
          description: `${r.label?.trim() || "Recurring"} — ${monthLabel(e.period ?? e.due_date)}`,
          ref: r.id ?? null,
        })),
    ),
  ];
}

/**
 * Every rupee actually received, dated.
 *
 * The rule that matters: only money that ARRIVED. A pending installment is a
 * promise, and a promise in a cash-flow chart is how a month looks fine right
 * up until payroll. Forecasting is a separate function, and says so.
 */
export function monthlyInflows(sources: InflowSources): CashRow[] {
  return inflowLines(sources).map(({ date, amount }) => ({ date, amount }));
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

export type ProfitAndLossRow = {
  month: string;
  inflow: number;
  outflow: number;
  /** Commission payout runs in the month — INSIDE `outflow`, not on top of it. */
  payouts: number;
  net: number;
};

/**
 * The month as one line: in, out, net (T4.9).
 *
 * A payout run writes its own `expenses` row (category `commission`), so the
 * money is already in `outflows`. The payouts column is shown so the owner
 * can see how much of the month's spend was the team's commission; it is
 * never subtracted a second time. Net is inflow − outflow, full stop.
 */
export function profitAndLoss(input: {
  months: string[];
  inflows: CashRow[];
  outflows: CashRow[];
  payouts: CashRow[];
}): ProfitAndLossRow[] {
  return input.months.map((month) => {
    const inflow = totalForMonth(input.inflows, month);
    const outflow = totalForMonth(input.outflows, month);
    return {
      month,
      inflow,
      outflow,
      payouts: totalForMonth(input.payouts, month),
      net: Math.round((inflow - outflow) * 100) / 100,
    };
  });
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

// ---------------------------------------------------------------------------
// Standing costs
// ---------------------------------------------------------------------------

export type ExpenseLike = {
  expense_date: string;
  amount: number | string;
  vendor?: string | null;
  description: string;
};

export type StandingCost = {
  /** The vendor, or the description when there is no vendor. */
  name: string;
  /** The typical monthly amount — the median of what was actually paid. */
  amount: number;
  /** Day of the month it usually lands on. */
  day: number;
};

const DAY_MS = 86_400_000;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The costs that come back every month, worked out from the ledger rather
 * than declared.
 *
 * There is no "recurring" flag on an expense, and asking people to maintain
 * one is how the flag ends up wrong. Instead: the same vendor (or, failing a
 * vendor, the same description) paid in at least two different months of the
 * last three is a standing cost. Rent, salaries, hosting and software all
 * pass that test; a one-off laptop does not.
 */
export function detectStandingCosts(expenses: ExpenseLike[], now: Date): StandingCost[] {
  const since = new Date(now.getTime() - 92 * DAY_MS).toISOString().slice(0, 10);
  const groups = new Map<
    string,
    { name: string; months: Set<string>; amounts: number[]; days: number[] }
  >();

  for (const e of expenses) {
    if (e.expense_date < since) continue;
    const name = (e.vendor?.trim() || e.description.trim()).replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { name, months: new Set(), amounts: [], days: [] };
    group.months.add(monthKey(e.expense_date));
    group.amounts.push(num(e.amount));
    group.days.push(Number(e.expense_date.slice(8, 10)) || 1);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((g) => g.months.size >= 2)
    .map((g) => ({
      name: g.name,
      amount: median(g.amounts),
      day: Math.max(1, Math.min(28, Math.round(median(g.days)))),
    }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * The standing costs, dated forward.
 *
 * One row per cost per month, on its usual day, for the current month (when
 * that day is still ahead and nothing has been paid to that name yet this
 * month) and the next `months` months. Feeds forecastCash() as
 * `scheduledOut`, so rent shows in the week it falls rather than being
 * smeared across the run rate.
 */
export function projectStandingCosts(
  expenses: ExpenseLike[],
  now: Date,
  months = 4,
): CashRow[] {
  const costs = detectStandingCosts(expenses, now);
  if (!costs.length) return [];

  const today = now.toISOString().slice(0, 10);
  const thisMonth = monthKey(today);
  const paidThisMonth = new Set(
    expenses
      .filter((e) => monthKey(e.expense_date) === thisMonth)
      .map((e) => (e.vendor?.trim() || e.description.trim()).toLowerCase()),
  );

  const out: CashRow[] = [];
  for (const cost of costs) {
    for (let i = 0; i <= months; i++) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const date = `${month.toISOString().slice(0, 7)}-${String(cost.day).padStart(2, "0")}`;
      if (i === 0) {
        // Already paid this month, or the day has passed: nothing more to expect.
        if (date < today || paidThisMonth.has(cost.name.toLowerCase())) continue;
      }
      out.push({ date, amount: cost.amount });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
