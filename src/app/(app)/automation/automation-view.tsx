"use client";

import * as React from "react";
import {
  Activity,
  Plug,
  Sparkles,
  Workflow,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";
import type {
  ApiKey,
  Automation,
  AutomationRun,
  AutomationStep,
  MemberLite,
  Pipeline,
  PipelineStage,
  SmsWorkflow,
  WebhookEndpoint,
} from "@/lib/types";

import { tickAutomations } from "./actions";
import { FlowsTab } from "./flows-tab";
import { RunsTab } from "./runs-tab";
import { ConnectTab } from "./connect-tab";
import { RecipesTab } from "./recipes-tab";

type Tab = "flows" | "runs" | "connect" | "recipes";

/** How often the open page advances due timers (cron covers the rest). */
const TICK_INTERVAL_MS = 30_000;

export function AutomationView({
  automations,
  steps,
  runs,
  webhooks,
  apiKeys,
  smsWorkflows,
  pipelines,
  stages,
  members,
  smsReady,
}: {
  automations: Automation[];
  steps: AutomationStep[];
  runs: AutomationRun[];
  webhooks: WebhookEndpoint[];
  apiKeys: ApiKey[];
  smsWorkflows: SmsWorkflow[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
  members: MemberLite[];
  smsReady: boolean;
}) {
  useRealtimeSync("automations");
  useRealtimeSync("automation_runs");
  const [tab, setTab] = React.useState<Tab>("flows");

  React.useEffect(() => {
    let cancelled = false;
    const tick = () => {
      // Skip ticks in background tabs — the cron route covers those.
      if (!cancelled && document.visibilityState === "visible")
        void tickAutomations().catch(() => {});
    };
    tick();
    const interval = setInterval(tick, TICK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const running = runs.filter((r) => r.status === "running").length;
  const active = automations.filter((a) => a.is_active).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Automation"
        description="Trigger → condition → action workflows that keep leads warm, chase money and run the busywork for you."
      />

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton
          active={tab === "flows"}
          onClick={() => setTab("flows")}
          icon={<Workflow className="h-4 w-4" />}
          count={active}
        >
          Workflows
        </TabButton>
        <TabButton
          active={tab === "runs"}
          onClick={() => setTab("runs")}
          icon={<Activity className="h-4 w-4" />}
          count={running}
        >
          Runs
        </TabButton>
        <TabButton
          active={tab === "recipes"}
          onClick={() => setTab("recipes")}
          icon={<Sparkles className="h-4 w-4" />}
        >
          Recipes
        </TabButton>
        <TabButton
          active={tab === "connect"}
          onClick={() => setTab("connect")}
          icon={<Plug className="h-4 w-4" />}
        >
          Connect
        </TabButton>
      </div>

      {tab === "flows" && (
        <FlowsTab
          automations={automations}
          steps={steps}
          runs={runs}
          smsWorkflows={smsWorkflows}
          pipelines={pipelines}
          stages={stages}
          members={members}
          smsReady={smsReady}
        />
      )}
      {tab === "runs" && <RunsTab runs={runs} automations={automations} />}
      {tab === "recipes" && <RecipesTab />}
      {tab === "connect" && (
        <ConnectTab
          webhooks={webhooks}
          apiKeys={apiKeys}
          automations={automations}
          pipelines={pipelines}
          stages={stages}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-primary-600 text-white shadow-sm"
          : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {icon}
      {children}
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "ml-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
