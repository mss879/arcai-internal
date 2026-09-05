"use client";

import * as React from "react";
import { format } from "date-fns";
import { Activity, Bot, Cpu, UserRound, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * One row of the merged trail (T5.3): what a person changed
 * (`member_changes`) beside what the system did (`system_events`).
 */
export type SystemActivityRow = {
  id: string;
  at: string;
  actorKind: "member" | "system" | "assistant" | "automation";
  /** A member's name, or the job / automation the system acted as. */
  actor: string;
  action: string;
  table: string;
  rowId: string | null;
  summary: string;
};

const ACTION_TONE: Record<string, string> = {
  created: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  published: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  sent: "bg-sky-50 text-sky-700 ring-sky-200",
  updated: "bg-slate-100 text-slate-600 ring-slate-200",
  unpublished: "bg-amber-50 text-amber-700 ring-amber-200",
  deleted: "bg-rose-50 text-rose-600 ring-rose-200",
};

const KIND_ICON: Record<SystemActivityRow["actorKind"], React.ReactNode> = {
  member: <UserRound className="h-3.5 w-3.5" />,
  system: <Cpu className="h-3.5 w-3.5" />,
  assistant: <Bot className="h-3.5 w-3.5" />,
  automation: <Zap className="h-3.5 w-3.5" />,
};

/**
 * The workspace's trail, people and system in one list.
 *
 * Until now the Team page could say what a member changed and nothing about
 * what the tick, the assistant or an automation wrote. Reading the two apart
 * is how "who raised this invoice" goes unanswered; here they sit in time
 * order, with a filter for whichever half you are chasing.
 */
export function SystemActivity({ rows }: { rows: SystemActivityRow[] }) {
  const [filter, setFilter] = React.useState<"all" | "people" | "system">("all");
  const shown = rows.filter((r) =>
    filter === "all" ? true : filter === "people" ? r.actorKind === "member" : r.actorKind !== "member",
  );
  const systemCount = rows.filter((r) => r.actorKind !== "member").length;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-600">
          <Activity className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">System activity</h2>
          <p className="text-xs text-slate-400">
            The last seven days: what people changed, beside what the tick, the assistant and automations wrote
            {systemCount > 0 ? ` (${systemCount} system write${systemCount === 1 ? "" : "s"})` : ""}.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
          {(["all", "people", "system"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium capitalize transition",
                filter === f ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-400">
          {rows.length === 0
            ? "Nothing recorded yet. System writes appear here once migration 0121 has run."
            : "Nothing in this filter."}
        </p>
      ) : (
        <ul className="max-h-[560px] divide-y divide-slate-50 overflow-y-auto">
          {shown.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2.5 px-5 py-2.5 text-sm">
              <span className="w-28 shrink-0 text-xs tabular-nums text-slate-400">
                {format(new Date(r.at), "d MMM, HH:mm")}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                  r.actorKind === "member"
                    ? "bg-primary-50 text-primary-700"
                    : r.actorKind === "assistant"
                      ? "bg-violet-50 text-violet-700"
                      : r.actorKind === "automation"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-slate-100 text-slate-600",
                )}
                title={r.actorKind}
              >
                {KIND_ICON[r.actorKind]}
                {r.actor}
              </span>
              <Badge className={ACTION_TONE[r.action] ?? "bg-slate-100 text-slate-600 ring-slate-200"}>
                {r.action}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-slate-700" title={r.summary}>
                {r.summary}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-slate-400">{r.table}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
