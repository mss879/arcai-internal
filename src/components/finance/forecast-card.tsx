"use client";

import * as React from "react";
import { format, parseISO } from "date-fns";
import { TrendingUp } from "lucide-react";

import type { ForecastWeek, StandingCost } from "@/lib/finance-math";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * The 90-day cash view (0119) — the same card on Intelligence and Finance.
 *
 * Two lines, never one. "Committed" is money with a date and a reason: an
 * instalment, a recurring month. "Expected" adds the run rate the last three
 * months suggest. A single blended figure hides which half you are betting
 * on, and "can we make payroll in week six" depends entirely on that.
 */

export function ForecastCard({
  weeks,
  standing = [],
  asOf,
  compact = false,
}: {
  weeks: ForecastWeek[];
  standing?: StandingCost[];
  asOf?: string;
  /** Fewer rows, for a card that shares a page. */
  compact?: boolean;
}) {
  const totals = React.useMemo(() => {
    const committed = weeks.reduce((s, w) => s + w.committed, 0);
    const expected = weeks.reduce((s, w) => s + w.expected, 0);
    const outflow = weeks.reduce((s, w) => s + w.outflow, 0);
    return { committed, expected, outflow, net: expected - outflow, netCommitted: committed - outflow };
  }, [weeks]);

  const max = Math.max(1, ...weeks.flatMap((w) => [w.expected, w.outflow]));

  // Running balances, so the week the money runs thin is visible rather
  // than inferred.
  const rows = React.useMemo(() => {
    const out: (ForecastWeek & { runCommitted: number; runExpected: number })[] = [];
    let runCommitted = 0;
    let runExpected = 0;
    for (const w of weeks) {
      runCommitted += w.committed - w.outflow;
      runExpected += w.expected - w.outflow;
      out.push({ ...w, runCommitted, runExpected });
    }
    return out;
  }, [weeks]);
  const shownRows = compact ? rows.slice(0, 6) : rows;
  const firstDip = rows.find((r) => r.runExpected < 0);

  if (weeks.length === 0) return null;

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <TrendingUp className="h-4 w-4 text-primary-500" />
          Cash — next {weeks.length} weeks
        </h3>
        {asOf && (
          <span className="text-[11px] text-slate-400">
            as of {format(parseISO(asOf), "d MMM")}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Committed in" value={formatCurrency(totals.committed)} tone="text-slate-900" />
        <Stat label="Expected in" value={formatCurrency(totals.expected)} tone="text-emerald-600" />
        <Stat label="Going out" value={formatCurrency(totals.outflow)} tone="text-rose-600" />
        <Stat
          label="Net (expected)"
          value={formatCurrency(totals.net)}
          tone={totals.net >= 0 ? "text-emerald-600" : "text-rose-600"}
          hint={`${formatCurrency(totals.netCommitted)} on committed money alone`}
        />
      </div>

      {firstDip && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          On the expected line, cash goes negative in the week of{" "}
          {format(parseISO(firstDip.weekStart), "d MMM")}. Bring an instalment forward
          or hold a standing cost, and this line moves.
        </p>
      )}

      {/* Bars: expected in (light) with committed (solid) inside it, and out. */}
      <div className="mt-5 flex items-end gap-1.5 sm:gap-2">
        {weeks.map((w) => (
          <div key={w.weekStart} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex h-28 w-full items-end justify-center gap-0.5">
              <div
                className="relative w-1/2 max-w-5 rounded-t bg-emerald-100"
                style={{ height: `${(w.expected / max) * 100}%` }}
                title={`Expected ${formatCurrency(w.expected)}`}
              >
                <div
                  className="absolute bottom-0 left-0 right-0 rounded-t bg-emerald-500"
                  style={{ height: `${w.expected > 0 ? (w.committed / w.expected) * 100 : 0}%` }}
                  title={`Committed ${formatCurrency(w.committed)}`}
                />
              </div>
              <div
                className="w-1/2 max-w-5 rounded-t bg-rose-300"
                style={{ height: `${(w.outflow / max) * 100}%` }}
                title={`Out ${formatCurrency(w.outflow)}`}
              />
            </div>
            <span className="text-[10px] font-medium text-slate-400">
              {format(parseISO(w.weekStart), "d/M")}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Committed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-emerald-100" /> Expected (run rate)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-rose-300" /> Out
        </span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left uppercase tracking-wide text-slate-400">
              <th className="py-1.5 pr-3 font-semibold">Week of</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Committed</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Expected</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Out</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Running (committed)</th>
              <th className="py-1.5 text-right font-semibold">Running (expected)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {shownRows.map((r) => (
              <tr key={r.weekStart} className="tabular-nums text-slate-700">
                <td className="py-1.5 pr-3">{format(parseISO(r.weekStart), "d MMM")}</td>
                <td className="py-1.5 pr-3 text-right">{formatCurrency(r.committed)}</td>
                <td className="py-1.5 pr-3 text-right text-emerald-700">{formatCurrency(r.expected)}</td>
                <td className="py-1.5 pr-3 text-right text-rose-600">{formatCurrency(r.outflow)}</td>
                <td className={cn("py-1.5 pr-3 text-right", r.runCommitted < 0 && "text-rose-600")}>
                  {formatCurrency(r.runCommitted)}
                </td>
                <td className={cn("py-1.5 text-right font-medium", r.runExpected < 0 ? "text-rose-600" : "text-slate-900")}>
                  {formatCurrency(r.runExpected)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {standing.length > 0 && !compact && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Standing costs assumed
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Paid in at least two of the last three months. Worked out from the ledger — nothing to maintain.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {standing.slice(0, 8).map((c) => (
              <li
                key={c.name}
                className="rounded-lg bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 ring-1 ring-slate-200"
              >
                {c.name} · {formatCurrency(c.amount)} · day {c.day}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-400">
        Run rate is the last 90 days averaged per week. Money in is the same definition the
        Finance page uses — received, not invoiced.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn("mt-0.5 text-base font-bold tabular-nums", tone)}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}
