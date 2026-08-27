"use client";

/**
 * The live activity trail — what Arc is actually doing while you wait.
 *
 * A spinner says "something is happening"; it does not say *what*. When a
 * single question can fan out into half a dozen tool calls (read the clients,
 * price the package, write the proposal, render the PDF) an undifferentiated
 * wait reads as a hang. This renders each `ToolStep` as it arrives — running,
 * done, or failed — so the pause feels like work.
 *
 * Once the turn is finished the same steps collapse to one quiet line
 * ("Used 4 tools"), expandable on click, because a finished transcript should
 * read as a conversation, not as a build log.
 */

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  Loader2,
  Pencil,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { AssistantEvent, ToolStep } from "@/lib/assistant-stream";

export type ActivityTrailProps = {
  /** Tool steps in arrival order. */
  steps: ToolStep[];
  /** Live trail (turn in flight) vs. the collapsed summary on a finished turn. */
  live: boolean;
  /**
   * Route an event's `href` through the app router. Omitted → the event
   * renders as plain text; a raw `<a href>` would full-page-navigate out of
   * the Studio overlay and throw the conversation away.
   */
  onNavigate?: (href: string) => void;
  className?: string;
};

const EVENT_ICON = {
  read: Eye,
  created: CheckCircle2,
  updated: Pencil,
} as const;

const EVENT_TONE = {
  read: "text-slate-500 hover:text-slate-700",
  created: "text-emerald-600 hover:text-emerald-700",
  updated: "text-primary-600 hover:text-primary-700",
} as const;

/** The little "Read 12 clients" chip a finished tool leaves behind. */
function TrailEvent({
  event,
  onNavigate,
}: {
  event: AssistantEvent;
  onNavigate?: (href: string) => void;
}) {
  const Icon = EVENT_ICON[event.kind];
  const inner = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{event.label}</span>
    </>
  );
  const base = cn(
    "inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium",
    EVENT_TONE[event.kind],
  );

  if (event.href && onNavigate) {
    const href = event.href;
    return (
      <button
        type="button"
        onClick={() => onNavigate(href)}
        className={cn(
          base,
          "rounded-md underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
        )}
      >
        {inner}
      </button>
    );
  }
  return <span className={base}>{inner}</span>;
}

function StepRow({
  step,
  onNavigate,
}: {
  step: ToolStep;
  onNavigate?: (href: string) => void;
}) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <span className="mt-[3px] shrink-0">
        {step.state === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-500" />
        ) : step.state === "error" ? (
          <CircleAlert className="h-3.5 w-3.5 text-rose-500" />
        ) : (
          <Check className="h-3.5 w-3.5 text-emerald-600" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate",
            step.state === "running"
              ? "font-medium text-slate-900"
              : step.state === "error"
                ? "text-rose-600"
                : "text-slate-600",
          )}
        >
          {step.label}
        </span>
        {step.state === "error" && step.error && (
          <span className="mt-0.5 block text-[11px] text-rose-500">{step.error}</span>
        )}
        {step.state === "done" && step.event && (
          <span className="mt-0.5 block">
            <TrailEvent event={step.event} onNavigate={onNavigate} />
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * Renders a turn's tool steps. Expanded and announced while `live`, collapsed
 * to a summary line afterwards. Returns `null` when there is nothing to show.
 */
export function ActivityTrail({
  steps,
  live,
  onNavigate,
  className,
}: ActivityTrailProps): React.ReactElement | null {
  const reduced = useReducedMotion();
  // Collapsed by default: a finished turn should read as a conversation, not
  // as a build log. (The live trail has no toggle, so this stays false until
  // the user opens the summary themselves.)
  const [open, setOpen] = React.useState(false);

  if (steps.length === 0) return null;

  const list = (
    <ul className="space-y-1.5">
      {steps.map((step) => (
        <StepRow key={step.id} step={step} onNavigate={onNavigate} />
      ))}
    </ul>
  );

  if (live) {
    return (
      <div
        aria-live="polite"
        aria-label="What Arcus is doing"
        className={cn(
          "space-y-1.5 rounded-2xl border border-slate-200/70 bg-white/70 px-3.5 py-2.5",
          className,
        )}
      >
        {list}
      </div>
    );
  }

  const failed = steps.filter((s) => s.state === "error").length;

  return (
    <div className={cn("text-[13px]", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg py-0.5 text-[12px] font-medium text-slate-400 transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Used {steps.length} tool{steps.length === 1 ? "" : "s"}
        {failed > 0 && (
          <span className="text-rose-500">
            · {failed} failed
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-1.5 rounded-2xl border border-slate-200/70 bg-white/70 px-3.5 py-2.5">
              {list}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
