"use client";

import * as React from "react";
import { Building2, CalendarDays, History, Images, LibraryBig, Send, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import type { OfficeSnapshot } from "@/lib/agents/office-types";
import { cn } from "@/lib/utils";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import type {
  CarouselOption,
  CarouselPost,
  ContentGeneration,
  ContentReference,
} from "@/lib/types";

import { GenerateTab } from "./generate-tab";
import { CalendarTab } from "./calendar-tab";
import { ReferencesTab } from "./references-tab";
import { HistoryTab } from "./history-tab";
import { PublishingTab, type SocialPostRow } from "./publishing-tab";
import { OfficeView } from "./office/office-view";
import type { ModelChoice } from "./office/agent-settings-panel";

/**
 * The Content Office (0130) is the front door; the Calendar, the publish
 * queue and the Library (generate, references, history) stay one tab away.
 */
type Tab = "office" | "calendar" | "publishing" | "library";
type LibraryTab = "generate" | "references" | "history";
const TAB_KEYS: Tab[] = ["office", "calendar", "publishing", "library"];
const LIBRARY_KEYS: LibraryTab[] = ["generate", "references", "history"];

function resolveInitial(tab: string | undefined): { tab: Tab; library: LibraryTab } {
  if (LIBRARY_KEYS.includes(tab as LibraryTab)) return { tab: "library", library: tab as LibraryTab };
  if (TAB_KEYS.includes(tab as Tab)) return { tab: tab as Tab, library: "generate" };
  return { tab: "office", library: "generate" };
}

export function ContentView({
  references,
  generations,
  carouselPosts,
  carouselOptions,
  clients,
  socialPosts = [],
  socialDryRun = false,
  geminiReady,
  carouselReady,
  initialTab,
  initialMissionId = null,
  office,
  models,
  viewerName,
}: {
  /** T5.1 — land on this tab from a link. Legacy library tab names still work. */
  initialTab?: string;
  /** 0130 — open this mission's drawer (from a notification or the approvals list). */
  initialMissionId?: string | null;
  office: OfficeSnapshot;
  models: ModelChoice[];
  /** 0130 — the name under your avatar on the floor. */
  viewerName: string;
  references: ContentReference[];
  generations: ContentGeneration[];
  carouselPosts: CarouselPost[];
  carouselOptions: CarouselOption[];
  /** 0118 — for the client picker on a post. */
  clients: { id: string; name: string }[];
  /** 0118 — the publish queue, newest first. */
  socialPosts?: SocialPostRow[];
  socialDryRun?: boolean;
  geminiReady: boolean;
  carouselReady: boolean;
}) {
  useRealtimeSyncTables([
    "content_references",
    "content_generations",
    "carousel_posts",
    "carousel_options",
    "social_posts",
  ]);
  const queued = socialPosts.filter((p) => p.status === "scheduled" || p.status === "publishing").length;
  const initial = resolveInitial(initialMissionId ? "office" : initialTab);
  const [tab, setTab] = React.useState<Tab>(initial.tab);
  const [library, setLibrary] = React.useState<LibraryTab>(initial.library);
  const working = office.tasks.filter((t) => t.status === "running").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content Office"
        description="Brief the Director or hand one agent a task, then watch the team work. Nothing is posted until you approve it."
      />

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton active={tab === "office"} onClick={() => setTab("office")} icon={<Building2 className="h-4 w-4" />} count={working || undefined}>
          Office
        </TabButton>
        <TabButton active={tab === "calendar"} onClick={() => setTab("calendar")} icon={<CalendarDays className="h-4 w-4" />} count={carouselPosts.length}>
          Calendar
        </TabButton>
        <TabButton active={tab === "publishing"} onClick={() => setTab("publishing")} icon={<Send className="h-4 w-4" />} count={queued}>
          Publishing
        </TabButton>
        <TabButton active={tab === "library"} onClick={() => setTab("library")} icon={<LibraryBig className="h-4 w-4" />} count={references.length + generations.length}>
          Library
        </TabButton>
      </div>

      {/* The office stays mounted so a walk in progress survives a tab flip. */}
      <div className={tab === "office" ? undefined : "hidden"}>
        <OfficeView
          snapshot={office}
          models={models}
          carouselPosts={carouselPosts}
          carouselOptions={carouselOptions}
          initialMissionId={initialMissionId}
          viewerName={viewerName}
          active={tab === "office"}
        />
      </div>

      {tab === "calendar" && (
        <CalendarTab posts={carouselPosts} options={carouselOptions} clients={clients} carouselReady={carouselReady} />
      )}
      {tab === "publishing" && <PublishingTab posts={socialPosts} dryRun={socialDryRun} />}
      {tab === "library" && (
        <div className="space-y-4">
          <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            <TabButton active={library === "generate"} onClick={() => setLibrary("generate")} icon={<Sparkles className="h-4 w-4" />}>
              Generate
            </TabButton>
            <TabButton active={library === "references"} onClick={() => setLibrary("references")} icon={<Images className="h-4 w-4" />} count={references.length}>
              Reference Library
            </TabButton>
            <TabButton active={library === "history"} onClick={() => setLibrary("history")} icon={<History className="h-4 w-4" />} count={generations.length}>
              History
            </TabButton>
          </div>
          {library === "generate" && (
            <GenerateTab references={references} geminiReady={geminiReady} onManageReferences={() => setLibrary("references")} />
          )}
          {library === "references" && <ReferencesTab references={references} />}
          {library === "history" && <HistoryTab generations={generations} />}
        </div>
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
