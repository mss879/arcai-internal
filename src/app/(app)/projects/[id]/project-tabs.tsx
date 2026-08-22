"use client";

/**
 * The two halves of a project (0087).
 *
 * "Overview" is everything the page already showed — payments, commissions and
 * the client portal. "Additional expenses" is the tab where costs picked up
 * after the quote are recorded and turned into an invoice. Both panels are
 * rendered on the server and handed in as props; this component only decides
 * which one is on screen.
 */

import * as React from "react";
import { LayoutDashboard, TrendingUp } from "lucide-react";

import { cn } from "@/lib/utils";

type Tab = "overview" | "expenses";

export function ProjectTabs({
  overview,
  expenses,
  /** Shown on the tab so unbilled extras are visible without opening it. */
  expenseBadge,
}: {
  overview: React.ReactNode;
  expenses: React.ReactNode;
  expenseBadge?: string;
}) {
  const [tab, setTab] = React.useState<Tab>("overview");

  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton
          active={tab === "overview"}
          onClick={() => setTab("overview")}
          icon={<LayoutDashboard className="h-4 w-4" />}
        >
          Overview
        </TabButton>
        <TabButton
          active={tab === "expenses"}
          onClick={() => setTab("expenses")}
          icon={<TrendingUp className="h-4 w-4" />}
        >
          Additional expenses
          {expenseBadge && (
            <span
              className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                tab === "expenses"
                  ? "bg-white/20 text-white"
                  : "bg-amber-50 text-amber-700",
              )}
            >
              {expenseBadge}
            </span>
          )}
        </TabButton>
      </div>

      {/* Both panels stay mounted: flipping tabs shouldn't throw away a
       * half-filled expense form or reset the portal section. */}
      <div className={tab === "overview" ? undefined : "hidden"}>{overview}</div>
      <div className={tab === "expenses" ? undefined : "hidden"}>{expenses}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
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
    </button>
  );
}
