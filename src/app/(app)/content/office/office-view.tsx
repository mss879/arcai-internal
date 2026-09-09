"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Activity, Bot, CalendarClock, ListChecks, Palette, Play, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { OfficeSnapshot } from "@/lib/agents/office-types";
import type { CarouselOption, CarouselPost } from "@/lib/types";
import { cn } from "@/lib/utils";

import { pauseAgent } from "../office-actions";
import { ActivityFeed } from "./activity-feed";
import { AgentDetailsModal } from "./agent-details";
import { AgentSettingsPanel, type ModelChoice } from "./agent-settings-panel";
import { BrandPanel } from "./brand-panel";
import { ControlDock } from "./control-dock";
import { MissionDrawer } from "./mission-drawer";
import { OfficeFloor } from "./office-floor";
import type { Rotation } from "./office-layout";
import { sceneFor, type RobotView } from "./office-sim";
import { AgentDot, MissionBadge, SectionTitle, relTime, usd } from "./office-ui";
import { describeCadence } from "@/lib/agents/office-core";
import { SchedulesPanel } from "./schedules-panel";
import { SpendMeter } from "./spend-meter";
import { useOfficeLive } from "./use-office-live";

type SubTab = "missions" | "timers" | "agents" | "brand";

const ROTATION_KEY = "office-rotation";

/**
 * The Content Office (0130): the floor you walk around, the people on it,
 * and the controls.
 */
export function OfficeView({
  snapshot: initial,
  models,
  carouselPosts,
  carouselOptions,
  initialMissionId,
  viewerName,
  active,
}: {
  snapshot: OfficeSnapshot;
  models: ModelChoice[];
  carouselPosts: CarouselPost[];
  carouselOptions: CarouselOption[];
  initialMissionId: string | null;
  viewerName: string;
  /** False when another tab is showing: the floor pauses its heartbeat and keys. */
  active: boolean;
}) {
  const router = useRouter();
  const { snapshot, nowMs } = useOfficeLive(initial, active);
  const clock = nowMs || Date.parse(snapshot.loadedAt);
  const robots = React.useMemo(() => sceneFor(snapshot, clock), [snapshot, clock]);
  const workingCount = robots.filter((r) => r.kind === "agent" && r.task && ["running", "ready"].includes(r.task.status)).length;

  // The view can be turned; the choice sticks per browser.
  const [rotation, setRotation] = React.useState<Rotation>(0);
  React.useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(ROTATION_KEY));
      if ([0, 1, 2, 3].includes(saved)) setRotation(saved as Rotation);
    } catch {
      // storage unavailable — keep the default
    }
  }, []);
  const rotate = React.useCallback((dir: 1 | -1) => {
    setRotation((prev) => {
      const next = (((prev + dir) % 4) + 4) % 4 as Rotation;
      try {
        localStorage.setItem(ROTATION_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Who you are standing with, and whose details are open.
  const [nearId, setNearId] = React.useState<string | null>(null);
  const [details, setDetails] = React.useState<RobotView | null>(null);
  const detailsRobot = details ? robots.find((r) => r.id === details.id) ?? details : null;
  const detailsAgent = detailsRobot?.agentKey ? snapshot.agents.find((a) => a.key === detailsRobot.agentKey) ?? null : null;

  // Drawer, dock preset, sub-tabs.
  const [missionId, setMissionId] = React.useState<string | null>(initialMissionId);
  const mission = missionId ? snapshot.missions.find((m) => m.id === missionId) ?? null : null;
  const [presetAgent, setPresetAgent] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<SubTab>("missions");
  const dockRef = React.useRef<HTMLDivElement>(null);

  async function togglePause(agentKey: string, currentlyEnabled: boolean) {
    const res = await pauseAgent(agentKey, currentlyEnabled);
    if (!res.ok) return toast.error(res.error);
    toast.success(currentlyEnabled ? "Paused. Their tasks wait until you resume." : "Back at work.");
    router.refresh();
  }

  const giveTask = (key: string) => {
    setDetails(null);
    setPresetAgent(key);
    dockRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const activeMissions = snapshot.missions.filter((m) => ["planning", "running", "review", "paused", "failed"].includes(m.status));
  // Keys stop while a dialog is open so typing a note never walks the avatar.
  const floorEnabled = active && !details && !mission;

  const nextTimer = snapshot.schedules
    .filter((sc) => sc.is_active && sc.next_run_at)
    .sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))[0];
  const pausedCount = snapshot.agents.filter((a) => !a.enabled).length;

  return (
    <div className="space-y-5">
      {!snapshot.ready && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The office is furnished but nobody can work yet: apply <code className="rounded bg-white/70 px-1">supabase/migrations/0130_content_office.sql</code> in Supabase, then reload.
        </div>
      )}

      {/* The numbers, in one row, so the floor below can take the whole width. */}
      <div className="grid gap-4 md:grid-cols-3">
        <SpendMeter spend={snapshot.spend} isAdmin={snapshot.isAdmin} />
        <div className="card bg-white p-4">
          <SectionTitle right={<span className="text-xs text-slate-400">{activeMissions.length} open</span>}>Missions</SectionTitle>
          <ul className="mt-2 space-y-1">
            {activeMissions.slice(0, 3).map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => setMissionId(m.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-slate-50">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{m.title}</span>
                  <MissionBadge status={m.status} />
                </button>
              </li>
            ))}
            {!activeMissions.length && <li className="px-2 py-1 text-sm text-slate-500">Nothing in progress. Brief the Director below the floor.</li>}
            {activeMissions.length > 3 && (
              <li>
                <button type="button" onClick={() => setTab("missions")} className="px-2 text-xs font-medium text-primary-700 hover:underline">
                  All {activeMissions.length} open missions
                </button>
              </li>
            )}
          </ul>
        </div>
        <div className="card bg-white p-4">
          <SectionTitle right={<Activity className="h-3.5 w-3.5 text-slate-400" />}>The team</SectionTitle>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight text-slate-900">{workingCount}</span>
            <span className="text-sm text-slate-500">of {snapshot.agents.length} agents working</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {pausedCount ? `${pausedCount} paused · ` : ""}
            {nextTimer ? `Next timer: ${nextTimer.name}, ${describeCadence(nextTimer).toLowerCase()}` : "No timers armed"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {snapshot.agents.map((a) => (
              <button
                key={a.key}
                type="button"
                title={`${a.name} — ${a.title}`}
                onClick={() => {
                  const robot = robots.find((r) => r.agentKey === a.key);
                  if (robot) setDetails(robot);
                }}
                className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-slate-200 hover:bg-slate-50", !a.enabled && "opacity-50")}
              >
                <AgentDot color={a.color} /> {a.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* The floor, full width. No overflow clipping: cards may float over the edge. */}
      <div className="card relative bg-white p-2 sm:p-3">
        <OfficeFloor
          robots={robots}
          agents={snapshot.agents}
          nowMs={clock}
          rotation={rotation}
          onRotate={rotate}
          playerName={viewerName}
          enabled={floorEnabled}
          selectedId={detailsRobot?.id ?? null}
          nearId={nearId}
          onNearChange={setNearId}
          onRobotClick={(robot) => setDetails(robot)}
          onDetails={(robot) => setDetails(robot)}
          onOpenMission={setMissionId}
          workingCount={workingCount}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div ref={dockRef}>
          <ControlDock
            agents={snapshot.agents}
            clients={snapshot.clients}
            brandProfiles={snapshot.brandProfiles}
            isAdmin={snapshot.isAdmin}
            ready={snapshot.ready}
            presetAgent={presetAgent}
            onPresetConsumed={() => setPresetAgent(null)}
            onCreated={(id) => setMissionId(id)}
          />
        </div>
        <div className="card bg-white p-4">
          <SectionTitle>Live feed</SectionTitle>
          <ActivityFeed events={snapshot.events} agents={snapshot.agents} onOpenMission={setMissionId} className="mt-2" />
        </div>
      </div>

      <div className="card bg-white">
        <div className="flex flex-wrap gap-1 border-b border-slate-100 px-3 pt-3">
          <SubTabButton active={tab === "missions"} onClick={() => setTab("missions")} icon={<ListChecks className="h-4 w-4" />} count={snapshot.missions.length}>
            All missions
          </SubTabButton>
          <SubTabButton active={tab === "timers"} onClick={() => setTab("timers")} icon={<CalendarClock className="h-4 w-4" />} count={snapshot.schedules.length}>
            Timers
          </SubTabButton>
          <SubTabButton active={tab === "agents"} onClick={() => setTab("agents")} icon={<Users className="h-4 w-4" />}>
            Agents
          </SubTabButton>
          <SubTabButton active={tab === "brand"} onClick={() => setTab("brand")} icon={<Palette className="h-4 w-4" />}>
            Brand
          </SubTabButton>
        </div>
        <div className="p-4">
          {tab === "missions" && (
            <ul className="divide-y divide-slate-100">
              {snapshot.missions.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => setMissionId(m.id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-50">
                    <Bot className="h-4 w-4 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900">{m.title}</div>
                      <div className="truncate text-xs text-slate-500">
                        {m.mode === "direct" ? "Direct task" : "Directed mission"} · {relTime(m.created_at)} · {usd(Number(m.cost_usd))}
                      </div>
                    </div>
                    <MissionBadge status={m.status} />
                  </button>
                </li>
              ))}
              {!snapshot.missions.length && <li className="py-6 text-center text-sm text-slate-500">No missions yet.</li>}
            </ul>
          )}
          {tab === "timers" && (
            <SchedulesPanel schedules={snapshot.schedules} agents={snapshot.agents} clients={snapshot.clients} brandProfiles={snapshot.brandProfiles} isAdmin={snapshot.isAdmin} ready={snapshot.ready} />
          )}
          {tab === "agents" && (
            <div className="space-y-3">
              {snapshot.isAdmin && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <AgentDot color="#94a3b8" /> Pause an agent to hold its tasks; the rest of the team keeps working.
                  {snapshot.agents.some((a) => !a.enabled) && (
                    <Button size="sm" variant="outline" className="ml-auto" onClick={() => snapshot.agents.filter((a) => !a.enabled).forEach((a) => togglePause(a.key, false))}>
                      <Play className="h-3.5 w-3.5" /> Resume all
                    </Button>
                  )}
                </div>
              )}
              <AgentSettingsPanel agents={snapshot.agents} models={models} isAdmin={snapshot.isAdmin} />
            </div>
          )}
          {tab === "brand" && <BrandPanel profiles={snapshot.brandProfiles} clients={snapshot.clients} isAdmin={snapshot.isAdmin} />}
        </div>
      </div>

      <AgentDetailsModal
        robot={detailsRobot}
        agent={detailsAgent}
        events={snapshot.events}
        nowMs={clock}
        isAdmin={snapshot.isAdmin}
        onClose={() => setDetails(null)}
        onOpenMission={(id) => {
          setDetails(null);
          setMissionId(id);
        }}
        onGiveTask={giveTask}
        onPause={(key, enabled) => togglePause(key, enabled)}
      />

      <MissionDrawer
        mission={mission}
        tasks={snapshot.tasks}
        events={snapshot.events}
        carousels={snapshot.carousels}
        carouselPosts={carouselPosts}
        carouselOptions={carouselOptions}
        clients={snapshot.clients}
        agents={snapshot.agents}
        socialAccounts={snapshot.social.accounts}
        canDirect={snapshot.isAdmin}
        onClose={() => setMissionId(null)}
      />
    </div>
  );
}

function SubTabButton({ active, onClick, icon, count, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; count?: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
        active ? "border-primary-500 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800",
      )}
    >
      {icon}
      {children}
      {typeof count === "number" && count > 0 && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{count}</span>}
    </button>
  );
}
