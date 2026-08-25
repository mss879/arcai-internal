/**
 * What the Payments page knows about project money.
 *
 * Every figure here is produced by @/lib/projects — settledAmount(),
 * balanceDue(), paidPercent() and buildLedger(). None of it is re-derived.
 * That is the whole point: this page used to compute
 * `deposit_paid + linked paid board rows`, which both ignored the project's
 * own `payments` ledger AND added the deposit instead of reconciling it, so
 * /payments and /projects reported different balances for the same job.
 *
 * The only work this module does is shaping: turning a project row into the
 * handful of things a receivables table wants to say out loud.
 */

import { startOfToday } from "date-fns";

import {
  balanceDue,
  buildLedger,
  daysSince,
  paidPercent,
  settledAmount,
  type LinkedPaymentLike,
  type ProjectPaymentLike,
} from "@/lib/projects";
import type { Client, ProjectStatus } from "@/lib/types";

/**
 * A project as the Payments page needs it.
 *
 * Both relations are load-bearing, not decoration: settledAmount() reconciles
 * `deposit_paid` against `payments` and only then adds paid `company_payments`
 * on top. Select one of them and the page silently under-counts. The server
 * query builds this list with PROJECT_MONEY_SELECT so it cannot drift.
 */
export type PaymentsProject = {
  id: string;
  name: string;
  status: ProjectStatus;
  currency: string | null;
  due_date: string | null;
  created_at: string;
  total_value: number | null;
  deposit_paid: number | null;
  client?: Pick<Client, "id" | "name" | "company"> | null;
  payments?: ProjectPaymentLike[] | null;
  company_payments?: LinkedPaymentLike[] | null;
};

/** Work still running — the money that can actually be chased today. */
const LIVE_STATUSES: ReadonlySet<ProjectStatus> = new Set([
  "planning",
  "active",
  "on_hold",
]);

export function isLiveProject(project: PaymentsProject): boolean {
  return LIVE_STATUSES.has(project.status);
}

export type ProjectMoney = {
  project: PaymentsProject;
  clientName: string | null;
  currency: string;
  totalValue: number;
  /** settledAmount() — the one true "money in" against this project. */
  received: number;
  /** balanceDue() — total value less received, never negative. */
  balance: number;
  /** paidPercent() — 0–100. */
  percent: number;
  /** False for completed and cancelled work, which is owed but not chaseable. */
  live: boolean;
  /** Days since money last landed, or since the project opened if none ever has. */
  waitingDays: number | null;
  /** What waitingDays counts from, so the row can say which it means. */
  waitingFrom: "payment" | "start";
  /** Past its due date with money still outstanding. */
  overdue: boolean;
  /**
   * Ledger rows buildLedger() flagged as the same money typed into both the
   * project's own ledger and the Payments board. The id of a board row in the
   * ledger IS its company_payments id, so the board table can light up the
   * very same row from this set — one signal, two screens, no second
   * heuristic invented here.
   */
  duplicateRowIds: Set<string>;
};

/**
 * Money for every project, keyed by id.
 *
 * `startOfToday()` rather than `Date.now()` because this runs inside render:
 * a project due later today is not overdue yet, and a stable day boundary
 * keeps the server and client passes agreeing.
 */
export function buildProjectMoney(
  projects: PaymentsProject[],
): Map<string, ProjectMoney> {
  const today = startOfToday().getTime();
  const map = new Map<string, ProjectMoney>();

  for (const project of projects) {
    const ledger = buildLedger(project);
    // buildLedger() sorts newest first and pushes undated rows to the end,
    // so the first dated + paid row is the last time money actually arrived.
    const lastPaid = ledger.find((row) => row.paid && row.date);
    const balance = balanceDue(project);
    const dueAt = project.due_date
      ? new Date(`${project.due_date}T23:59:59`).getTime()
      : null;

    map.set(project.id, {
      project,
      clientName: project.client?.name ?? null,
      currency: project.currency ?? "LKR",
      totalValue: Number(project.total_value) || 0,
      received: settledAmount(project),
      balance,
      percent: paidPercent(project),
      live: isLiveProject(project),
      waitingDays: daysSince(lastPaid?.date ?? project.created_at),
      waitingFrom: lastPaid ? "payment" : "start",
      overdue: balance > 0 && dueAt !== null && dueAt < today,
      duplicateRowIds: new Set(
        ledger.filter((row) => row.possibleDuplicateOf).map((row) => row.id),
      ),
    });
  }

  return map;
}

/** Total still owed across a set of projects. */
export function sumBalance(rows: ProjectMoney[]): number {
  return rows.reduce((sum, row) => sum + row.balance, 0);
}

/** Total received across a set of projects. */
export function sumReceived(rows: ProjectMoney[]): number {
  return rows.reduce((sum, row) => sum + row.received, 0);
}
