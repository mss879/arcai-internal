"use client";

/**
 * The `metrics` artifact — a row of headline numbers ("this month's numbers":
 * revenue in, costs out, margin, outstanding).
 *
 * Two rules earn their keep here. First, a tile with an `href` is a real
 * button, because the number always provokes the same question ("which
 * invoices?") and the answer is one click away. Second, a zero delta never
 * gets an arrow — an arrow is a claim about direction, and 0% has none.
 *
 * Presentational only: data in via props, intent out via `onNavigate`.
 */

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ArtifactField } from "@/lib/assistant-artifacts";
import {
  deltaTone,
  formatCell,
  formatDelta,
  TONE_PILL,
  TONE_PILL_STAGE,
  type ArtifactOf,
} from "./artifact-format";

function TileBody({
  metric,
  stage,
}: {
  metric: ArtifactField;
  stage?: boolean;
}): React.ReactElement {
  const delta = metric.delta;
  const tone = metric.tone ?? (delta != null ? deltaTone(delta) : "neutral");
  const DeltaIcon = delta != null && delta > 0 ? ArrowUp : ArrowDown;

  return (
    <>
      <p
        className={cn(
          "text-[11px] font-medium uppercase tracking-wide",
          stage ? "text-[var(--stage-faint)]" : "text-slate-400",
        )}
      >
        {metric.label}
      </p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          stage ? "text-[var(--stage-text)]" : "text-slate-900",
        )}
      >
        {formatCell(metric.value, metric.format)}
      </p>
      {delta != null && (
        <span
          className={cn(
            "mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
            (stage ? TONE_PILL_STAGE : TONE_PILL)[tone],
          )}
        >
          {delta !== 0 && <DeltaIcon aria-hidden className="h-3 w-3" />}
          {formatDelta(delta)}
          <span className="font-normal opacity-70">vs. last period</span>
        </span>
      )}
    </>
  );
}

export type MetricsArtifactProps = {
  artifact: ArtifactOf<"metrics">;
  /** True when the pane is narrow: the grid collapses to a single column. */
  dense: boolean;
  onNavigate: (href: string) => void;
  /** Paint for the dark command stage. */
  stage?: boolean;
};

/** Render a `metrics` artifact as a grid of stat tiles. */
export function MetricsArtifact({
  artifact,
  dense,
  onNavigate,
  stage,
}: MetricsArtifactProps): React.ReactElement {
  if (artifact.metrics.length === 0) {
    return (
      <p
        className={cn(
          "py-10 text-center text-[13px]",
          stage ? "text-[var(--stage-faint)]" : "text-slate-400",
        )}
      >
        No numbers came back for this period.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-3",
        dense ? "grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-3",
      )}
    >
      {artifact.metrics.map((metric, i) => {
        const href = metric.href;
        const key = `${metric.label}-${i}`;
        const shell = stage
          ? "rounded-2xl border border-[var(--stage-border)] bg-[var(--stage-panel)] p-4"
          : "rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-soft)]";

        if (!href) {
          return (
            <div key={key} className={shell}>
              <TileBody metric={metric} stage={stage} />
            </div>
          );
        }

        return (
          <button
            key={key}
            type="button"
            onClick={() => onNavigate(href)}
            className={cn(
              shell,
              "group relative text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
              stage
                ? "hover:bg-[var(--stage-panel-hover)]"
                : "hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-[var(--shadow-lift)]",
            )}
          >
            <TileBody metric={metric} stage={stage} />
            <ChevronRight
              aria-hidden
              className={cn(
                "absolute right-3 top-4 h-4 w-4 transition group-hover:translate-x-0.5 group-hover:text-primary-500",
                stage ? "text-[var(--stage-faint)]" : "text-slate-300",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
