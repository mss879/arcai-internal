"use client";

import * as React from "react";
import { format, parseISO } from "date-fns";
import {
  Award,
  CheckCircle2,
  Clock,
  Handshake,
  MessageCircle,
  PackageCheck,
  Target,
  UserPlus,
} from "lucide-react";

import type { MemberScorecard } from "@/lib/scorecards";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * A member's month, at a glance (0119).
 *
 * Every number comes from memberScorecard(), which reads the same sources
 * the rest of the app does — so the hours here are the hours on the project,
 * the deals are the CRM's, and the revenue target is Finance's money in.
 *
 * This lives on the admin-only member page, which is why commission is on
 * it. If a member-facing version is ever built, that tile is the one to drop.
 */

const KIND_LABEL: Record<MemberScorecard["targets"][number]["kind"], string> = {
  revenue: "Revenue",
  deals_won: "Deals won",
  deliveries: "Delivered",
  leads: "New leads",
  hours: "Hours",
};

function wait(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.round((minutes / 60) * 10) / 10} h`;
  return `${Math.round((minutes / (60 * 24)) * 10) / 10} d`;
}

export function ScorecardSection({ scorecards }: { scorecards: MemberScorecard[] }) {
  const [period, setPeriod] = React.useState(scorecards[0]?.period ?? "");
  const card = scorecards.find((s) => s.period === period) ?? scorecards[0];
  if (!card) return null;

  const tiles = [
    {
      icon: Clock,
      label: "Hours logged",
      value: `${card.hours}`,
      hint: card.hoursByProject.length
        ? card.hoursByProject.map((p) => `${p.project} ${p.hours}h`).join(" · ")
        : "No time logged",
    },
    {
      icon: CheckCircle2,
      label: "To-dos done",
      value: `${card.todos.done}`,
      hint:
        card.todos.overdue > 0
          ? `${card.todos.open} open · ${card.todos.overdue} overdue`
          : `${card.todos.open} open`,
      tone: card.todos.overdue > 0 ? "text-amber-600" : undefined,
    },
    {
      icon: Handshake,
      label: "Deals won",
      value: `${card.dealsWon}`,
      hint: `${card.leadsCreated} new lead${card.leadsCreated === 1 ? "" : "s"} assigned`,
    },
    {
      icon: PackageCheck,
      label: "Projects delivered",
      value: `${card.deliveries}`,
      hint: "On projects they own",
    },
    {
      icon: MessageCircle,
      label: "Hand-off reply",
      value: wait(card.replies.medianMinutes),
      hint: card.replies.assigned
        ? `${card.replies.answered} of ${card.replies.assigned} conversations answered`
        : "No hand-offs this month",
    },
    {
      icon: Award,
      label: "Commission allocated",
      value: formatCurrency(card.commissionAllocated),
      hint: "Earned this month, whatever its status",
    },
  ];

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">
            <Target className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Scorecard</h2>
            <p className="text-xs text-slate-400">
              The month in numbers — the same ones the rest of the app shows.
            </p>
          </div>
        </div>
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
          {scorecards.map((s) => (
            <button
              key={s.period}
              onClick={() => setPeriod(s.period)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                s.period === card.period
                  ? "bg-primary-600 text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-800",
              )}
            >
              {format(parseISO(s.period), "MMM yyyy")}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="bg-white px-5 py-4">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </p>
            <p className={cn("mt-1 text-xl font-bold tabular-nums text-slate-900", t.tone)}>
              {t.value}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-slate-400" title={t.hint}>
              {t.hint}
            </p>
          </div>
        ))}
      </div>

      {card.targets.length > 0 && (
        <div className="border-t border-slate-100 px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Their targets
          </p>
          <ul className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {card.targets.map((p) => (
              <li key={p.kind}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-slate-700">{KIND_LABEL[p.kind]}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {p.kind === "revenue"
                      ? `${formatCurrency(p.actual)} / ${formatCurrency(p.target)}`
                      : `${p.actual} / ${p.target}`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      p.percent >= 100
                        ? "bg-emerald-500"
                        : p.percent >= 60
                          ? "bg-primary-500"
                          : "bg-amber-500",
                    )}
                    style={{ width: `${Math.min(100, Math.max(2, p.percent))}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.targets.length === 0 && (
        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
          No personal target for this month. Set one from the Team page and it shows here.
          <UserPlus className="ml-1 inline h-3 w-3" />
        </p>
      )}
    </section>
  );
}
