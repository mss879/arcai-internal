"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import type { LeadResearch } from "@/lib/types";

/**
 * The run-start epoch-ms stamped on the row at queue time (`analysis.runStartedAt`),
 * or null for older in-flight rows that predate it. Lets the timer show the REAL
 * elapsed time and survive refreshes rather than restarting from the mount.
 */
export function researchStartedAt(
  research: { analysis?: unknown } | null | undefined,
): number | null {
  const a = research?.analysis as { runStartedAt?: unknown } | null | undefined;
  return typeof a?.runStartedAt === "number" ? a.runStartedAt : null;
}

/**
 * Live progress for an in-progress research report: the current phase, a filling
 * bar, and a ticking elapsed timer — so it's obvious the run is working (and
 * roughly how far along it is), not silently stuck. Render only while the row is
 * NOT done/error.
 *
 * The pipeline is pending/running → discovered → analyzed → synthesizing → done;
 * we collapse that to three human phases. The timer counts from `startedAt` (the
 * server-stored run start) so it shows the REAL elapsed time and survives
 * refreshes; it only falls back to the mount time for older rows that have no
 * stored start.
 */
const PHASES: { label: string; pct: number }[] = [
  { label: "Scanning the web & the company's site", pct: 22 },
  { label: "Sizing up competitors & services", pct: 55 },
  { label: "Writing the dossier — deep AI analysis", pct: 85 },
];

function phaseFor(status: LeadResearch["status"]): number {
  if (status === "pending" || status === "running") return 0;
  if (status === "discovered") return 1;
  return 2; // analyzed / synthesizing / audited
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ResearchProgress({
  status,
  startedAt = null,
  className,
}: {
  status: LeadResearch["status"];
  /** Server-stored run start (epoch ms). Null → fall back to the mount time. */
  startedAt?: number | null;
  className?: string;
}) {
  // Elapsed starts at 0 so the first paint is "0:00" on both server and client
  // (no hydration mismatch); the effect then anchors to the stored run start and
  // ticks. Keeping Date.now() out of render satisfies the repo's purity rules.
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    const start = startedAt ?? Date.now();
    const update = () => setElapsed(Math.max(0, Date.now() - start));
    update(); // correct immediately (e.g. to 0:47 on a refresh), no 0:00 flash
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const phase = phaseFor(status);
  const { label, pct } = PHASES[phase];

  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 bg-slate-50/70 p-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-primary-500" />
          <span className="truncate text-sm font-medium text-slate-600">
            {label}…
          </span>
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">
          {fmtElapsed(elapsed)}
        </span>
      </div>

      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-primary-500 transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
        <span>Step {phase + 1} of 3</span>
        <span>Usually ~1–2 min</span>
      </div>
    </div>
  );
}
