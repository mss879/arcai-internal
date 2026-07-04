"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Activity, ChevronDown, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { Automation, AutomationRun, AutomationRunStatus } from "@/lib/types";

import { cancelAutomationRun, deleteAutomationRun } from "./actions";

const STATUS_META: Record<
  AutomationRunStatus,
  { label: string; badge: string; dot: string }
> = {
  running: {
    label: "Running",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
    dot: "bg-primary-500",
  },
  completed: {
    label: "Completed",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    dot: "bg-emerald-500",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
    dot: "bg-slate-400",
  },
  failed: {
    label: "Failed",
    badge: "bg-rose-50 text-rose-600 ring-rose-200",
    dot: "bg-rose-500",
  },
};

export function RunsTab({
  runs,
  automations,
}: {
  runs: AutomationRun[];
  automations: Automation[];
}) {
  const [toCancel, setToCancel] = React.useState<AutomationRun | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  // Snapshot once per mount — refreshed via realtime re-renders anyway.
  const [now] = React.useState(() => Date.now());

  const nameById = new Map(automations.map((a) => [a.id, a.name]));

  async function handleCancel() {
    if (!toCancel) return;
    const res = await cancelAutomationRun(toCancel.id);
    if (res.ok) toast.success("Run cancelled.");
    else toast.error(res.error);
  }

  async function handleDelete(run: AutomationRun) {
    const res = await deleteAutomationRun(run.id);
    if (!res.ok) toast.error(res.error);
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="h-6 w-6" />}
        title="No runs yet"
        description="Every time a trigger fires, the enrollment shows up here with a step-by-step log of what happened."
      />
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => {
        const meta = STATUS_META[run.status];
        const log = (run.log ?? []) as { step: string; at: string; ok: boolean; detail?: string }[];
        const isOpen = expanded === run.id;
        return (
          <div
            key={run.id}
            className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]"
          >
            <div className="flex flex-wrap items-center gap-2.5 px-4 py-3">
              <Badge className={meta.badge} dot={meta.dot}>
                {meta.label}
              </Badge>
              <span className="text-sm font-medium text-slate-800">
                {run.subject_name || run.subject_phone || run.subject_email || "Unknown"}
              </span>
              <span className="text-xs text-slate-400">
                · {nameById.get(run.automation_id) ?? "Deleted automation"}
              </span>
              <span className="text-xs text-slate-400">
                · started {formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}
              </span>
              {run.status === "running" && new Date(run.next_run_at).getTime() > now && (
                <span className="text-xs text-slate-400">
                  · next {formatDistanceToNow(new Date(run.next_run_at), { addSuffix: true })}
                </span>
              )}
              {run.status === "failed" && run.error && (
                <span className="text-xs text-rose-500">· {run.error}</span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {log.length > 0 && (
                  <button
                    onClick={() => setExpanded(isOpen ? null : run.id)}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100"
                  >
                    {log.length} step{log.length === 1 ? "" : "s"}
                    <ChevronDown
                      className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-180")}
                    />
                  </button>
                )}
                {run.status === "running" ? (
                  <Button variant="ghost" size="sm" onClick={() => setToCancel(run)}>
                    Cancel
                  </Button>
                ) : (
                  <button
                    onClick={() => handleDelete(run)}
                    className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                    aria-label="Remove run"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </div>
            {isOpen && log.length > 0 && (
              <div className="border-t border-slate-100 px-4 py-3">
                <ol className="space-y-1.5">
                  {log.map((entry, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          entry.ok ? "bg-emerald-500" : "bg-rose-500",
                        )}
                      />
                      <span className="font-medium text-slate-700">{entry.step}</span>
                      {entry.detail && <span className="text-slate-400">— {entry.detail}</span>}
                      <span className="ml-auto text-slate-300">
                        {new Date(entry.at).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={toCancel !== null}
        onClose={() => setToCancel(null)}
        onConfirm={handleCancel}
        title="Cancel this run?"
        description="Remaining actions won't execute for this contact."
        confirmLabel="Cancel run"
      />
    </div>
  );
}
