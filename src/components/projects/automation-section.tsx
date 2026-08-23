"use client";

/**
 * What the automations are doing to THIS project (AUTO-7, 0096).
 *
 * `automation_runs.project_id` has existed since 0085 and was never rendered
 * anywhere, so the only way to find out whether a recipe had fired on a job
 * was to open /automation and read every run in the workspace looking for the
 * client's name. Three questions get answered here — what is queued, what is
 * running, what already fired — and one switch stands the lot down when a
 * project goes sideways, without pausing the automation for every other
 * client it serves.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow, isFuture, parseISO } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  PauseCircle,
  Workflow,
} from "lucide-react";

import { STEP_META } from "@/lib/automation-meta";
import type { AutomationRunStatus, AutomationStepKind } from "@/lib/types";
import { cn } from "@/lib/utils";

import { setProjectAutomationPaused } from "@/app/(app)/projects/actions";

export type ProjectRunRow = {
  id: string;
  automation_name: string;
  status: AutomationRunStatus;
  step_index: number;
  /** How many steps the automation has in total, for "3 of 6". */
  step_count: number;
  next_run_at: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  /** The step log, newest last — the "what fired" detail. */
  log: { step?: string; at?: string; ok?: boolean; detail?: string }[];
};

const STATUS_META: Record<
  AutomationRunStatus,
  { label: string; icon: React.ReactNode; tone: string }
> = {
  running: {
    label: "Running",
    icon: <Clock className="h-3.5 w-3.5" />,
    tone: "bg-sky-50 text-sky-600",
  },
  completed: {
    label: "Done",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  failed: {
    label: "Failed",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    tone: "bg-rose-50 text-rose-600",
  },
  cancelled: {
    label: "Cancelled",
    icon: <PauseCircle className="h-3.5 w-3.5" />,
    tone: "bg-slate-100 text-slate-500",
  },
};

export function AutomationSection({
  projectId,
  paused,
  runs,
}: {
  projectId: string;
  paused: boolean;
  runs: ProjectRunRow[];
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [isPaused, setIsPaused] = React.useState(paused);

  async function togglePause() {
    const next = !isPaused;
    setIsPaused(next);
    setSaving(true);
    const res = await setProjectAutomationPaused(projectId, next);
    setSaving(false);
    if (res.ok) {
      toast.success(
        next
          ? "Automations paused for this project."
          : "Automations running again — queued runs pick up where they stopped.",
      );
      router.refresh();
    } else {
      setIsPaused(!next);
      toast.error(res.error);
    }
  }

  const live = runs.filter((r) => r.status === "running");
  const finished = runs.filter((r) => r.status !== "running");

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
          <Workflow className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">Automations</h2>
          <p className="text-xs text-slate-400">
            {runs.length === 0
              ? "Nothing has run on this project"
              : `${live.length} in flight · ${finished.length} finished`}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isPaused}
          aria-label="Pause automations for this project"
          disabled={saving}
          onClick={togglePause}
          className={cn(
            "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:opacity-60",
            isPaused ? "bg-amber-500" : "bg-slate-200",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
              isPaused ? "left-[22px]" : "left-0.5",
            )}
          />
        </button>
      </div>

      {isPaused && (
        <div className="flex items-start gap-2.5 border-b border-amber-100 bg-amber-50/70 px-5 py-3 text-xs leading-relaxed text-amber-700">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-semibold">Paused for this project only.</span>{" "}
            Nothing new enrols it and the runs below stand still at the step they
            reached — they carry on from exactly there when you switch this back
            on. Every other project keeps running normally.
          </p>
        </div>
      )}

      {runs.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-400">
          No automation has touched this project yet. Install a recipe under
          Delivery → Automations, or build one under Automation → Workflows.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} paused={isPaused} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({ run, paused }: { run: ProjectRunRow; paused: boolean }) {
  const [open, setOpen] = React.useState(false);
  const meta = STATUS_META[run.status] ?? STATUS_META.running;

  // A running run is either mid-flight or sitting on a wait; "queued until"
  // is the honest description of the second, and the one people ask about.
  const nextRun = parseISO(run.next_run_at);
  const waitingUntil =
    run.status === "running" && isFuture(nextRun) ? nextRun : null;

  const done = run.log.filter((l) => l.ok !== false).length;

  return (
    <li className="px-5 py-3.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 text-left"
      >
        <span
          className={cn(
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg",
            meta.tone,
          )}
        >
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800">
            {run.automation_name}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {run.status === "running"
              ? paused
                ? `Held at step ${run.step_index + 1} of ${run.step_count} — this project is paused`
                : waitingUntil
                  ? `Step ${run.step_index + 1} of ${run.step_count} — queued for ${formatDistanceToNow(waitingUntil)} from now`
                  : `Step ${run.step_index + 1} of ${run.step_count} — running now`
              : run.status === "failed"
                ? (run.error ?? "Failed")
                : `${done} step${done === 1 ? "" : "s"} · ${formatDistanceToNow(parseISO(run.completed_at ?? run.created_at))} ago`}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            meta.tone,
          )}
        >
          {meta.label}
        </span>
      </button>

      {open && run.log.length > 0 && (
        <ol className="mt-3 space-y-1.5 border-l border-slate-200 pl-4">
          {run.log.map((entry, i) => (
            <li key={i} className="text-xs">
              <span
                className={cn(
                  "font-medium",
                  entry.ok === false ? "text-rose-600" : "text-slate-600",
                )}
              >
                {STEP_META[entry.step as AutomationStepKind]?.label ??
                  entry.step ??
                  "Step"}
              </span>
              {entry.detail && (
                <span className="text-slate-400"> — {entry.detail}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {open && run.log.length === 0 && (
        <p className="mt-3 pl-4 text-xs text-slate-400">
          Nothing logged yet — the first step hasn&apos;t run.
        </p>
      )}
    </li>
  );
}
