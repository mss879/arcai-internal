"use client";

/**
 * The idle stage (0104) — standby is a dashboard, not a void.
 *
 * When nothing is on the stage, the terminal shows the business breathing:
 * a greeting plate with the clock, the vital signs from the briefing's own
 * numbers, today's briefing headline, and the open events streaming in from
 * the pulse. Every element answers to a real row; nothing here is set
 * dressing. Clicking an event asks Arcus about it — reading the feed and
 * acting on it are the same gesture.
 */

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, X } from "lucide-react";

import {
  useAmbient,
  type AmbientEvent,
} from "@/components/assistant/command/use-ambient";
import { useReducedMotionSafe } from "@/components/assistant/studio-store";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";

const KIND_TONE: Record<AmbientEvent["kind"], string> = {
  warning: "text-amber-300 border-amber-400/25 bg-amber-400/5",
  action: "text-[var(--stage-accent)] border-primary-400/30 bg-primary-400/5",
  win: "text-emerald-300 border-emerald-400/25 bg-emerald-400/5",
  info: "text-[var(--stage-dim)] border-[var(--stage-border)] bg-transparent",
};

function Vital({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn" | "good";
}) {
  return (
    <div className="hud-panel hud-panel--tight relative px-3.5 py-2.5">
      <p className="hud-mono text-[9px] uppercase tracking-[0.22em] text-[var(--stage-faint)]">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums leading-tight",
          tone === "warn"
            ? "text-amber-300"
            : tone === "good"
              ? "text-emerald-300"
              : "text-[var(--stage-text)]",
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="hud-mono mt-0.5 text-[9px] tracking-wider text-[var(--stage-faint)]/80">
          {sub}
        </p>
      )}
    </div>
  );
}

export function AmbientStage({
  firstName,
  onPrompt,
  onNavigate,
  showDashboard,
}: {
  firstName: string;
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
  /**
   * The vitals / events / briefing dashboard is OPT-IN. Standby defaults to
   * a clean greeting — a screen full of numbers nobody asked for reads as
   * clutter, and the feed does not even fetch until this is on.
   */
  showDashboard: boolean;
}) {
  const reduced = useReducedMotionSafe();
  const { stats, events, briefing, dismiss, loaded } = useAmbient(showDashboard);

  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-4 overflow-y-auto py-6 pr-1">
      {/* Greeting plate */}
      <div className="hud-panel hud-ticks relative shrink-0 px-10 py-6 text-center">
        <p className="hud-title">Arcus interface</p>
        {/* The same words it SPEAKS on open — screen and voice must agree. */}
        <p className="mt-3 text-2xl font-medium tracking-tight text-[var(--stage-text)]">
          Hi, {firstName}.
        </p>
        <p className="hud-mono mt-1.5 text-[11px] uppercase tracking-[0.22em] text-[var(--stage-faint)]">
          How may I help you today?
        </p>
        {now && (
          <p className="hud-mono mt-4 text-4xl font-light tabular-nums tracking-widest text-[var(--stage-accent)]">
            {now.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
      </div>

      {/* Vital signs — the briefing's own numbers, at a glance. */}
      {showDashboard && stats && (
        <div className="grid w-full max-w-[720px] shrink-0 grid-cols-2 gap-2 px-2 sm:grid-cols-4">
          <Vital
            label="Revenue MTD"
            value={formatCurrency(stats.revenue_month)}
            sub={`EXPENSES ${formatCurrency(stats.expenses_month)}`}
          />
          <Vital
            label="Unpaid invoices"
            value={String(stats.unpaid_invoices)}
            sub={formatCurrency(stats.unpaid_value)}
            tone={stats.unpaid_invoices > 0 ? "warn" : undefined}
          />
          <Vital
            label="New leads / wk"
            value={String(stats.new_leads)}
            sub={`${stats.going_cold} GOING COLD`}
            tone={stats.new_leads > 0 ? "good" : undefined}
          />
          <Vital
            label="Overdue tasks"
            value={String(stats.overdue_tasks)}
            sub={`${stats.cheques_due_week} CHEQUES DUE`}
            tone={stats.overdue_tasks > 0 ? "warn" : undefined}
          />
        </div>
      )}

      {/* Today's briefing, when it exists. */}
      {showDashboard && briefing && (
        <button
          type="button"
          onClick={() => onPrompt("Read me today's briefing")}
          className="hud-panel hud-panel--tight relative w-full max-w-[720px] shrink-0 px-4 py-3 text-left transition-colors hover:bg-[var(--stage-panel-hover)]"
        >
          <p className="hud-title">Morning briefing</p>
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-[var(--stage-dim)]">
            {briefing.headline}
          </p>
          <p className="hud-mono mt-1.5 flex items-center gap-1 text-[9px] uppercase tracking-[0.2em] text-[var(--stage-accent)]">
            Ask me to read it
            <ArrowRight className="h-3 w-3" />
          </p>
        </button>
      )}

      {/* The open events — what Arcus is waiting to tell you. */}
      {showDashboard && events.length > 0 && (
        <div className="w-full max-w-[720px] shrink-0 space-y-1.5 px-2 pb-2">
          <p className="hud-title px-1">Attention</p>
          <AnimatePresence initial={false}>
            {events.map((event) => (
              <motion.div
                key={event.id}
                layout={!reduced}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
                transition={{ duration: 0.18 }}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border px-3 py-2",
                  KIND_TONE[event.kind] ?? KIND_TONE.info,
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    event.href
                      ? onNavigate(event.href)
                      : onPrompt(`Tell me about this: ${event.title}`)
                  }
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[12px] font-medium text-[var(--stage-text)]">
                    {event.title}
                  </p>
                  {event.body && (
                    <p className="truncate text-[11px] text-[var(--stage-faint)]">
                      {event.body}
                    </p>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => dismiss(event.id)}
                  aria-label="Dismiss"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--stage-faint)] hover:bg-white/10 hover:text-[var(--stage-text)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {(!showDashboard || (loaded && !stats && events.length === 0)) && (
        <p className="hud-mono text-[10px] uppercase tracking-[0.3em] text-[var(--stage-faint)]/70">
          Talk to me — results appear here
        </p>
      )}
    </div>
  );
}
