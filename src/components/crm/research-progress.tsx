"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import type { LeadResearch } from "@/lib/types";

/**
 * Live progress for an in-progress research report: the current phase, a filling
 * bar, and a ticking elapsed timer — so it's obvious the run is working (and
 * roughly how far along it is), not silently stuck. Render only while the row is
 * NOT done/error.
 *
 * The pipeline is pending/running → discovered → analyzed → synthesizing → done;
 * we collapse that to three human phases. The timer counts from when this client
 * first showed the card, so it resets on reload — that's fine, its job is to show
 * the run is alive, not to be an authoritative stopwatch.
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
  className,
}: {
  status: LeadResearch["status"];
  className?: string;
}) {
  // Elapsed starts at 0 so the first paint is "0:00" on both server and client
  // (no hydration mismatch); the clock starts and ticks from inside the effect,
  // keeping render pure (no Date.now()/ref reads during render).
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, []);

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
