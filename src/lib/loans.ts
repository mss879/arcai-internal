/**
 * Staff loans netted against commission (0088).
 *
 * A loan is an advance on money the member has (or will have) earned, so the
 * app never rewrites a commission row to account for one — a commission stays
 * a record of what was earned. Instead an outstanding loan is subtracted at
 * the point the numbers are shown, which means a repayment restores the
 * balance the instant it's recorded, and every figure can be traced back to
 * the rows that produced it.
 *
 * Every screen that shows a member's money — the Team board, their dashboard,
 * their own profile — goes through here, so none of them can disagree.
 */

import type { Commission, MemberLoan, MemberLoanRepayment } from "@/lib/types";

export type LoanWithRepayments = MemberLoan & {
  repayments: MemberLoanRepayment[];
};

/** How much of a loan has come back so far. */
export function loanRepaid(loan: LoanWithRepayments): number {
  return (loan.repayments ?? []).reduce((s, r) => s + Number(r.amount), 0);
}

/**
 * What the member still owes on one loan.
 *
 * Nothing is owed on a loan that hasn't been approved — a pending request is
 * a question, not money, so it must leave their commission exactly as it was.
 * A written-off loan owes nothing either: the company has decided to stop
 * chasing it, so it must stop suppressing their commission too.
 */
export function loanBalance(loan: LoanWithRepayments): number {
  if (loan.approval !== "approved") return 0;
  if (loan.status === "written_off") return 0;
  return Math.max(0, Number(loan.amount) - loanRepaid(loan));
}

/** True once the money is actually out the door. */
export function isLoanLive(loan: MemberLoan): boolean {
  return loan.approval === "approved";
}

export type MemberMoney = {
  /** Everything ever allocated to them. */
  commissionEarned: number;
  /** Allocations already marked paid. */
  commissionPaidOut: number;
  /** Earned but not yet paid — what the company owes before loans. */
  commissionOwed: number;
  /** Total actually advanced — approved loans only, written-off ones included. */
  loansIssued: number;
  /** Money that's come back. */
  loansRepaid: number;
  /** Still owed to the company — the figure that suppresses commission. */
  loansOutstanding: number;
  /** Advances the company gave up on; no longer deducted from anything. */
  loansWrittenOff: number;
  /** Requested but not yet approved. Deliberately absent from every total. */
  loansPending: number;
  /** How many requests are waiting on the admin. */
  pendingCount: number;
  /** Commission earned, less what they still owe us. What the card shows. */
  commissionAfterLoans: number;
  /**
   * What we'd actually hand over today: owed commission minus the outstanding
   * loan. Negative means the advance has outrun what they've earned — they owe
   * the company that much.
   */
  netPayable: number;
};

/** Roll a member's commissions and loans into the numbers every screen shows. */
export function summariseMemberMoney(
  commissions: Pick<Commission, "amount" | "status">[],
  loans: LoanWithRepayments[],
): MemberMoney {
  const commissionEarned = commissions.reduce(
    (s, c) => s + Number(c.amount),
    0,
  );
  const commissionPaidOut = commissions
    .filter((c) => c.status === "paid")
    .reduce((s, c) => s + Number(c.amount), 0);

  // Only approved loans are real money. A pending request is excluded from
  // every total on purpose, so recording one changes nothing they see.
  const live = loans.filter(isLoanLive);
  const pending = loans.filter((l) => l.approval === "pending");

  const loansIssued = live.reduce((s, l) => s + Number(l.amount), 0);
  const loansRepaid = live.reduce((s, l) => s + loanRepaid(l), 0);
  const loansOutstanding = loans.reduce((s, l) => s + loanBalance(l), 0);
  const loansWrittenOff = live
    .filter((l) => l.status === "written_off")
    .reduce((s, l) => s + Math.max(0, Number(l.amount) - loanRepaid(l)), 0);

  const commissionOwed = commissionEarned - commissionPaidOut;

  return {
    commissionEarned,
    commissionPaidOut,
    commissionOwed,
    loansIssued,
    loansRepaid,
    loansOutstanding,
    loansWrittenOff,
    loansPending: pending.reduce((s, l) => s + Number(l.amount), 0),
    pendingCount: pending.length,
    commissionAfterLoans: commissionEarned - loansOutstanding,
    netPayable: commissionOwed - loansOutstanding,
  };
}

/** Attach each loan's repayments, newest first. */
export function attachRepayments(
  loans: MemberLoan[],
  repayments: MemberLoanRepayment[],
): LoanWithRepayments[] {
  const byLoan = new Map<string, MemberLoanRepayment[]>();
  for (const r of repayments) {
    const list = byLoan.get(r.loan_id);
    if (list) list.push(r);
    else byLoan.set(r.loan_id, [r]);
  }
  return loans.map((l) => ({ ...l, repayments: byLoan.get(l.id) ?? [] }));
}

/** Group loans by the member they belong to. */
export function loansByUser(
  loans: LoanWithRepayments[],
): Map<string, LoanWithRepayments[]> {
  const map = new Map<string, LoanWithRepayments[]>();
  for (const l of loans) {
    const list = map.get(l.user_id);
    if (list) list.push(l);
    else map.set(l.user_id, [l]);
  }
  return map;
}

export const MEMBER_LOAN_STATUS_META: Record<
  MemberLoan["status"],
  { label: string; badge: string }
> = {
  outstanding: {
    label: "Outstanding",
    badge: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  repaid: {
    label: "Repaid",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
  written_off: {
    label: "Written off",
    badge: "bg-slate-100 text-slate-500 ring-slate-200",
  },
};

export const MEMBER_LOAN_APPROVAL_META: Record<
  MemberLoan["approval"],
  { label: string; badge: string }
> = {
  pending: {
    label: "Awaiting approval",
    badge: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  },
  approved: {
    label: "Approved",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
  declined: {
    label: "Declined",
    badge: "bg-rose-50 text-rose-600 ring-rose-200",
  },
};

/**
 * The one badge a loan should wear.
 *
 * Until it's approved, approval is the only thing worth saying — "Outstanding"
 * on a loan nobody has granted yet would read as money owed. Once granted, the
 * repayment status takes over.
 */
export function loanBadge(loan: MemberLoan): { label: string; badge: string } {
  if (loan.approval !== "approved") {
    return MEMBER_LOAN_APPROVAL_META[loan.approval];
  }
  return MEMBER_LOAN_STATUS_META[loan.status];
}
