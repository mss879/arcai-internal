"use client";

import * as React from "react";
import { ArrowUpRight, Pause, Play, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { OfficeAgentView, OfficeEventRow } from "@/lib/agents/office-types";

import type { RobotView } from "./office-sim";
import { stateLabel } from "./office-sim";
import { AgentDot, elapsedLabel, relTime, usd } from "./office-ui";

/**
 * Everything about one robot (0130): who it is, which model it is on right
 * now and why, what task, which step, the tools and searches it has used,
 * what it has cost, how long it has been at it, and what it did recently.
 */
export function AgentDetailsModal({
  robot,
  agent,
  events,
  nowMs,
  isAdmin,
  onClose,
  onOpenMission,
  onGiveTask,
  onPause,
}: {
  robot: RobotView | null;
  agent: OfficeAgentView | null;
  events: OfficeEventRow[];
  nowMs: number;
  isAdmin: boolean;
  onClose: () => void;
  onOpenMission: (missionId: string) => void;
  onGiveTask: (agentKey: string) => void;
  onPause: (agentKey: string, currentlyEnabled: boolean) => void;
}) {
  const recent = React.useMemo(() => {
    if (!robot?.agentKey) return [];
    return events.filter((e) => e.agent_key === robot.agentKey).slice(-8).reverse();
  }, [events, robot]);

  const open = Boolean(robot && agent);
  return (
    <Modal open={open} onClose={onClose} size="md">
      {robot && agent && (
        <div className="-mx-6 -my-5 text-sm">
          <div className="flex items-start gap-3 border-b border-slate-100 px-6 py-4" style={{ background: `linear-gradient(135deg, ${agent.color}18, transparent)` }}>
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-sm font-bold text-white" style={{ background: agent.color }}>
              {agent.name.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-lg font-semibold text-slate-900">{agent.name}</span>
                <span className="text-sm text-slate-500">{agent.title}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 font-medium text-slate-700 ring-1 ring-slate-200">
                  <AgentDot color={robot.state === "blocked" ? "#ef4444" : robot.state === "idle" ? "#94a3b8" : agent.color} />
                  {stateLabel(robot.state)}
                </span>
                {robot.task?.started_at && robot.task.status === "running" && (
                  <span className="text-slate-500">for {elapsedLabel(nowMs - Date.parse(robot.task.started_at))}</span>
                )}
                {!agent.enabled && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700 ring-1 ring-amber-200">paused</span>}
              </div>
              <p className="mt-1.5 text-xs text-slate-600">{agent.description}</p>
            </div>
          </div>

          <div className="space-y-4 px-6 py-4">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Model right now</div>
                <div className="truncate font-mono text-slate-800" title={robot.task?.model ?? agent.model}>
                  {robot.task?.model ?? agent.model}
                </div>
                <div className="text-slate-500">effort {robot.task?.effort ?? agent.effort}</div>
                {agent.chain.length > 1 && <div className="mt-1 text-slate-400">falls back to {agent.chain.slice(1).join(" → ")}</div>}
                {robot.task?.model_note && <div className="mt-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{robot.task.model_note}</div>}
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">This task</div>
                <div className="font-semibold text-slate-800">{usd(robot.costUsd)}</div>
                {robot.task ? (
                  <div className="text-slate-500">
                    {(robot.task.usage_input + robot.task.usage_output).toLocaleString()} tokens
                    {robot.task.usage_reasoning ? ` · ${robot.task.usage_reasoning.toLocaleString()} reasoning` : ""}
                    <br />
                    {robot.task.tool_calls} tool call{robot.task.tool_calls === 1 ? "" : "s"} · {robot.task.searches} search{robot.task.searches === 1 ? "" : "es"}
                  </div>
                ) : (
                  <div className="text-slate-500">Nothing running</div>
                )}
              </div>
            </div>

            {robot.task ? (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Working on</div>
                <div className="font-medium text-slate-900">{robot.task.title}</div>
                {robot.mission && <div className="text-xs text-slate-500">Mission: {robot.mission.title}</div>}
                <div className="mt-1 text-xs text-slate-700">{robot.label}</div>
                {robot.task.instructions && <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-xs text-slate-500">{robot.task.instructions}</p>}
                {robot.task.error && <div className="mt-1 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{robot.task.error}</div>}
              </div>
            ) : (
              <p className="text-xs text-slate-500">{robot.label}.</p>
            )}

            {agent.tools.length > 0 && (
              <div className="text-xs text-slate-500">
                <span className="text-[10px] uppercase tracking-wide text-slate-400">Can use </span>
                {[...(agent.webSearch ? ["web_search"] : []), ...agent.tools].join(" · ")}
              </div>
            )}

            {recent.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Recently</div>
                <ul className="mt-1 space-y-1">
                  {recent.map((e) => (
                    <li key={e.id} className="flex items-start gap-2 text-xs text-slate-600">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                      <span className="min-w-0 flex-1">
                        {e.message}
                        <span className="ml-1 text-slate-400">{relTime(e.created_at)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-6 py-3">
            {robot.mission && (
              <Button size="sm" variant="outline" onClick={() => onOpenMission(robot.mission!.id)}>
                <ArrowUpRight className="h-3.5 w-3.5" /> Open mission
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" variant="secondary" onClick={() => onGiveTask(agent.key)}>
                <Send className="h-3.5 w-3.5" /> Give a task
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onPause(agent.key, agent.enabled)}>
                {agent.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {agent.enabled ? "Pause" : "Resume"}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
