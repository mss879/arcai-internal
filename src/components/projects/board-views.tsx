"use client";

/**
 * The board, asked four different ways (VIEW-1).
 *
 * The month board answers "what did we book, and when" — which is the right
 * question at month end and the wrong one every other day. A job that is
 * stuck in review, a deadline landing on Thursday and a client who owes money
 * are all invisible in a list grouped by creation date.
 *
 * Same filtered data, four layouts. The month board itself stays in
 * projects-view.tsx, where the carry-forward grouping lives; these are the
 * three that are purely a different arrangement of the same rows.
 */

import * as React from "react";
import Link from "next/link";
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight, OctagonPause } from "lucide-react";

import { AvatarStack } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DELIVERY_STAGES,
  DELIVERY_STAGE_META,
  PROJECT_STATUS_META,
  SERVICE_TYPE_LABELS,
} from "@/lib/constants";
import type { ProjectHealth } from "@/lib/projects";
import type { DeliveryStage, ProjectStatus } from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * One project, flattened.
 *
 * Built once in projects-view from the same `derive()` the cards use, so a
 * number can never read differently depending on which layout you are in.
 */
export type BoardProject = {
  id: string;
  name: string;
  clientName: string | null;
  status: ProjectStatus;
  stage: DeliveryStage | null;
  serviceType: string | null;
  currency: string;
  totalValue: number;
  received: number;
  balance: number;
  marginPercent: number | null;
  health: ProjectHealth;
  dueDate: string | null;
  daysInStage: number | null;
  team: { id: string; full_name: string; avatar_url: string | null }[];
  blocked: boolean;
  overdue: boolean;
};

const HEALTH_DOT: Record<ProjectHealth["tone"], string> = {
  good: "bg-emerald-500",
  watch: "bg-amber-500",
  risk: "bg-rose-500",
};

function HealthDot({ health }: { health: ProjectHealth }) {
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", HEALTH_DOT[health.tone])}
      title={health.reasons.length ? health.reasons.join(" · ") : "Healthy"}
      aria-label={`Health: ${health.tone}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Kanban — by delivery stage
// ---------------------------------------------------------------------------

/**
 * Read-only on purpose. Dragging a card between columns would have to pass
 * the deposit gate and the launch checklist that `setProjectStage` enforces
 * (MON-5, PLAN-10), and a drag that silently fails a gate is worse than no
 * drag at all. Moving a stage stays on the project, where the gate can
 * explain itself.
 */
export function KanbanView({ projects }: { projects: BoardProject[] }) {
  const columns = React.useMemo(() => {
    const byStage = new Map<string, BoardProject[]>();
    for (const p of projects) {
      const key = p.stage ?? "unstarted";
      const list = byStage.get(key);
      if (list) list.push(p);
      else byStage.set(key, [p]);
    }
    return [
      { key: "unstarted", label: "Not started", badge: "bg-slate-100 text-slate-600" },
      ...DELIVERY_STAGES.map((s) => ({
        key: s,
        label: DELIVERY_STAGE_META[s].label,
        badge: DELIVERY_STAGE_META[s].badge,
      })),
    ].map((col) => ({ ...col, items: byStage.get(col.key) ?? [] }));
  }, [projects]);

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <div className="flex min-w-max gap-4">
        {columns.map((col) => {
          const value = col.items.reduce((sum, p) => sum + p.totalValue, 0);
          return (
            <div
              key={col.key}
              className="flex w-72 shrink-0 flex-col rounded-2xl border border-slate-200/80 bg-white/60 shadow-[var(--shadow-card)] backdrop-blur-sm"
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-200/60 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Badge className={col.badge}>{col.label}</Badge>
                  <span className="text-xs font-semibold text-slate-400">
                    {col.items.length}
                  </span>
                </div>
                {value > 0 && (
                  <span className="text-[11px] tabular-nums text-slate-400">
                    {formatCurrency(value, col.items[0]?.currency ?? "LKR")}
                  </span>
                )}
              </div>
              <div className="flex-1 space-y-2 p-3">
                {col.items.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-300">Empty</p>
                ) : (
                  col.items.map((p) => (
                    <Link
                      key={p.id}
                      href={`/projects/${p.id}`}
                      className="block rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-primary-300 hover:shadow-[var(--shadow-lift)]"
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-1.5">
                          <HealthDot health={p.health} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-800">
                            {p.name}
                          </p>
                          {p.clientName && (
                            <p className="truncate text-xs text-slate-400">
                              {p.clientName}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold tabular-nums text-slate-600">
                          {formatCurrency(p.totalValue, p.currency)}
                        </span>
                        {p.team.length > 0 && (
                          <AvatarStack people={p.team} size="xs" max={3} />
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {p.balance > 0 && (
                          <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                            {formatCurrency(p.balance, p.currency)} due
                          </Badge>
                        )}
                        {p.blocked && (
                          <Badge className="bg-amber-100/80 text-amber-800 ring-amber-300/70">
                            <OctagonPause className="h-3 w-3" />
                            Blocked
                          </Badge>
                        )}
                        {p.overdue && (
                          <Badge className="bg-rose-50 text-rose-700 ring-rose-200">
                            Overdue
                          </Badge>
                        )}
                        {p.daysInStage !== null && p.daysInStage > 0 && (
                          <span className="text-[11px] text-slate-400">
                            {p.daysInStage}d here
                          </span>
                        )}
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table — every project, one row each
// ---------------------------------------------------------------------------

export function TableView({
  projects,
  showMargin,
}: {
  projects: BoardProject[];
  /** Margin is admin-only, matching commissions (invariant 9). */
  showMargin: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
            <th className="px-4 py-3">Project</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Stage</th>
            <th className="px-4 py-3">Due</th>
            <th className="px-4 py-3 text-right">Value</th>
            <th className="px-4 py-3 text-right">Received</th>
            <th className="px-4 py-3 text-right">Balance</th>
            {showMargin && <th className="px-4 py-3 text-right">Margin</th>}
            <th className="px-4 py-3">Team</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {projects.map((p) => (
            <tr key={p.id} className="transition hover:bg-slate-50/70">
              <td className="px-4 py-3">
                <Link href={`/projects/${p.id}`} className="flex items-center gap-2">
                  <HealthDot health={p.health} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-800">
                      {p.name}
                    </span>
                    {p.clientName && (
                      <span className="block truncate text-xs text-slate-400">
                        {p.clientName}
                        {p.serviceType
                          ? ` · ${SERVICE_TYPE_LABELS[p.serviceType as keyof typeof SERVICE_TYPE_LABELS] ?? p.serviceType}`
                          : ""}
                      </span>
                    )}
                  </span>
                </Link>
              </td>
              <td className="px-4 py-3">
                <Badge className={PROJECT_STATUS_META[p.status].badge}>
                  {PROJECT_STATUS_META[p.status].label}
                </Badge>
              </td>
              <td className="px-4 py-3">
                {p.stage ? (
                  <Badge className={DELIVERY_STAGE_META[p.stage].badge}>
                    {DELIVERY_STAGE_META[p.stage].label}
                  </Badge>
                ) : (
                  <span className="text-xs text-slate-300">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                {p.dueDate ? (
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      p.overdue ? "font-semibold text-rose-600" : "text-slate-500",
                    )}
                  >
                    {format(parseISO(p.dueDate), "d MMM yyyy")}
                  </span>
                ) : (
                  <span className="text-xs text-slate-300">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                {formatCurrency(p.totalValue, p.currency)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-emerald-600">
                {formatCurrency(p.received, p.currency)}
              </td>
              <td
                className={cn(
                  "px-4 py-3 text-right tabular-nums",
                  p.balance > 0 ? "font-semibold text-amber-600" : "text-slate-300",
                )}
              >
                {p.balance > 0 ? formatCurrency(p.balance, p.currency) : "—"}
              </td>
              {showMargin && (
                <td className="px-4 py-3 text-right tabular-nums">
                  {p.marginPercent === null ? (
                    <span className="text-slate-300">—</span>
                  ) : (
                    <span
                      className={cn(
                        "font-semibold",
                        p.marginPercent < 0
                          ? "text-rose-600"
                          : p.marginPercent < 30
                            ? "text-amber-600"
                            : "text-emerald-600",
                      )}
                    >
                      {p.marginPercent}%
                    </span>
                  )}
                </td>
              )}
              <td className="px-4 py-3">
                {p.team.length > 0 ? (
                  <AvatarStack people={p.team} size="xs" max={3} />
                ) : (
                  <span className="text-xs text-slate-300">Unstaffed</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar — placed on the day they are due
// ---------------------------------------------------------------------------

export function CalendarView({ projects }: { projects: BoardProject[] }) {
  // Anchored on a state value rather than "now" so paging months is possible
  // and render stays pure — the initial month comes from the first paint.
  const [anchor, setAnchor] = React.useState(() => startOfMonth(new Date()));

  const days = React.useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [anchor]);

  const byDay = React.useMemo(() => {
    const map = new Map<string, BoardProject[]>();
    for (const p of projects) {
      if (!p.dueDate) continue;
      const key = p.dueDate.slice(0, 10);
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [projects]);

  const undated = projects.filter((p) => !p.dueDate);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-[var(--shadow-card)]">
        <button
          type="button"
          onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h2 className="text-base font-semibold text-slate-900">
          {format(anchor, "MMMM yyyy")}
        </h2>
        <button
          type="button"
          onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100"
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/70">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div
              key={d}
              className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const key = format(day, "yyyy-MM-dd");
            const items = byDay.get(key) ?? [];
            const inMonth = isSameMonth(day, anchor);
            return (
              <div
                key={key}
                className={cn(
                  "min-h-[104px] border-b border-r border-slate-100 p-1.5 last:border-r-0",
                  !inMonth && "bg-slate-50/50",
                )}
              >
                <div
                  className={cn(
                    "mb-1 inline-grid h-6 w-6 place-items-center rounded-full text-xs font-semibold tabular-nums",
                    isToday(day)
                      ? "bg-primary-600 text-white"
                      : inMonth
                        ? "text-slate-600"
                        : "text-slate-300",
                  )}
                >
                  {format(day, "d")}
                </div>
                <div className="space-y-1">
                  {items.slice(0, 3).map((p) => (
                    <Link
                      key={p.id}
                      href={`/projects/${p.id}`}
                      title={`${p.name}${p.clientName ? ` — ${p.clientName}` : ""}`}
                      className={cn(
                        "flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition hover:brightness-95",
                        p.overdue
                          ? "bg-rose-50 text-rose-700"
                          : "bg-primary-50 text-primary-700",
                      )}
                    >
                      <HealthDot health={p.health} />
                      <span className="truncate">{p.name}</span>
                    </Link>
                  ))}
                  {items.length > 3 && (
                    <p className="px-1.5 text-[11px] text-slate-400">
                      +{items.length - 3} more
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {undated.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            No due date ({undated.length})
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            These can&apos;t be planned around until someone commits to a date.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {undated.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-white hover:text-primary-700"
              >
                <HealthDot health={p.health} />
                {p.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
