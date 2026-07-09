"use client";

import * as React from "react";
import { CalendarDays, History, Images, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
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

type Tab = "generate" | "calendar" | "references" | "history";

export function ContentView({
  references,
  generations,
  carouselPosts,
  carouselOptions,
  geminiReady,
  carouselReady,
}: {
  references: ContentReference[];
  generations: ContentGeneration[];
  carouselPosts: CarouselPost[];
  carouselOptions: CarouselOption[];
  geminiReady: boolean;
  carouselReady: boolean;
}) {
  useRealtimeSyncTables([
    "content_references",
    "content_generations",
    "carousel_posts",
    "carousel_options",
  ]);
  const [tab, setTab] = React.useState<Tab>("generate");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content Studio"
        description="Generate on-brand images with Gemini 3.1 Flash Image, guided by your saved references."
      />

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton
          active={tab === "generate"}
          onClick={() => setTab("generate")}
          icon={<Sparkles className="h-4 w-4" />}
        >
          Generate
        </TabButton>
        <TabButton
          active={tab === "calendar"}
          onClick={() => setTab("calendar")}
          icon={<CalendarDays className="h-4 w-4" />}
          count={carouselPosts.length}
        >
          Calendar
        </TabButton>
        <TabButton
          active={tab === "references"}
          onClick={() => setTab("references")}
          icon={<Images className="h-4 w-4" />}
          count={references.length}
        >
          Reference Library
        </TabButton>
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          icon={<History className="h-4 w-4" />}
          count={generations.length}
        >
          History
        </TabButton>
      </div>

      {tab === "generate" && (
        <GenerateTab
          references={references}
          geminiReady={geminiReady}
          onManageReferences={() => setTab("references")}
        />
      )}
      {tab === "calendar" && (
        <CalendarTab
          posts={carouselPosts}
          options={carouselOptions}
          carouselReady={carouselReady}
        />
      )}
      {tab === "references" && <ReferencesTab references={references} />}
      {tab === "history" && <HistoryTab generations={generations} />}
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
