"use client";

/**
 * This project's own history (LOOP-5).
 *
 * `delivery_events` has recorded kickoffs, stage moves, chases, assets landing
 * and stalled alerts per project since 0084 — but the only place it was ever
 * rendered was the hub's global feed, where one project's story is interleaved
 * with everyone else's.
 */

import * as React from "react";
import { format } from "date-fns";
import {
  Activity,
  ArrowRightLeft,
  Bell,
  CheckCheck,
  FileSignature,
  FileUp,
  Gauge,
  GitPullRequestArrow,
  Lock,
  LockOpen,
  MessageCircle,
  MessageSquare,
  PackageCheck,
  Rocket,
  Send,
  SlashSquare,
  Star,
} from "lucide-react";

import type { DeliveryEvent, DeliveryEventKind } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_META: Record<
  DeliveryEventKind,
  { label: string; icon: React.ReactNode; tone: string }
> = {
  kickoff: {
    label: "Kickoff",
    icon: <Rocket className="h-3.5 w-3.5" />,
    tone: "bg-primary-50 text-primary-600",
  },
  stage_changed: {
    label: "Stage",
    icon: <ArrowRightLeft className="h-3.5 w-3.5" />,
    tone: "bg-sky-50 text-sky-600",
  },
  asset_submitted: {
    label: "Asset in",
    icon: <FileUp className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  asset_filed: {
    label: "Asset filed",
    icon: <FileUp className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  asset_na: {
    label: "Not applicable",
    icon: <SlashSquare className="h-3.5 w-3.5" />,
    tone: "bg-slate-100 text-slate-500",
  },
  chase_sent: {
    label: "Chased",
    icon: <Send className="h-3.5 w-3.5" />,
    tone: "bg-amber-50 text-amber-600",
  },
  stalled_alert: {
    label: "Stalled",
    icon: <Bell className="h-3.5 w-3.5" />,
    tone: "bg-rose-50 text-rose-600",
  },
  assets_complete: {
    label: "All assets in",
    icon: <CheckCheck className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  milestone_sent: {
    label: "Client told",
    icon: <MessageCircle className="h-3.5 w-3.5" />,
    tone: "bg-violet-50 text-violet-600",
  },
  // 0094 — client experience
  portal_sent: {
    label: "Portal sent",
    icon: <Send className="h-3.5 w-3.5" />,
    tone: "bg-sky-50 text-sky-600",
  },
  portal_unlocked: {
    label: "Client opened the portal",
    icon: <LockOpen className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  portal_locked: {
    label: "Portal access changed",
    icon: <Lock className="h-3.5 w-3.5" />,
    tone: "bg-slate-100 text-slate-500",
  },
  review_requested: {
    label: "Review asked for",
    icon: <Star className="h-3.5 w-3.5" />,
    tone: "bg-amber-50 text-amber-600",
  },
  review_received: {
    label: "Review left",
    icon: <Star className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  approval_requested: {
    label: "Approval asked for",
    icon: <FileSignature className="h-3.5 w-3.5" />,
    tone: "bg-violet-50 text-violet-600",
  },
  approval_signed: {
    label: "Client signed off",
    icon: <FileSignature className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  change_requested: {
    label: "Change requested",
    icon: <GitPullRequestArrow className="h-3.5 w-3.5" />,
    tone: "bg-amber-50 text-amber-600",
  },
  change_accepted: {
    label: "Change accepted",
    icon: <GitPullRequestArrow className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  comment: {
    label: "Comment",
    icon: <MessageSquare className="h-3.5 w-3.5" />,
    tone: "bg-slate-100 text-slate-600",
  },
  pulse: {
    label: "Client mood",
    icon: <Gauge className="h-3.5 w-3.5" />,
    tone: "bg-sky-50 text-sky-600",
  },
  handover_sent: {
    label: "Handover pack sent",
    icon: <PackageCheck className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
};

export function ActivitySection({ events }: { events: DeliveryEvent[] }) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500">
          <Activity className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">History</h2>
          <p className="text-xs text-slate-400">
            Everything that has happened to this project
          </p>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-400">
          Nothing recorded yet. Moving the stage, chasing an asset or a client
          upload all show up here.
        </p>
      ) : (
        <ol className="relative ml-8 space-y-4 border-l border-slate-200 py-5 pr-5">
          {events.map((e) => {
            const meta = KIND_META[e.kind] ?? KIND_META.stage_changed;
            return (
              <li key={e.id} className="relative pl-6">
                <span
                  className={cn(
                    "absolute -left-[13px] top-0.5 grid h-6 w-6 place-items-center rounded-full ring-4 ring-white",
                    meta.tone,
                  )}
                >
                  {meta.icon}
                </span>
                <p className="text-sm text-slate-800">
                  <span className="font-medium">{meta.label}</span>
                  {e.detail ? ` — ${e.detail}` : ""}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {format(new Date(e.created_at), "d MMM yyyy, HH:mm")}
                  {e.actor ? ` · ${e.actor}` : ""}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
