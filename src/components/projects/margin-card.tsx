"use client";

/**
 * What this project actually makes (MON-1) and how the costs are tracking
 * against the cap (MON-2).
 *
 * Every figure here was already in the database — contract value, billable
 * extras, absorbed costs, commissions, and now logged time. Nobody had
 * subtracted them from each other, so "Internal Budget" sat on the header as
 * a number that did nothing.
 */

import * as React from "react";
import { TrendingDown, TrendingUp, Wallet } from "lucide-react";

import {
  marginIsMeaningful,
  marginTone,
  type MarginBreakdown,
} from "@/lib/projects";
import { cn, formatCurrency } from "@/lib/utils";

export function MarginCard({
  margin,
  currency,
  cap,
  labourHours,
  hasCostRates,
}: {
  margin: MarginBreakdown;
  currency: string;
  /** expense_cap, or the internal budget when no cap is set. */
  cap: number | null;
  labourHours: number;
  /** False when nobody on the project has an hourly cost — labour reads as 0. */
  hasCostRates: boolean;
}) {
  const showPercent = marginIsMeaningful(margin);
  const tone = showPercent ? marginTone(margin.percent) : "unknown";
  const spend = margin.expenses;
  const capPct = cap && cap > 0 ? Math.min(200, Math.round((spend / cap) * 100)) : null;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
        <span
          className={cn(
            "grid h-9 w-9 place-items-center rounded-xl",
            tone === "good"
              ? "bg-emerald-50 text-emerald-500"
              : tone === "thin"
                ? "bg-amber-50 text-amber-500"
                : tone === "loss"
                  ? "bg-rose-50 text-rose-500"
                  : "bg-slate-100 text-slate-400",
          )}
        >
          {tone === "loss" ? (
            <TrendingDown className="h-5 w-5" />
          ) : (
            <TrendingUp className="h-5 w-5" />
          )}
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Margin</h2>
          <p className="text-xs text-slate-400">
            What is charged, minus what it costs us
          </p>
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Profit
            </p>
            <p
              className={cn(
                "text-3xl font-bold tabular-nums",
                tone === "good"
                  ? "text-emerald-600"
                  : tone === "thin"
                    ? "text-amber-600"
                    : tone === "loss"
                      ? "text-rose-600"
                      : "text-slate-900",
              )}
            >
              {formatCurrency(margin.profit, currency)}
            </p>
          </div>
          {showPercent && margin.percent !== null && (
            <div className="text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Of revenue
              </p>
              <p
                className={cn(
                  "text-2xl font-bold tabular-nums",
                  tone === "good"
                    ? "text-emerald-600"
                    : tone === "thin"
                      ? "text-amber-600"
                      : "text-rose-600",
                )}
              >
                {margin.percent}%
              </p>
            </div>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
          <Line label="Contract value" value={margin.contractValue} currency={currency} />
          <Line
            label="Billable extras"
            value={margin.billableExtras}
            currency={currency}
            hint="Charged on and paid for — nets to zero"
          />
          <Line
            label="Costs absorbed"
            value={-margin.absorbedExpenses}
            currency={currency}
            negative
          />
          <Line
            label="Costs re-billed"
            value={-margin.billableExtras}
            currency={currency}
            negative
          />
          <Line
            label="Commissions"
            value={-margin.commissions}
            currency={currency}
            negative
          />
          <Line
            label={`Time (${labourHours.toFixed(1)}h)`}
            value={-margin.labour}
            currency={currency}
            negative
            hint={
              !hasCostRates && labourHours > 0
                ? "No hourly cost set for the people on this project"
                : undefined
            }
          />
        </dl>

        {capPct !== null && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-500">
                Costs against {formatCurrency(cap ?? 0, currency)} budget
              </span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  capPct >= 100
                    ? "text-rose-600"
                    : capPct >= 80
                      ? "text-amber-600"
                      : "text-slate-500",
                )}
              >
                {capPct}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  capPct >= 100
                    ? "bg-rose-500"
                    : capPct >= 80
                      ? "bg-amber-500"
                      : "bg-emerald-500",
                )}
                style={{ width: `${Math.min(100, capPct)}%` }}
              />
            </div>
          </div>
        )}

        {!showPercent && (
          <p className="mt-4 flex items-center gap-1.5 border-t border-slate-100 pt-4 text-xs text-slate-400">
            <Wallet className="h-3.5 w-3.5" />
            {margin.revenue <= 0
              ? "Set the project's total value to see a margin."
              : "No costs recorded yet, so there's no margin to work out."}
          </p>
        )}
      </div>
    </section>
  );
}

function Line({
  label,
  value,
  currency,
  negative,
  hint,
}: {
  label: string;
  value: number;
  currency: string;
  negative?: boolean;
  hint?: string;
}) {
  if (value === 0 && negative) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-slate-500">
        {label}
        {hint && <span className="ml-1.5 text-[11px] text-slate-400">· {hint}</span>}
      </dt>
      <dd
        className={cn(
          "shrink-0 font-medium tabular-nums",
          negative ? "text-rose-600" : "text-slate-900",
        )}
      >
        {negative ? "−" : ""}
        {formatCurrency(Math.abs(value), currency)}
      </dd>
    </div>
  );
}
