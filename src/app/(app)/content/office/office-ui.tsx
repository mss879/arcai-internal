"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";

import { Badge } from "@/components/ui/badge";
import type { OfficeMissionStatus, OfficeTaskStatus } from "@/lib/database.types";
import { cn } from "@/lib/utils";

/** Small shared bits for the office UI (0130). */

export function usd(n: number): string {
  const v = Number(n) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return formatDistanceToNow(t, { addSuffix: true });
}

export function elapsedLabel(ms: number): string {
  if (ms < 1_000) return "just now";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const MISSION_TONE: Record<OfficeMissionStatus, { label: string; className: string; dot: string }> = {
  planning: { label: "Planning", className: "bg-amber-50 text-amber-700 ring-amber-200", dot: "bg-amber-500" },
  running: { label: "In progress", className: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500" },
  review: { label: "Needs your approval", className: "bg-orange-50 text-orange-700 ring-orange-200", dot: "bg-orange-500" },
  approved: { label: "Approved", className: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  done: { label: "Done", className: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  failed: { label: "Stopped", className: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500" },
  cancelled: { label: "Cancelled", className: "bg-slate-100 text-slate-600 ring-slate-200", dot: "bg-slate-400" },
  paused: { label: "Paused", className: "bg-amber-50 text-amber-700 ring-amber-200", dot: "bg-amber-500" },
};

export function MissionBadge({ status, className }: { status: OfficeMissionStatus; className?: string }) {
  const t = MISSION_TONE[status] ?? MISSION_TONE.running;
  return (
    <Badge className={cn(t.className, className)} dot={t.dot}>
      {t.label}
    </Badge>
  );
}

const TASK_TONE: Record<OfficeTaskStatus, { label: string; className: string }> = {
  queued: { label: "Waiting", className: "bg-slate-100 text-slate-500 ring-slate-200" },
  ready: { label: "Up next", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  running: { label: "Working", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  done: { label: "Done", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  cancelled: { label: "Cancelled", className: "bg-slate-100 text-slate-500 ring-slate-200" },
  blocked: { label: "Blocked", className: "bg-amber-50 text-amber-700 ring-amber-200" },
};

export function TaskBadge({ status, className }: { status: OfficeTaskStatus; className?: string }) {
  const t = TASK_TONE[status] ?? TASK_TONE.queued;
  return <Badge className={cn(t.className, className)}>{t.label}</Badge>;
}

export function AgentDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ background: color }} aria-hidden />;
}

/** A tiny switch, the same shape the AI Projects agent tab uses. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-primary-500" : "bg-slate-300",
      )}
    >
      <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{children}</h3>
      {right}
    </div>
  );
}

/** Comma / newline separated text ↔ list, for the brand editor. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
