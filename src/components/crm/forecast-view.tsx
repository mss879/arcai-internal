"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarDays, TrendingUp } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatCurrency } from "@/lib/utils";
import type { LeadWithAssignee } from "@/lib/types";

/**
 * Revenue forecast: open deals grouped by expected close month. The weighted
 * number multiplies each deal's value by its win probability (100% when not
 * set), which is what the owner can realistically expect to land.
 */
export function ForecastView({ leads }: { leads: LeadWithAssignee[] }) {
  const open = leads.filter((l) => l.status === "open");
  const scheduled = open.filter((l) => l.expected_close_date && l.value != null);
  const unscheduled = open.filter((l) => !l.expected_close_date || l.value == null);

  const byMonth = new Map<string, LeadWithAssignee[]>();
  for (const lead of scheduled) {
    const key = lead.expected_close_date!.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), lead]);
  }
  const months = Array.from(byMonth.keys()).sort();
  const thisMonth = new Date().toISOString().slice(0, 7);

  const weighted = (list: LeadWithAssignee[]) =>
    list.reduce(
      (sum, l) => sum + Number(l.value ?? 0) * ((l.probability ?? 100) / 100),
      0,
    );
  const raw = (list: LeadWithAssignee[]) =>
    list.reduce((sum, l) => sum + Number(l.value ?? 0), 0);

  if (open.length === 0) {
    return (
      <EmptyState
        icon={<TrendingUp className="h-6 w-6" />}
        title="Nothing to forecast"
        description="Open deals with a value and an expected close date show up here as expected revenue per month."
      />
    );
  }

  const expectedThisMonth = weighted(byMonth.get(thisMonth) ?? []);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Expected this month" value={formatCurrency(expectedThisMonth)} highlight />
        <StatCard label="Total open pipeline" value={formatCurrency(raw(open))} />
        <StatCard label="Weighted pipeline" value={formatCurrency(weighted(scheduled))} />
      </div>

      <div className="space-y-3">
        {months.map((month) => {
          const list = (byMonth.get(month) ?? []).sort(
            (a, b) => Number(b.value ?? 0) - Number(a.value ?? 0),
          );
          const label = new Date(`${month}-01T00:00:00`).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          });
          return (
            <div
              key={month}
              className={cn(
                "rounded-2xl border bg-white p-5 shadow-[var(--shadow-card)]",
                month === thisMonth ? "border-primary-300 ring-2 ring-primary-100" : "border-slate-200/80",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <CalendarDays className="h-4 w-4 text-slate-400" />
                <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
                {month === thisMonth && (
                  <span className="rounded-md bg-primary-50 px-1.5 py-0.5 text-[11px] font-bold text-primary-600">
                    this month
                  </span>
                )}
                <span className="ml-auto text-sm">
                  <span className="text-slate-400">expected </span>
                  <strong className="text-slate-900">{formatCurrency(weighted(list))}</strong>
                  <span className="text-xs text-slate-400"> of {formatCurrency(raw(list))}</span>
                </span>
              </div>
              <div className="mt-3 space-y-1.5">
                {list.map((lead) => (
                  <Link
                    key={lead.id}
                    href={`/crm/lead/${lead.id}`}
                    className="flex items-center gap-2 rounded-xl border border-slate-100 px-3 py-2 text-sm transition-colors hover:border-primary-200 hover:bg-primary-50/30"
                  >
                    <span className="font-medium text-slate-800">{lead.title}</span>
                    {lead.score === "hot" && <span>🔥</span>}
                    <span className="text-xs text-slate-400">
                      {lead.expected_close_date} · {lead.probability ?? 100}% likely
                    </span>
                    <span className="ml-auto font-semibold text-slate-700">
                      {formatCurrency(Number(lead.value ?? 0), lead.currency)}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}

        {unscheduled.length > 0 && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 p-5">
            <h3 className="text-sm font-semibold text-slate-600">
              Not in the forecast ({unscheduled.length})
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              These open deals need a value and an expected close date to count.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {unscheduled.map((lead) => (
                <Link
                  key={lead.id}
                  href={`/crm/lead/${lead.id}`}
                  className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
                >
                  {lead.title}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-white p-4 shadow-[var(--shadow-card)]",
        highlight ? "border-primary-300" : "border-slate-200/80",
      )}
    >
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className={cn("mt-1 text-xl font-bold", highlight ? "text-primary-600" : "text-slate-900")}>
        {value}
      </p>
    </div>
  );
}
