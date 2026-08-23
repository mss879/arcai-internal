"use client";

/**
 * The project, in five views (0087, extended by 0090-0092).
 *
 * It used to be two — everything, and expenses. Now the work has somewhere to
 * live that isn't the money: Overview is the state of play, Plan is who and
 * what and when, Money is margin and costs, Files is every attachment, and
 * History is what has already happened.
 *
 * Every panel is rendered on the server and handed in as a prop; this
 * component only decides which one is on screen, and keeps them all mounted so
 * flipping tabs never throws away a half-filled form.
 */

import * as React from "react";
import {
  Activity,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  TrendingUp,
} from "lucide-react";

import { cn } from "@/lib/utils";

type Tab = "overview" | "plan" | "money" | "files" | "activity";

export function ProjectTabs({
  overview,
  plan,
  money,
  files,
  activity,
  /** Shown on the Money tab so unbilled extras are visible without opening it. */
  expenseBadge,
  /** Open work, shown on Plan for the same reason. */
  planBadge,
}: {
  overview: React.ReactNode;
  plan: React.ReactNode;
  money: React.ReactNode;
  files: React.ReactNode;
  activity: React.ReactNode;
  expenseBadge?: string;
  planBadge?: string;
}) {
  const [tab, setTab] = React.useState<Tab>("overview");

  return (
    <div className="space-y-6">
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="inline-flex min-w-max rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <TabButton
            active={tab === "overview"}
            onClick={() => setTab("overview")}
            icon={<LayoutDashboard className="h-4 w-4" />}
          >
            Overview
          </TabButton>
          <TabButton
            active={tab === "plan"}
            onClick={() => setTab("plan")}
            icon={<ListTodo className="h-4 w-4" />}
            badge={planBadge}
            badgeTone="sky"
            tabActive={tab === "plan"}
          >
            Plan
          </TabButton>
          <TabButton
            active={tab === "money"}
            onClick={() => setTab("money")}
            icon={<TrendingUp className="h-4 w-4" />}
            badge={expenseBadge}
            badgeTone="amber"
            tabActive={tab === "money"}
          >
            Money
          </TabButton>
          <TabButton
            active={tab === "files"}
            onClick={() => setTab("files")}
            icon={<FolderOpen className="h-4 w-4" />}
          >
            Files
          </TabButton>
          <TabButton
            active={tab === "activity"}
            onClick={() => setTab("activity")}
            icon={<Activity className="h-4 w-4" />}
          >
            History
          </TabButton>
        </div>
      </div>

      <div className={tab === "overview" ? undefined : "hidden"}>{overview}</div>
      <div className={tab === "plan" ? undefined : "hidden"}>{plan}</div>
      <div className={tab === "money" ? undefined : "hidden"}>{money}</div>
      <div className={tab === "files" ? undefined : "hidden"}>{files}</div>
      <div className={tab === "activity" ? undefined : "hidden"}>{activity}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
  badge,
  badgeTone = "amber",
  tabActive,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  badge?: string;
  badgeTone?: "amber" | "sky";
  tabActive?: boolean;
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
      {badge && (
        <span
          className={cn(
            "ml-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            tabActive
              ? "bg-white/20 text-white"
              : badgeTone === "sky"
                ? "bg-sky-50 text-sky-700"
                : "bg-amber-50 text-amber-700",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
