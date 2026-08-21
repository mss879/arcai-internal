"use client";

import * as React from "react";
import {
  Activity,
  KanbanSquare,
  Paperclip,
  Settings2,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";
import type {
  DeliveryEvent,
  DeliverySettings,
  ProjectDocumentRequest,
} from "@/lib/types";

import { ActivityTab } from "./activity-tab";
import { AssetsTab } from "./assets-tab";
import { AutomationsTab } from "./automations-tab";
import { BoardTab } from "./board-tab";
import { SettingsTab } from "./settings-tab";
import type { DeliveryProject, WaMediaRow } from "./types";

type Tab = "board" | "assets" | "automations" | "settings" | "activity";

export function DeliveryView({
  projects,
  requests,
  settings,
  events,
  automations,
  waMedia,
}: {
  projects: DeliveryProject[];
  requests: ProjectDocumentRequest[];
  settings: DeliverySettings | null;
  events: DeliveryEvent[];
  automations: { id: string; name: string; is_active: boolean }[];
  waMedia: WaMediaRow[];
}) {
  const [tab, setTab] = React.useState<Tab>("board");
  useRealtimeSyncTables([
    "projects",
    "project_document_requests",
    "delivery_events",
  ]);

  const inDelivery = projects.filter(
    (p) => p.delivery_stage && !["delivered", "aftercare"].includes(p.delivery_stage),
  ).length;
  const pendingAssets = requests.filter(
    (r) => r.status === "pending" && r.required,
  ).length;
  const filedIds = new Set(
    requests.map((r) => r.wa_message_id).filter(Boolean) as string[],
  );
  const unfiledMedia = waMedia.filter(
    (m) =>
      !filedIds.has(m.id) &&
      ((m.meta as { image_url?: string; document_url?: string })?.image_url ||
        (m.meta as { image_url?: string; document_url?: string })?.document_url),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Client Delivery"
        description="Payment to delivered, hands-free — the WhatsApp agent collects assets, the chaser keeps clients moving, milestones announce themselves."
      />

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton
          active={tab === "board"}
          onClick={() => setTab("board")}
          icon={<KanbanSquare className="h-4 w-4" />}
          count={inDelivery}
        >
          Board
        </TabButton>
        <TabButton
          active={tab === "assets"}
          onClick={() => setTab("assets")}
          icon={<Paperclip className="h-4 w-4" />}
          count={pendingAssets}
        >
          Assets
        </TabButton>
        <TabButton
          active={tab === "automations"}
          onClick={() => setTab("automations")}
          icon={<Sparkles className="h-4 w-4" />}
        >
          Automations
        </TabButton>
        <TabButton
          active={tab === "settings"}
          onClick={() => setTab("settings")}
          icon={<Settings2 className="h-4 w-4" />}
        >
          Settings
        </TabButton>
        <TabButton
          active={tab === "activity"}
          onClick={() => setTab("activity")}
          icon={<Activity className="h-4 w-4" />}
        >
          Activity
        </TabButton>
      </div>

      {tab === "board" && (
        <BoardTab projects={projects} requests={requests} settings={settings} />
      )}
      {tab === "assets" && (
        <AssetsTab
          projects={projects}
          requests={requests}
          unfiledMedia={unfiledMedia}
        />
      )}
      {tab === "automations" && <AutomationsTab automations={automations} />}
      {tab === "settings" && <SettingsTab settings={settings} />}
      {tab === "activity" && <ActivityTab events={events} projects={projects} />}
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
