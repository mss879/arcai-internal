"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  FileX2,
  Megaphone,
  MessageCircle,
  MoveRight,
  PartyPopper,
  Rocket,
} from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import type { DeliveryEvent, DeliveryEventKind } from "@/lib/types";

import type { DeliveryProject } from "./types";

const KIND_META: Record<
  DeliveryEventKind,
  { label: string; icon: React.ReactNode; tone: string }
> = {
  kickoff: {
    label: "Onboarding started",
    icon: <Rocket className="h-3.5 w-3.5" />,
    tone: "bg-primary-50 text-primary-600",
  },
  stage_changed: {
    label: "Stage moved",
    icon: <MoveRight className="h-3.5 w-3.5" />,
    tone: "bg-violet-50 text-violet-600",
  },
  asset_submitted: {
    label: "Asset received",
    icon: <FileCheck2 className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  asset_filed: {
    label: "Asset filed",
    icon: <FileCheck2 className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  asset_na: {
    label: "Asset n/a",
    icon: <FileX2 className="h-3.5 w-3.5" />,
    tone: "bg-slate-100 text-slate-500",
  },
  chase_sent: {
    label: "Client nudged",
    icon: <MessageCircle className="h-3.5 w-3.5" />,
    tone: "bg-amber-50 text-amber-600",
  },
  stalled_alert: {
    label: "Stalled alert",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    tone: "bg-rose-50 text-rose-600",
  },
  assets_complete: {
    label: "All assets in",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    tone: "bg-emerald-50 text-emerald-600",
  },
  milestone_sent: {
    label: "Milestone sent",
    icon: <Megaphone className="h-3.5 w-3.5" />,
    tone: "bg-sky-50 text-sky-600",
  },
};

export function ActivityTab({
  events,
  projects,
}: {
  events: DeliveryEvent[];
  projects: DeliveryProject[];
}) {
  const projectName = React.useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? "(deleted project)";
  }, [projects]);

  if (!events.length) {
    return (
      <EmptyState
        icon={<PartyPopper className="h-6 w-6" />}
        title="Nothing yet"
        description="Kickoffs, received assets, nudges and stage moves will show up here the moment delivery starts moving."
      />
    );
  }

  const byDay = new Map<string, DeliveryEvent[]>();
  for (const e of events) {
    const day = new Date(e.created_at).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }

  return (
    <div className="max-w-3xl space-y-6">
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <div key={day}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {day}
          </h3>
          <div className="space-y-2">
            {dayEvents.map((e) => {
              const meta = KIND_META[e.kind] ?? KIND_META.stage_changed;
              return (
                <div
                  key={e.id}
                  className="flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-[var(--shadow-card)]"
                >
                  <span
                    className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${meta.tone}`}
                  >
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-800">
                      <span className="font-semibold">{projectName(e.project_id)}</span>
                      <span className="mx-1.5 text-slate-300">·</span>
                      {meta.label}
                    </p>
                    {e.detail && (
                      <p className="mt-0.5 truncate text-xs text-slate-500">{e.detail}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-slate-400">
                    <div>
                      {new Date(e.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                    {e.actor && <div>{e.actor}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
