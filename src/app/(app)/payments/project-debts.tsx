"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { AlertTriangle, FolderKanban, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { PROJECT_STATUS_META } from "@/lib/constants";
import { cn, formatCurrency } from "@/lib/utils";

import { sumBalance, type ProjectMoney } from "./project-money";

/** Ways to read a receivables list, worst first in each case. */
const SORTS = {
  balance: "Biggest balance",
  waiting: "Longest waiting",
  percent: "Least paid",
  due: "Most overdue",
} as const;

type DebtSort = keyof typeof SORTS;

const DUPLICATE_HINT =
  "The same amount appears in this project's own ledger and on the Payments board within three days. One of them is probably a double entry — open the project and check before chasing this balance.";

export function ProjectDebtsTable({ rows }: { rows: ProjectMoney[] }) {
  const [sort, setSort] = React.useState<DebtSort>("balance");
  const [liveOnly, setLiveOnly] = React.useState(false);

  const visible = React.useMemo(() => {
    const kept = liveOnly ? rows.filter((r) => r.live) : rows;
    const sorted = [...kept];
    sorted.sort((a, b) => {
      switch (sort) {
        case "waiting":
          return (b.waitingDays ?? 0) - (a.waitingDays ?? 0);
        case "percent":
          return a.percent - b.percent || b.balance - a.balance;
        case "due": {
          // Undated projects sit below anything with a real deadline.
          const aDue = a.project.due_date ?? "9999-12-31";
          const bDue = b.project.due_date ?? "9999-12-31";
          return aDue.localeCompare(bDue) || b.balance - a.balance;
        }
        default:
          return b.balance - a.balance;
      }
    });
    return sorted;
  }, [rows, sort, liveOnly]);

  const shownTotal = sumBalance(visible);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Wallet className="h-6 w-6" />}
        title="Nothing outstanding on any project"
        description="Every live project has been paid in full. Money with no project behind it lives on the Payments board tab."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={liveOnly}
            onChange={(e) => setLiveOnly(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          Live work only
          <span className="text-xs text-slate-400">
            (hide completed and cancelled projects)
          </span>
        </label>

        <Select
          value={sort}
          onChange={(e) => setSort(e.target.value as DebtSort)}
          className="sm:w-52"
          aria-label="Sort outstanding projects"
        >
          {Object.entries(SORTS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Wallet className="h-6 w-6" />}
          title="Nothing outstanding on live work"
          description="Every planning, active and on-hold project is settled. Untick “Live work only” to see balances left on completed or cancelled projects."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-5 py-3.5 font-semibold">Client / Project</th>
                  <th className="px-5 py-3.5 font-semibold">Total value</th>
                  <th className="px-5 py-3.5 font-semibold">Received</th>
                  <th className="px-5 py-3.5 font-semibold">Balance due</th>
                  <th className="px-5 py-3.5 font-semibold">Paid</th>
                  <th className="px-5 py-3.5 font-semibold">Outstanding for</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {visible.map((m) => (
                  <DebtRow key={m.project.id} money={m} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3 text-xs text-slate-500">
            <span>
              {visible.length} project{visible.length === 1 ? "" : "s"} still owing
              {liveOnly ? " on live work" : ""}
            </span>
            <span className="font-semibold text-slate-700 tabular-nums">
              {formatCurrency(shownTotal)} outstanding
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function DebtRow({ money: m }: { money: ProjectMoney }) {
  const status = PROJECT_STATUS_META[m.project.status];

  return (
    <tr className="group hover:bg-slate-50/60">
      <td className="px-5 py-3.5">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
              m.overdue
                ? "bg-rose-50 text-rose-600"
                : m.live
                  ? "bg-primary-50 text-primary-600"
                  : "bg-slate-100 text-slate-500",
            )}
          >
            <FolderKanban className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs text-slate-400">
              {m.clientName ?? "No client on file"}
            </p>
            <Link
              href={`/projects/${m.project.id}`}
              className="font-medium text-slate-900 hover:text-primary-700 hover:underline"
            >
              {m.project.name}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {!m.live && (
                <Badge className={status.badge}>{status.label}</Badge>
              )}
              {m.overdue && m.project.due_date && (
                <span className="text-[11px] font-semibold text-rose-500">
                  Due {format(new Date(m.project.due_date), "d MMM")}
                </span>
              )}
              {m.duplicateRowIds.size > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
                  title={DUPLICATE_HINT}
                >
                  <AlertTriangle className="h-3 w-3" />
                  Possible double entry
                </span>
              )}
            </div>
          </div>
        </div>
      </td>

      <td className="px-5 py-3.5 tabular-nums text-slate-600">
        {m.totalValue > 0 ? formatCurrency(m.totalValue, m.currency) : "—"}
      </td>

      <td className="px-5 py-3.5">
        <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums text-slate-900">
          <Wallet className="h-4 w-4 text-emerald-500" />
          {formatCurrency(m.received, m.currency)}
        </span>
      </td>

      <td className="px-5 py-3.5 font-bold tabular-nums text-amber-600">
        {formatCurrency(m.balance, m.currency)}
      </td>

      <td className="px-5 py-3.5">
        <div className="w-28">
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                m.percent >= 100 ? "bg-emerald-500" : "bg-primary-500",
              )}
              style={{ width: `${m.percent}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400 tabular-nums">
            {m.percent}% paid
          </p>
        </div>
      </td>

      <td className="px-5 py-3.5">
        {m.waitingDays === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          <div>
            <span
              className={cn(
                "font-semibold tabular-nums",
                m.waitingDays >= 60
                  ? "text-rose-600"
                  : m.waitingDays >= 30
                    ? "text-amber-600"
                    : "text-slate-700",
              )}
            >
              {m.waitingDays} day{m.waitingDays === 1 ? "" : "s"}
            </span>
            <p className="text-[11px] text-slate-400">
              {m.waitingFrom === "payment"
                ? "since the last payment"
                : "no payment yet"}
            </p>
          </div>
        )}
      </td>
    </tr>
  );
}
