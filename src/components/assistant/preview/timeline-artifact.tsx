"use client";

/**
 * The `timeline` artifact — dated events on a vertical rail: a project's
 * history, a client's payments, what happened in the pipeline this week.
 *
 * Order is the server's: entries arrive newest-first and are rendered in that
 * order untouched. Sorting them here would fight tools that deliberately
 * return a forward-running schedule (upcoming meetings, milestone dates).
 *
 * Presentational only: data in via props, intent out via `onNavigate`.
 */

import * as React from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { TONE_TEXT, type ArtifactOf } from "./artifact-format";

export type TimelineArtifactProps = {
  artifact: ArtifactOf<"timeline">;
  /** True when the pane is narrow. */
  dense: boolean;
  onNavigate: (href: string) => void;
};

/** Render a `timeline` artifact as a rail of toned, optionally linked entries. */
export function TimelineArtifact({
  artifact,
  dense,
  onNavigate,
}: TimelineArtifactProps): React.ReactElement {
  if (artifact.entries.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-slate-400">
        Nothing has happened here yet.
      </p>
    );
  }

  return (
    <ol className="relative mx-auto w-full max-w-[640px]">
      {/* The rail sits behind the dots; inset top/bottom so it stops at the
          first and last dot instead of dangling past them. */}
      <span
        aria-hidden
        className="absolute bottom-3 left-[15px] top-3 w-px bg-slate-200"
      />

      {artifact.entries.map((entry, i) => {
        const href = entry.href;
        const tone = entry.tone ?? "neutral";

        const body = (
          <>
            <p className="text-[11px] tabular-nums text-slate-400">
              {entry.when}
            </p>
            <p
              className={cn(
                "text-[13px] font-medium text-slate-800",
                href && "group-hover:text-primary-700",
              )}
            >
              {entry.label}
            </p>
            {entry.detail && (
              <p
                className={cn(
                  "text-[12px] leading-relaxed text-slate-500",
                  dense ? "line-clamp-3" : "whitespace-pre-wrap",
                )}
              >
                {entry.detail}
              </p>
            )}
          </>
        );

        return (
          <li key={`${entry.when}-${entry.label}-${i}`} className="relative pb-5 pl-9">
            <span
              aria-hidden
              className={cn(
                "absolute left-[11px] top-1.5 h-2.5 w-2.5 rounded-full bg-current ring-4 ring-white",
                TONE_TEXT[tone],
              )}
            />
            {href ? (
              <button
                type="button"
                onClick={() => onNavigate(href)}
                className="group -mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-xl px-2 py-1 text-left transition hover:bg-primary-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
              >
                <span className="min-w-0 flex-1">{body}</span>
                <ChevronRight
                  aria-hidden
                  className="mt-1 h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-primary-500"
                />
              </button>
            ) : (
              <div className="-mx-2 px-2 py-1">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
