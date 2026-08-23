"use client";

/**
 * Costs booked against this project in Money & Finance (0100).
 *
 * These count against the margin but do NOT appear on the Additional expenses
 * tab, because they are not the same thing: an Additional expense is usually a
 * billable extra headed for the client's invoice, while a Finance cost is
 * money the agency spent and absorbed.
 *
 * They are listed anyway. A cost that moves the margin without appearing
 * anywhere is how a number stops being trusted — and the first question after
 * "why is this job at 41%?" is "on what?".
 *
 * Read-only on purpose: Finance owns these rows, and editing the same expense
 * from two screens is how the two ledgers start disagreeing.
 */

import * as React from "react";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import { Landmark } from "lucide-react";

import { formatCurrency } from "@/lib/utils";

export type FinanceCostRow = {
  description: string;
  amount: number;
  category: string | null;
  incurred_on: string;
};

export function FinanceCostsCard({
  rows,
  currency,
}: {
  rows: FinanceCostRow[];
  currency: string;
}) {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + r.amount, 0);

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
          <Landmark className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">
            From Money &amp; Finance
          </h2>
          <p className="text-xs text-slate-400">
            Absorbed costs booked against this project — not billed on
          </p>
        </div>
        <span className="shrink-0 text-sm font-bold tabular-nums text-slate-800">
          {formatCurrency(total, currency)}
        </span>
      </div>

      <ul className="divide-y divide-slate-100">
        {rows.map((r, i) => (
          <li
            key={`${r.description}-${i}`}
            className="flex items-center justify-between gap-3 px-5 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-slate-700">{r.description}</p>
              <p className="text-xs text-slate-400">
                {[
                  r.category,
                  (() => {
                    try {
                      return format(parseISO(r.incurred_on), "d MMM yyyy");
                    } catch {
                      return r.incurred_on;
                    }
                  })(),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <span className="shrink-0 text-sm tabular-nums text-slate-600">
              {formatCurrency(r.amount, currency)}
            </span>
          </li>
        ))}
      </ul>

      <p className="border-t border-slate-100 px-5 py-3 text-xs leading-relaxed text-slate-400">
        Edited in{" "}
        <Link href="/finance" className="font-medium text-primary-600 hover:underline">
          Money &amp; Finance
        </Link>
        . A cost you want to put on the client&apos;s invoice belongs in
        Additional expenses instead, where it can be marked billable.
      </p>
    </section>
  );
}
