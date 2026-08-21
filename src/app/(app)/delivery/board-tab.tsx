"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageCircle, PauseCircle, PlayCircle, Rocket } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import {
  DELIVERY_STAGES,
  DELIVERY_STAGE_META,
  SERVICE_TYPE_LABELS,
} from "@/lib/constants";
import type {
  DeliverySettings,
  DeliveryStage,
  ProjectDocumentRequest,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  saveDeliveryStage,
  startOnboardingManual,
  toggleChaserPaused,
} from "./actions";
import type { DeliveryProject } from "./types";

export function BoardTab({
  projects,
  requests,
  settings,
}: {
  projects: DeliveryProject[];
  requests: ProjectDocumentRequest[];
  settings: DeliverySettings | null;
}) {
  const byProject = React.useMemo(() => {
    const map = new Map<string, ProjectDocumentRequest[]>();
    for (const r of requests) {
      const list = map.get(r.project_id) ?? [];
      list.push(r);
      map.set(r.project_id, list);
    }
    return map;
  }, [requests]);

  const columns: { key: string; label: string; stage: DeliveryStage | null }[] = [
    { key: "none", label: "Not started", stage: null },
    ...DELIVERY_STAGES.map((s) => ({
      key: s,
      label: DELIVERY_STAGE_META[s].label,
      stage: s as DeliveryStage,
    })),
  ];

  return (
    <div className="-mx-1 overflow-x-auto pb-2">
      <div className="flex min-w-max gap-4 px-1">
        {columns.map((col) => {
          const items = projects.filter((p) => (p.delivery_stage ?? null) === col.stage);
          return (
            <div key={col.key} className="w-72 shrink-0">
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {col.label}
                </h3>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                  {items.length}
                </span>
              </div>
              <div className="space-y-3">
                {items.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white/50 px-4 py-8 text-center text-xs text-slate-400">
                    Nothing here
                  </div>
                )}
                {items.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    checklist={byProject.get(project.id) ?? []}
                    stalledDays={settings?.stalled_days ?? 5}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  checklist,
  stalledDays,
}: {
  project: DeliveryProject;
  checklist: ProjectDocumentRequest[];
  stalledDays: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [starting, setStarting] = React.useState(false);
  // Stable "now" per mount — render purity (and the badge doesn't need to
  // tick live; realtime refreshes remount with fresh data anyway).
  const [now] = React.useState(() => Date.now());

  const required = checklist.filter((r) => r.required);
  const done = required.filter((r) => r.status !== "pending").length;
  const pct = required.length ? Math.round((done / required.length) * 100) : null;
  const waitingOnClient =
    !!project.delivery_stage &&
    ["onboarding", "assets"].includes(project.delivery_stage) &&
    done < required.length;
  const stalled =
    !!project.delivery_stage &&
    !["delivered", "aftercare"].includes(project.delivery_stage) &&
    now - new Date(project.updated_at).getTime() > stalledDays * 24 * 3600_000;

  function handleStage(stage: string) {
    startTransition(async () => {
      const res = await saveDeliveryStage(project.id, stage as DeliveryStage);
      if (res.ok) {
        toast.success(`${project.name} → ${DELIVERY_STAGE_META[stage as DeliveryStage].label}`);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  async function handleStartOnboarding() {
    setStarting(true);
    const res = await startOnboardingManual(project.id);
    setStarting(false);
    if (res.ok) {
      toast.success(res.detail ?? "Onboarding started.");
      router.refresh();
    } else toast.error(res.error);
  }

  function handleChaserPause() {
    startTransition(async () => {
      const res = await toggleChaserPaused(project.id, !project.chaser_paused);
      if (res.ok) {
        toast.success(
          project.chaser_paused ? "Chaser resumed." : "Chaser paused for this project.",
        );
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/projects/${project.id}`}
            className="block truncate text-sm font-semibold text-slate-900 hover:text-primary-600"
          >
            {project.name}
          </Link>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {project.client?.name ?? "No client"}
            {project.service_type
              ? ` · ${SERVICE_TYPE_LABELS[project.service_type] ?? project.service_type}`
              : ""}
          </p>
        </div>
        {project.onboarding_started_at ? (
          <Badge className="shrink-0 bg-emerald-50 text-emerald-600 ring-emerald-200">
            <MessageCircle className="h-3 w-3" /> agent
          </Badge>
        ) : null}
      </div>

      {pct !== null && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>
              Assets {done}/{required.length}
            </span>
            <span>{pct}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct === 100 ? "bg-emerald-500" : "bg-primary-500",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {(waitingOnClient || stalled || project.chaser_paused) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {stalled && (
            <Badge className="bg-rose-50 text-rose-600 ring-rose-200">Stalled</Badge>
          )}
          {waitingOnClient && (
            <Badge className="bg-amber-50 text-amber-600 ring-amber-200">
              Waiting on client
            </Badge>
          )}
          {project.chaser_paused && (
            <Badge className="bg-slate-100 text-slate-500 ring-slate-200">
              Chaser paused
            </Badge>
          )}
        </div>
      )}

      <div className="mt-3 space-y-2">
        <Select
          value={project.delivery_stage ?? ""}
          disabled={pending}
          onChange={(e) => e.target.value && handleStage(e.target.value)}
          className="h-9 text-xs"
        >
          <option value="">Not started</option>
          {DELIVERY_STAGES.map((s) => (
            <option key={s} value={s}>
              {DELIVERY_STAGE_META[s].label}
            </option>
          ))}
        </Select>

        <div className="flex items-center gap-2">
          {!project.onboarding_started_at && project.client_id && (
            <Button
              size="sm"
              className="flex-1"
              onClick={handleStartOnboarding}
              loading={starting}
            >
              <Rocket className="h-3.5 w-3.5" />
              Start onboarding
            </Button>
          )}
          {project.onboarding_started_at && waitingOnClient && (
            <button
              onClick={handleChaserPause}
              disabled={pending}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-600"
              title={project.chaser_paused ? "Resume automatic nudges" : "Pause automatic nudges"}
            >
              {project.chaser_paused ? (
                <PlayCircle className="h-3.5 w-3.5" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5" />
              )}
              {project.chaser_paused ? "Resume chaser" : "Pause chaser"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
