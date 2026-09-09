"use client";

import * as React from "react";

import type { OfficeAgentView, OfficeEventRow } from "@/lib/agents/office-types";
import { cn } from "@/lib/utils";

import { AgentDot, relTime } from "./office-ui";

/** The live feed (0130): what every robot did, newest first. */
export function ActivityFeed({
  events,
  agents,
  limit = 60,
  onOpenMission,
  className,
}: {
  events: OfficeEventRow[];
  agents: OfficeAgentView[];
  limit?: number;
  onOpenMission: (missionId: string) => void;
  className?: string;
}) {
  const colour = React.useMemo(() => new Map<string, string>(agents.map((a) => [a.key, a.color])), [agents]);
  const rows = React.useMemo(() => [...events].slice(-limit).reverse(), [events, limit]);

  if (!rows.length) {
    return <p className={cn("text-sm text-slate-500", className)}>Nothing has happened yet. Brief the Director to get the office moving.</p>;
  }

  return (
    <ol className={cn("max-h-[420px] space-y-2 overflow-y-auto pr-1", className)}>
      {rows.map((e) => (
        <li key={e.id} className="flex items-start gap-2.5 text-sm">
          <AgentDot color={colour.get(e.agent_key) ?? "#94a3b8"} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className={cn("text-left text-slate-700", e.mission_id && "hover:text-slate-900 hover:underline")}
              onClick={() => e.mission_id && onOpenMission(e.mission_id)}
              disabled={!e.mission_id}
            >
              {e.message}
            </button>
            <div className="text-[11px] text-slate-400">
              {kindLabel(e.kind)} · {relTime(e.created_at)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function kindLabel(kind: OfficeEventRow["kind"]): string {
  switch (kind) {
    case "started":
      return "Started";
    case "thinking":
      return "Still thinking";
    case "search":
      return "Web search";
    case "tool":
      return "Tool";
    case "handoff":
      return "Hand-off";
    case "done":
      return "Finished";
    case "failed":
      return "Stopped";
    case "blocked":
      return "Blocked";
    case "revision":
      return "Revision";
    case "review":
      return "Review";
    case "schedule":
      return "Timer";
    default:
      return "Note";
  }
}
