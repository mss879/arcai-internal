/**
 * Project money, in one place.
 *
 * Before this file, three screens each did their own arithmetic on the same
 * project and disagreed about it:
 *
 *   • the board counted `deposit_paid` + linked PAID company_payments;
 *   • the project page did the same, then showed the project's own `payments`
 *     rows separately under the misleading label "Budget Received";
 *   • the client portal counted `total_value − deposit_paid` and ignored every
 *     payment the team had ticked off, so a client who had paid three
 *     installments still saw the original balance on their own portal.
 *
 * There is only one true answer to "what has this client paid us", so there is
 * now only one function that computes it. Three places hold that money:
 *
 *   • `projects.deposit_paid` — a summary figure typed on the project;
 *   • `payments` (0006) — the project's own itemised ledger, with receipts;
 *   • `company_payments` (0083) — rows booked on the Payments board.
 *
 * The first two describe THE SAME MONEY. In this workspace the team records a
 * payment row and bumps deposit_paid to match: at the time of writing, nine of
 * the ten projects with payment rows had deposit_paid exactly equal to the sum
 * of those rows, and the tenth had a deposit larger than its itemised part.
 * So the deposit and the payment rows are reconciled — take whichever is
 * larger, never the sum — and only the Payments board adds on top of them.
 *
 * The ledger shows the reconciliation rather than hiding it: payment rows list
 * individually, and the deposit contributes only the part they don't already
 * account for, so the rows always add up to exactly the received total.
 *
 * Client-safe on purpose: the board and the portal are client components.
 */

import type { ProjectExpense } from "@/lib/types";

// ---------------------------------------------------------------------------
// Inputs — deliberately structural, so callers can pass whatever shape their
// own query selected without casting to the full Row types.
// ---------------------------------------------------------------------------

/** A row from `public.payments` — the project's own ledger (0006). */
export type ProjectPaymentLike = {
  id?: string;
  amount: number | string;
  status?: string | null;
  paid_at?: string | null;
  method?: string | null;
  notes?: string | null;
  currency?: string | null;
  receiptUrl?: string | null;
};

/**
 * A row from `public.company_payments` linked to a project (0083).
 *
 * Note `status` there is 'pending' | 'upcoming' — it describes when the money
 * is expected, not whether it arrived. `is_paid` is the only settled flag.
 */
export type LinkedPaymentLike = {
  id?: string;
  price_lkr: number | string;
  is_paid?: boolean | null;
  created_at?: string | null;
  company_name?: string | null;
};

/**
 * The relations a `projects` query MUST select for `settledAmount()` and
 * `balanceDue()` below to be right.
 *
 * Leaving either one out doesn't fail — it silently under-counts, which is how
 * the Payments board came to show a different balance from the Projects board
 * for the same job. Every surface that reports project money selects this.
 */
export const PROJECT_MONEY_SELECT =
  "payments(id, amount, status, paid_at, method, notes), company_payments(id, price_lkr, is_paid, created_at, company_name)";

export type MoneyProject = {
  total_value?: number | string | null;
  deposit_paid?: number | string | null;
  currency?: string | null;
  payments?: ProjectPaymentLike[] | null;
  company_payments?: LinkedPaymentLike[] | null;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// The one true "received"
// ---------------------------------------------------------------------------

/**
 * Money in against a project.
 *
 * `deposit_paid` and the project's own payment rows are two records of the
 * same money (see the file header), so they are reconciled with max() rather
 * than added. Payments booked on the Payments board are a separate ledger and
 * do add on top.
 *
 * Used by the board card, the project header, the portal and the invoice
 * hand-off, so all four always show the same number.
 */
export function settledAmount(project: MoneyProject): number {
  return depositPart(project) + ownPaymentsTotal(project) + linkedTotal(project);
}

/** Paid rows in the project's own ledger. */
function ownPaymentsTotal(project: MoneyProject): number {
  return (project.payments ?? [])
    .filter((p) => (p.status ?? "paid") === "paid")
    .reduce((sum, p) => sum + num(p.amount), 0);
}

/** Paid rows linked from the Payments board. */
function linkedTotal(project: MoneyProject): number {
  return (project.company_payments ?? [])
    .filter(isLinkedPaid)
    .reduce((sum, p) => sum + num(p.price_lkr), 0);
}

/**
 * The part of `deposit_paid` the itemised payment rows don't already cover.
 *
 * Zero when the two agree — which is the normal case — so a deposit that has
 * been written up as payment rows is counted exactly once.
 */
function depositPart(project: MoneyProject): number {
  return Math.max(0, num(project.deposit_paid) - ownPaymentsTotal(project));
}

/** What is still owed. Never negative — an overpayment reads as settled. */
export function balanceDue(project: MoneyProject): number {
  return Math.max(0, num(project.total_value) - settledAmount(project));
}

/** How far through payment the project is, 0–100. */
export function paidPercent(project: MoneyProject): number {
  const total = num(project.total_value);
  if (total <= 0) return 0;
  return Math.min(100, Math.round((settledAmount(project) / total) * 100));
}

function isLinkedPaid(p: LinkedPaymentLike): boolean {
  return p.is_paid === true;
}

// ---------------------------------------------------------------------------
// The unified ledger
// ---------------------------------------------------------------------------

export type LedgerSource = "deposit" | "project" | "payments_board";

export type LedgerRow = {
  id: string;
  source: LedgerSource;
  /** Where this row is edited, in words the team uses. */
  sourceLabel: string;
  amount: number;
  date: string | null;
  method: string | null;
  note: string | null;
  paid: boolean;
  receiptUrl?: string | null;
  /**
   * Set when another row in the ledger looks like the same money entered in
   * the other table — same amount, within three days. Shown as a warning
   * rather than silently de-duplicated, because only a human knows which of
   * the two rows is the real one.
   */
  possibleDuplicateOf?: string;
};

const DUPLICATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Every payment against a project as one list, newest first.
 *
 * The deposit is included as a synthetic row so the portal and the project
 * page can show a client exactly what we have on record without the deposit
 * being an invisible number folded into a total.
 */
export function buildLedger(project: MoneyProject): LedgerRow[] {
  const rows: LedgerRow[] = [];

  // Only the part the itemised rows below don't already account for, so the
  // ledger sums to exactly what settledAmount() returns.
  const deposit = depositPart(project);
  const itemised = ownPaymentsTotal(project);
  if (deposit > 0) {
    rows.push({
      id: "deposit",
      source: "deposit",
      sourceLabel: "Deposit on the project",
      amount: deposit,
      date: null,
      method: null,
      note:
        itemised > 0
          ? "The part of the deposit not itemised below"
          : null,
      paid: true,
    });
  }

  for (const p of project.payments ?? []) {
    rows.push({
      id: p.id ?? `project-${rows.length}`,
      source: "project",
      sourceLabel: "Project payment",
      amount: num(p.amount),
      date: p.paid_at ?? null,
      method: p.method ?? null,
      note: p.notes ?? null,
      paid: (p.status ?? "paid") === "paid",
      receiptUrl: p.receiptUrl ?? null,
    });
  }

  for (const p of project.company_payments ?? []) {
    rows.push({
      id: p.id ?? `linked-${rows.length}`,
      source: "payments_board",
      sourceLabel: "Payments board",
      amount: num(p.price_lkr),
      date: p.created_at ?? null,
      method: null,
      note: p.company_name ?? null,
      paid: isLinkedPaid(p),
    });
  }

  flagDuplicates(rows);

  return rows.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
}

/**
 * Mark pairs that look like the same money typed into both tables.
 *
 * Only ever compares ACROSS sources: two genuine installments of the same size
 * in the same table are normal, the same amount appearing in both tables in
 * the same week almost never is.
 */
function flagDuplicates(rows: LedgerRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.source === b.source) continue;
      if (a.source === "deposit" || b.source === "deposit") continue;
      if (a.amount !== b.amount || a.amount === 0) continue;
      if (a.date && b.date) {
        const gap = Math.abs(
          new Date(a.date).getTime() - new Date(b.date).getTime(),
        );
        if (!Number.isFinite(gap) || gap > DUPLICATE_WINDOW_MS) continue;
      }
      a.possibleDuplicateOf = b.id;
      b.possibleDuplicateOf = a.id;
    }
  }
}

// ---------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------

export type MarginBreakdown = {
  /** What the client is being charged: the quote plus every billable extra. */
  revenue: number;
  contractValue: number;
  billableExtras: number;
  /** What the job costs us: every expense, billable or absorbed, plus people. */
  cost: number;
  expenses: number;
  absorbedExpenses: number;
  commissions: number;
  labour: number;
  profit: number;
  /** Profit as a share of revenue, 0–100. Null when there is no revenue yet. */
  percent: number | null;
};

/**
 * What a project actually makes.
 *
 * Billable extras appear on BOTH sides — the client is charged for them and we
 * paid for them — so a re-billed cost nets to zero and only absorbed costs eat
 * the margin. That is the behaviour the Additional expenses tab already
 * implies; this just does the subtraction nobody had done yet.
 */
export function projectMargin(input: {
  totalValue: number;
  expenses: Pick<ProjectExpense, "amount" | "billable">[] | ExpenseLike[];
  commissions?: { amount: number | string }[];
  /** Hours × cost rate from logged time (PLAN-5). Zero when nothing is logged. */
  labourCost?: number;
}): MarginBreakdown {
  const contractValue = num(input.totalValue);

  let billableExtras = 0;
  let absorbedExpenses = 0;
  for (const e of input.expenses ?? []) {
    const amount = num(e.amount);
    if (e.billable) billableExtras += amount;
    else absorbedExpenses += amount;
  }
  const expenses = billableExtras + absorbedExpenses;

  const commissions = (input.commissions ?? []).reduce(
    (sum, c) => sum + num(c.amount),
    0,
  );
  const labour = num(input.labourCost);

  const revenue = contractValue + billableExtras;
  const cost = expenses + commissions + labour;
  const profit = revenue - cost;

  return {
    revenue,
    contractValue,
    billableExtras,
    cost,
    expenses,
    absorbedExpenses,
    commissions,
    labour,
    profit,
    percent: revenue > 0 ? Math.round((profit / revenue) * 100) : null,
  };
}

type ExpenseLike = { amount: number | string | null; billable: boolean | null };

/**
 * Whether a margin percentage is worth showing at all.
 *
 * With no costs recorded the answer is always 100%, which isn't a margin —
 * it's the absence of data wearing a margin's clothes. Showing it invites
 * someone to believe a job is perfectly profitable when nobody has entered
 * what it cost.
 */
export function marginIsMeaningful(margin: MarginBreakdown): boolean {
  return margin.revenue > 0 && margin.cost > 0;
}

/** Traffic light for a margin percentage. Tuned for agency service work. */
export function marginTone(percent: number | null): "good" | "thin" | "loss" | "unknown" {
  if (percent === null) return "unknown";
  if (percent < 0) return "loss";
  if (percent < 25) return "thin";
  return "good";
}

// ---------------------------------------------------------------------------
// Commission accrual (MON-7)
// ---------------------------------------------------------------------------

/**
 * What a commission has actually earned.
 *
 * A 'fixed' commission is worth its stored amount the moment it's approved —
 * that is every commission written before 0091, and the behaviour is
 * unchanged. A 'percent_of_received' commission is worth its percentage of the
 * money the client has genuinely paid, so nobody is owed commission on an
 * invoice that never got settled, and the figure grows as the cash arrives.
 */
export function commissionEarned(
  commission: { amount: number | string; percentage?: number | null; basis?: string | null },
  receivedOnProject: number,
): number {
  if ((commission.basis ?? "fixed") !== "percent_of_received") {
    return num(commission.amount);
  }
  const pct = num(commission.percentage);
  if (pct <= 0) return 0;
  return Math.round(receivedOnProject * (pct / 100) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Health (PLAN-8)
// ---------------------------------------------------------------------------

export type HealthTone = "good" | "watch" | "risk";

export type ProjectHealth = {
  /** 100 = nothing wrong. Each problem subtracts from it. */
  score: number;
  tone: HealthTone;
  /** Plain-English reasons, worst first — this is what the UI shows. */
  reasons: string[];
};

export type HealthInput = {
  status: string;
  deliveryStage: string | null;
  stageChangedAt: string | null;
  updatedAt: string | null;
  dueDate: string | null;
  blockedSince: string | null;
  /** Required asset requests still not submitted. */
  assetsOutstanding: number;
  /** Tasks past their due date and not done. */
  overdueTasks: number;
  /** Milestones past their due date and not done. */
  overdueMilestones: number;
  balance: number;
  /** Days since the project was delivered, when it has been. */
  daysSinceDelivered: number | null;
  /** Absorbed + billable costs against the internal budget, when one is set. */
  budget: number | null;
  spend: number;
};

/**
 * One number for "is this job in trouble", from the five signals the workspace
 * already records. Deliberately transparent: every deduction comes with the
 * sentence that explains it, because a score nobody can interrogate gets
 * ignored.
 *
 * A blocked project is not penalised for standing still — that is the point of
 * marking it blocked — but a long block is still worth surfacing.
 */
export function projectHealth(input: HealthInput): ProjectHealth {
  const reasons: string[] = [];
  let score = 100;

  const done = input.status === "completed" || input.status === "cancelled";
  if (done) return { score: 100, tone: "good", reasons: [] };

  const blocked = Boolean(input.blockedSince);
  const blockedDays = blocked ? daysSince(input.blockedSince) : 0;

  // Standing still.
  const idleDays = daysSince(input.stageChangedAt ?? input.updatedAt);
  if (!blocked && idleDays !== null && idleDays >= 7) {
    const penalty = Math.min(30, Math.round((idleDays - 6) * 2));
    score -= penalty;
    reasons.push(`No movement for ${idleDays} days`);
  }
  if (blocked && blockedDays !== null && blockedDays >= 10) {
    score -= Math.min(20, blockedDays);
    reasons.push(`Blocked for ${blockedDays} days`);
  }

  // Waiting on the client.
  if (input.assetsOutstanding > 0) {
    score -= Math.min(20, input.assetsOutstanding * 4);
    reasons.push(
      `${input.assetsOutstanding} asset${input.assetsOutstanding === 1 ? "" : "s"} still outstanding`,
    );
  }

  // Our own slippage.
  const lateWork = input.overdueTasks + input.overdueMilestones;
  if (lateWork > 0) {
    score -= Math.min(25, lateWork * 5);
    reasons.push(`${lateWork} overdue item${lateWork === 1 ? "" : "s"}`);
  }

  // Deadline.
  const daysToDue = input.dueDate ? -1 * (daysSince(input.dueDate) ?? 0) : null;
  if (daysToDue !== null && daysToDue < 0) {
    score -= Math.min(25, Math.abs(daysToDue) * 2);
    reasons.push(`Past its due date by ${Math.abs(daysToDue)} days`);
  }

  // Money left on the table after the work went out.
  if (input.balance > 0 && input.daysSinceDelivered !== null && input.daysSinceDelivered > 7) {
    score -= Math.min(30, Math.round(input.daysSinceDelivered / 2));
    reasons.push(
      `Delivered ${input.daysSinceDelivered} days ago and still unpaid`,
    );
  }

  // Costs running away.
  if (input.budget && input.budget > 0 && input.spend > input.budget) {
    score -= 15;
    reasons.push("Over its internal budget");
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    tone: score >= 75 ? "good" : score >= 45 ? "watch" : "risk",
    reasons,
  };
}

/** Whole days between a timestamp and now. Null for a missing/invalid date. */
export function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/** Minutes → "3h 30m", the way logged time reads back. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
