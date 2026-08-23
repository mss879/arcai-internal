"use client";

import * as React from "react";
import Link from "next/link";
import { format, startOfToday } from "date-fns";
import {
  ArrowLeft,
  CalendarRange,
  Coins,
  Users,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  PROJECT_EXPENSE_CATEGORY_LABELS,
  SERVICE_TYPE_LABELS,
} from "@/lib/constants";
import {
  commissionEarned,
  formatMinutes,
  projectMargin,
  settledAmount,
} from "@/lib/projects";
import type { MemberLite } from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

type ProjectRow = {
  id: string;
  name: string;
  status: string;
  service_type: string | null;
  currency: string;
  total_value: number | null;
  deposit_paid: number | null;
  budget: number | null;
  start_date: string | null;
  due_date: string | null;
  created_at: string;
  delivery_stage: string | null;
  client: { id: string; name: string } | null;
  payments?: { amount: number; status: string }[];
  company_payments?: { price_lkr: number; is_paid: boolean }[];
};

type ExpenseRow = {
  project_id: string;
  amount: number;
  billable: boolean;
  category: string | null;
};
type CommissionRow = {
  project_id: string | null;
  amount: number;
  percentage: number | null;
  basis: string;
};
type TimeRow = { project_id: string; user_id: string; minutes: number };
type TeamRow = { project_id: string; user_id: string; is_owner: boolean };
type TaskRow = {
  project_id: string;
  assigned_to: string | null;
  status: string;
  due_date: string | null;
};
type CostRate = { id: string; hourly_cost: number | null };

type Tab = "profit" | "workload" | "timeline";

export function ReportsView({
  isAdmin,
  members,
  projects,
  expenses,
  commissions,
  time,
  team,
  tasks,
  costRates,
}: {
  isAdmin: boolean;
  members: MemberLite[];
  projects: ProjectRow[];
  expenses: ExpenseRow[];
  commissions: CommissionRow[];
  time: TimeRow[];
  team: TeamRow[];
  tasks: TaskRow[];
  costRates: CostRate[];
}) {
  // Members can't see margin, so don't land them on a tab they can't read.
  const [tab, setTab] = React.useState<Tab>(isAdmin ? "profit" : "workload");

  return (
    <div className="space-y-6">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Projects
      </Link>

      <PageHeader
        title="Project reports"
        description="What the work adds up to — money, people and dates."
      />

      <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {isAdmin && (
          <TabButton
            active={tab === "profit"}
            onClick={() => setTab("profit")}
            icon={<Coins className="h-4 w-4" />}
          >
            Profitability
          </TabButton>
        )}
        <TabButton
          active={tab === "workload"}
          onClick={() => setTab("workload")}
          icon={<Users className="h-4 w-4" />}
        >
          Workload
        </TabButton>
        <TabButton
          active={tab === "timeline"}
          onClick={() => setTab("timeline")}
          icon={<CalendarRange className="h-4 w-4" />}
        >
          Timeline
        </TabButton>
      </div>

      {tab === "profit" && isAdmin && (
        <ProfitTab
          projects={projects}
          expenses={expenses}
          commissions={commissions}
          time={time}
          costRates={costRates}
        />
      )}
      {tab === "workload" && (
        <WorkloadTab
          members={members}
          projects={projects}
          team={team}
          tasks={tasks}
          time={time}
        />
      )}
      {tab === "timeline" && <TimelineTab projects={projects} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Profitability (MON-10)                                              */
/* ------------------------------------------------------------------ */

function ProfitTab({
  projects,
  expenses,
  commissions,
  time,
  costRates,
}: {
  projects: ProjectRow[];
  expenses: ExpenseRow[];
  commissions: CommissionRow[];
  time: TimeRow[];
  costRates: CostRate[];
}) {
  const rateById = React.useMemo(
    () => new Map(costRates.map((c) => [c.id, Number(c.hourly_cost ?? 0)])),
    [costRates],
  );

  const rows = React.useMemo(() => {
    const expensesBy = new Map<string, ExpenseRow[]>();
    for (const e of expenses) {
      const list = expensesBy.get(e.project_id) ?? [];
      list.push(e);
      expensesBy.set(e.project_id, list);
    }
    const commissionsBy = new Map<string, CommissionRow[]>();
    for (const c of commissions) {
      if (!c.project_id) continue;
      const list = commissionsBy.get(c.project_id) ?? [];
      list.push(c);
      commissionsBy.set(c.project_id, list);
    }
    const labourBy = new Map<string, number>();
    for (const t of time) {
      const cost = (t.minutes / 60) * (rateById.get(t.user_id) ?? 0);
      labourBy.set(t.project_id, (labourBy.get(t.project_id) ?? 0) + cost);
    }

    return projects.map((p) => {
      const received = settledAmount(p);
      const margin = projectMargin({
        totalValue: Number(p.total_value) || 0,
        expenses: expensesBy.get(p.id) ?? [],
        commissions: (commissionsBy.get(p.id) ?? []).map((c) => ({
          amount: commissionEarned(c, received),
        })),
        labourCost: labourBy.get(p.id) ?? 0,
      });
      return { project: p, margin, received };
    });
  }, [projects, expenses, commissions, time, rateById]);

  const withValue = React.useMemo(
    () => rows.filter((r) => r.margin.revenue > 0),
    [rows],
  );

  const totals = withValue.reduce(
    (acc, r) => ({
      revenue: acc.revenue + r.margin.revenue,
      cost: acc.cost + r.margin.cost,
      profit: acc.profit + r.margin.profit,
    }),
    { revenue: 0, cost: 0, profit: 0 },
  );
  const overallPercent =
    totals.revenue > 0 ? Math.round((totals.profit / totals.revenue) * 100) : null;

  /** By service type — the answer to "should we keep selling this". */
  const byService = React.useMemo(() => {
    const map = new Map<string, { revenue: number; profit: number; count: number }>();
    for (const r of withValue) {
      const key = r.project.service_type ?? "other";
      const cur = map.get(key) ?? { revenue: 0, profit: 0, count: 0 };
      cur.revenue += r.margin.revenue;
      cur.profit += r.margin.profit;
      cur.count++;
      map.set(key, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].profit - a[1].profit);
  }, [withValue]);

  /** Where the money actually goes. */
  const byCategory = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const e of expenses) {
      const key = e.category?.trim() || "other";
      map.set(key, (map.get(key) ?? 0) + Number(e.amount));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [expenses]);

  if (withValue.length === 0) {
    return (
      <EmptyState
        icon={<Coins className="h-6 w-6" />}
        title="Nothing priced yet"
        description="Give projects a total value and margin can be worked out."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Tile label="Revenue" value={formatCurrency(totals.revenue, "LKR")} />
        <Tile label="Cost" value={formatCurrency(totals.cost, "LKR")} tone="rose" />
        <Tile
          label="Profit"
          value={formatCurrency(totals.profit, "LKR")}
          hint={overallPercent !== null ? `${overallPercent}% margin` : undefined}
          tone={totals.profit >= 0 ? "emerald" : "rose"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="By service type" subtitle="Which work is worth selling">
          <ul className="divide-y divide-slate-100">
            {byService.map(([key, v]) => {
              const pct =
                v.revenue > 0 ? Math.round((v.profit / v.revenue) * 100) : 0;
              return (
                <li key={key} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">
                      {SERVICE_TYPE_LABELS[key] ?? "Other"}
                    </p>
                    <p className="text-xs text-slate-400">
                      {v.count} project{v.count === 1 ? "" : "s"} ·{" "}
                      {formatCurrency(v.revenue, "LKR")} revenue
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={cn(
                        "font-semibold tabular-nums",
                        v.profit >= 0 ? "text-emerald-600" : "text-rose-600",
                      )}
                    >
                      {formatCurrency(v.profit, "LKR")}
                    </p>
                    <p className="text-xs text-slate-400">{pct}%</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Where the money goes" subtitle="Costs by category">
          {byCategory.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-400">
              No expenses recorded yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {byCategory.map(([key, amount]) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <span className="text-sm text-slate-700">
                    {PROJECT_EXPENSE_CATEGORY_LABELS[key] ?? key}
                  </span>
                  <span className="font-medium tabular-nums text-slate-900">
                    {formatCurrency(amount, "LKR")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Every project" subtitle="Worst margin first">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2.5 font-medium">Project</th>
                <th className="px-5 py-2.5 text-right font-medium">Revenue</th>
                <th className="px-5 py-2.5 text-right font-medium">Cost</th>
                <th className="px-5 py-2.5 text-right font-medium">Profit</th>
                <th className="px-5 py-2.5 text-right font-medium">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {[...withValue]
                .sort((a, b) => (a.margin.percent ?? 0) - (b.margin.percent ?? 0))
                .map(({ project, margin }) => (
                  <tr key={project.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <Link
                        href={`/projects/${project.id}`}
                        className="font-medium text-slate-800 hover:text-primary-700"
                      >
                        {project.name}
                      </Link>
                      {project.client && (
                        <p className="text-xs text-slate-400">
                          {project.client.name}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                      {formatCurrency(margin.revenue, project.currency)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                      {formatCurrency(margin.cost, project.currency)}
                    </td>
                    <td
                      className={cn(
                        "px-5 py-3 text-right font-semibold tabular-nums",
                        margin.profit >= 0 ? "text-slate-900" : "text-rose-600",
                      )}
                    >
                      {formatCurrency(margin.profit, project.currency)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Badge
                        className={
                          (margin.percent ?? 0) < 0
                            ? "bg-rose-50 text-rose-600 ring-rose-200"
                            : (margin.percent ?? 0) < 25
                              ? "bg-amber-50 text-amber-600 ring-amber-200"
                              : "bg-emerald-50 text-emerald-600 ring-emerald-200"
                        }
                      >
                        {margin.percent}%
                      </Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workload (PLAN-4)                                                   */
/* ------------------------------------------------------------------ */

function WorkloadTab({
  members,
  projects,
  team,
  tasks,
  time,
}: {
  members: MemberLite[];
  projects: ProjectRow[];
  team: TeamRow[];
  tasks: TaskRow[];
  time: TimeRow[];
}) {
  const liveProjectIds = new Set(
    projects
      .filter((p) => ["planning", "active", "on_hold"].includes(p.status))
      .map((p) => p.id),
  );
  // startOfToday() rather than Date.now(): react-hooks/purity forbids calling
  // the impure global during render.
  const now = startOfToday().getTime();

  const rows = members
    .map((m) => {
      const theirProjects = team.filter(
        (t) => t.user_id === m.id && liveProjectIds.has(t.project_id),
      );
      const theirTasks = tasks.filter(
        (t) => t.assigned_to === m.id && t.status !== "done",
      );
      const overdue = theirTasks.filter(
        (t) => t.due_date && new Date(t.due_date).getTime() < now,
      ).length;
      const minutes = time
        .filter((t) => t.user_id === m.id)
        .reduce((s, t) => s + t.minutes, 0);
      return {
        member: m,
        projects: theirProjects.length,
        owned: theirProjects.filter((t) => t.is_owner).length,
        openTasks: theirTasks.length,
        overdue,
        minutes,
      };
    })
    .sort((a, b) => b.openTasks + b.projects * 2 - (a.openTasks + a.projects * 2));

  const busiest = Math.max(1, ...rows.map((r) => r.openTasks));

  return (
    <Card title="Who is carrying what" subtitle="Live projects and open tasks">
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.member.id} className="flex items-center gap-4 px-5 py-4">
            <Avatar
              name={r.member.full_name}
              src={r.member.avatar_url}
              size="sm"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-800">
                {r.member.full_name}
              </p>
              <p className="text-xs text-slate-400">
                {r.projects} project{r.projects === 1 ? "" : "s"}
                {r.owned > 0 ? ` · owns ${r.owned}` : ""}
                {r.minutes > 0 ? ` · ${formatMinutes(r.minutes)} logged` : ""}
              </p>
              <div className="mt-2 h-1.5 w-full max-w-[280px] overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    "h-full rounded-full",
                    r.overdue > 0 ? "bg-rose-400" : "bg-primary-400",
                  )}
                  style={{ width: `${Math.round((r.openTasks / busiest) * 100)}%` }}
                />
              </div>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums text-slate-900">
                {r.openTasks}
              </p>
              <p className="text-[11px] text-slate-400">open</p>
              {r.overdue > 0 && (
                <p className="text-[11px] font-semibold text-rose-500">
                  {r.overdue} overdue
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Timeline (PLAN-6)                                                   */
/* ------------------------------------------------------------------ */

function TimelineTab({ projects }: { projects: ProjectRow[] }) {
  const live = projects.filter(
    (p) =>
      ["planning", "active", "on_hold"].includes(p.status) &&
      (p.start_date || p.due_date),
  );

  if (live.length === 0) {
    return (
      <EmptyState
        icon={<CalendarRange className="h-6 w-6" />}
        title="No dated projects"
        description="Give projects a start and due date and they'll lay out here."
      />
    );
  }

  // A window wide enough to hold every bar, so nothing is clipped.
  const today = startOfToday().getTime();
  const dates = live.flatMap((p) =>
    [p.start_date, p.due_date].filter(Boolean).map((d) => new Date(d as string).getTime()),
  );
  const min = Math.min(...dates, today);
  const max = Math.max(...dates, today);
  const span = Math.max(1, max - min);
  const todayPct = ((today - min) / span) * 100;

  return (
    <Card
      title="What lands when"
      subtitle={`${format(new Date(min), "d MMM yyyy")} – ${format(new Date(max), "d MMM yyyy")}`}
    >
      <div className="relative px-5 py-5">
        {/* Today */}
        <div
          className="pointer-events-none absolute bottom-3 top-3 z-10 w-px bg-rose-400/70"
          style={{ left: `calc(1.25rem + ${todayPct}% * 0.999)` }}
          aria-hidden
        />
        <ul className="space-y-3">
          {live
            .slice()
            .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"))
            .map((p) => {
              const start = p.start_date
                ? new Date(p.start_date).getTime()
                : new Date(p.created_at).getTime();
              const end = p.due_date ? new Date(p.due_date).getTime() : start;
              const left = ((start - min) / span) * 100;
              const width = Math.max(2, ((end - start) / span) * 100);
              const late = p.due_date && new Date(p.due_date).getTime() < today;
              return (
                <li key={p.id}>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <Link
                      href={`/projects/${p.id}`}
                      className="truncate text-sm font-medium text-slate-800 hover:text-primary-700"
                    >
                      {p.name}
                    </Link>
                    <span
                      className={cn(
                        "shrink-0 text-[11px]",
                        late ? "font-semibold text-rose-500" : "text-slate-400",
                      )}
                    >
                      {p.due_date
                        ? `${late ? "Overdue " : "Due "}${format(new Date(p.due_date), "d MMM")}`
                        : "No due date"}
                    </span>
                  </div>
                  <div className="relative h-2.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={cn(
                        "absolute h-full rounded-full",
                        late ? "bg-rose-400" : "bg-primary-400",
                      )}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </div>
                </li>
              );
            })}
        </ul>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "emerald" | "rose";
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 text-2xl font-extrabold tabular-nums",
          tone === "emerald"
            ? "text-emerald-600"
            : tone === "rose"
              ? "text-rose-600"
              : "text-slate-800",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-primary-600 text-white shadow-sm"
          : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
