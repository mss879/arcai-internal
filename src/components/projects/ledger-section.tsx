"use client";

/**
 * Every payment against a project, in one list (LOOP-6).
 *
 * The project used to show its own `payments` rows under "Budget Received",
 * while the balance in the header was computed from the linked
 * `company_payments` rows on the Payments board — two lists, two meanings, and
 * no screen that answered "what has this client actually paid us".
 *
 * Rows carry where they're edited, and money that looks like it was typed into
 * both tables is flagged rather than quietly counted twice.
 */

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  AlertTriangle,
  CreditCard,
  ExternalLink,
  Landmark,
  Receipt,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { LedgerRow } from "@/lib/projects";
import { cn, formatCurrency } from "@/lib/utils";

const SOURCE_META: Record<
  LedgerRow["source"],
  { badge: string; icon: React.ReactNode; href?: string }
> = {
  deposit: {
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
    icon: <Landmark className="h-3.5 w-3.5" />,
  },
  project: {
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
    icon: <Receipt className="h-3.5 w-3.5" />,
  },
  payments_board: {
    badge: "bg-sky-50 text-sky-600 ring-sky-200",
    icon: <CreditCard className="h-3.5 w-3.5" />,
    href: "/payments",
  },
};

export function LedgerSection({
  rows,
  currency,
  received,
  totalValue,
}: {
  rows: LedgerRow[];
  currency: string;
  received: number;
  totalValue: number;
}) {
  const duplicates = rows.filter((r) => r.possibleDuplicateOf).length;
  const pending = rows.filter((r) => !r.paid);

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-500">
            <Landmark className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Money in</h2>
            <p className="text-xs text-slate-400">
              Everything received against this project, wherever it was recorded
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums text-slate-900">
            {formatCurrency(received, currency)}
          </p>
          {totalValue > 0 && (
            <p className="text-[11px] text-slate-400">
              of {formatCurrency(totalValue, currency)}
            </p>
          )}
        </div>
      </div>

      {duplicates > 0 && (
        <div className="flex items-start gap-2.5 border-b border-amber-100 bg-amber-50/70 px-5 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-900">
            <span className="font-semibold">
              {duplicates} row{duplicates === 1 ? "" : "s"} may be the same money twice.
            </span>{" "}
            The same amount appears on the Payments board and on this project
            within a few days. If one of them is a duplicate, delete it — the
            received total counts both.
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          Nothing received yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((row) => {
            const meta = SOURCE_META[row.source];
            return (
              <li
                key={`${row.source}:${row.id}`}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 px-5 py-3",
                  row.possibleDuplicateOf && "bg-amber-50/40",
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={meta.badge}>
                      {meta.icon}
                      {row.sourceLabel}
                    </Badge>
                    {!row.paid && (
                      <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                        Not yet paid
                      </Badge>
                    )}
                    {row.possibleDuplicateOf && (
                      <Badge className="bg-amber-100 text-amber-800 ring-amber-300">
                        Possible duplicate
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    {row.date ? format(new Date(row.date), "d MMM yyyy") : "No date"}
                    {row.method ? ` · ${row.method}` : ""}
                    {row.note ? ` · ${row.note}` : ""}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  {row.receiptUrl && (
                    <a
                      href={row.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-primary-700 hover:underline"
                    >
                      Receipt
                    </a>
                  )}
                  {meta.href && (
                    <Link
                      href={meta.href}
                      className="text-slate-300 transition hover:text-primary-600"
                      title="Open the Payments board"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  )}
                  <span
                    className={cn(
                      "font-semibold tabular-nums",
                      row.paid ? "text-slate-900" : "text-slate-400",
                    )}
                  >
                    {formatCurrency(row.amount, currency)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pending.length > 0 && (
        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
          {pending.length} row{pending.length === 1 ? "" : "s"} above{" "}
          {pending.length === 1 ? "is" : "are"} still unpaid and{" "}
          {pending.length === 1 ? "does" : "do"} not count toward the total.
        </p>
      )}
    </section>
  );
}
