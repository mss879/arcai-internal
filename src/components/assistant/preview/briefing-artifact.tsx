"use client";

/**
 * The morning briefing (0102) — the one artifact Arcus writes unprompted.
 *
 * Everything else in the canvas answers a question. This one arrives before
 * there is a question, which changes what it has to do: it must be readable
 * in about ten seconds, and every line worth acting on must be one tap from
 * being acted on.
 *
 * Hence the two halves. The SECTIONS are plain figures — the numbers came
 * from real queries, the model only chose the order and the wording, so they
 * are rendered flat with no chrome to argue with. The PRIORITIES are chips
 * that send themselves back into the conversation as prompts; reading "three
 * invoices are overdue" and asking about them is the same gesture, which is
 * the entire reason the briefing is a conversation rather than an email.
 */

import * as React from "react";
import { ArrowRight, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ArtifactOf } from "./artifact-format";

const TONE_BAR: Record<string, string> = {
  positive: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-rose-400",
  info: "bg-sky-400",
  neutral: "bg-slate-300",
};

export function BriefingArtifact({
  artifact,
  dense,
  onPrompt,
  onNavigate,
}: {
  artifact: ArtifactOf<"briefing">;
  dense?: boolean;
  /** Sends a chip's prompt back as if the user had typed it. */
  onPrompt?: (text: string) => void;
  onNavigate?: (href: string) => void;
}) {
  return (
    <div className={cn("space-y-5", dense && "space-y-4")}>
      <header className="flex items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl gradient-primary text-white">
          <Sparkles className="h-4.5 w-4.5" />
        </span>
        <h2
          className={cn(
            "font-semibold leading-snug text-slate-900",
            dense ? "text-base" : "text-lg",
          )}
        >
          {artifact.headline}
        </h2>
      </header>

      <div className="space-y-4">
        {artifact.sections.map((section, i) => (
          <section key={`${section.title}-${i}`} className="flex gap-3">
            <span
              aria-hidden
              className={cn(
                "mt-1 w-1 shrink-0 rounded-full",
                TONE_BAR[section.tone ?? "neutral"] ?? TONE_BAR.neutral,
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  {section.title}
                </h3>
                {section.href && onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate(section.href as string)}
                    className="shrink-0 text-xs font-medium text-primary-600 hover:text-primary-700"
                  >
                    Open
                  </button>
                )}
              </div>
              <ul className="mt-1 space-y-1">
                {section.lines.map((line, j) => (
                  <li
                    key={`${section.title}-${j}`}
                    className="text-sm leading-relaxed text-slate-700"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>

      {artifact.priorities && artifact.priorities.length > 0 && onPrompt && (
        <div className="border-t border-slate-200 pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            Want me to
          </p>
          <div className="flex flex-wrap gap-2">
            {artifact.priorities.map((priority, i) => (
              <button
                key={`${priority.label}-${i}`}
                type="button"
                onClick={() => onPrompt(priority.prompt)}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
              >
                {priority.label}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
