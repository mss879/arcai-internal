"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OfficeAgentView } from "@/lib/agents/office-types";

import type { RobotView } from "./office-sim";
import { stateLabel } from "./office-sim";
import { AgentDot, elapsedLabel, usd } from "./office-ui";

const CARD_W = 272;
const CARD_H = 176;

/**
 * What you see when you walk up to a robot (0130): who it is, what it is
 * doing right now, on which model, and a button for the full story.
 *
 * Positioned in the floor's own pixels: above the robot's head when there is
 * room, below its feet when the robot stands near the top edge, and always
 * kept inside the floor horizontally — so it is never clipped.
 */
export function ProximityCard({
  robot,
  agent,
  point,
  scale,
  bounds,
  nowMs,
  onDetails,
  onOpenMission,
}: {
  robot: RobotView | null;
  agent: OfficeAgentView | null;
  /** The robot's feet in viewBox units. */
  point: { x: number; y: number } | null;
  /** Container pixels per viewBox unit. */
  scale: number;
  /** The floor container, in pixels. */
  bounds: { width: number; height: number };
  nowMs: number;
  onDetails: () => void;
  onOpenMission: (missionId: string) => void;
}) {
  const open = Boolean(robot && agent && point);
  let left = 0;
  let top = 0;
  let below = false;
  if (point) {
    const px = point.x * scale;
    const py = point.y * scale;
    const headY = py - 96 * scale;
    below = headY - CARD_H < 8;
    top = below ? py + 22 * scale : headY;
    left = Math.min(Math.max(px, CARD_W / 2 + 8), Math.max(CARD_W / 2 + 8, bounds.width - CARD_W / 2 - 8));
  }
  return (
    <AnimatePresence>
      {open && robot && agent && (
        <motion.div
          key={robot.id}
          initial={{ opacity: 0, y: below ? -8 : 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: below ? -6 : 6, scale: 0.96 }}
          transition={{ duration: 0.16 }}
          style={{ left, top, width: CARD_W, transform: `translate(-50%, ${below ? "0" : "-100%"})` }}
          className="pointer-events-auto absolute z-20 rounded-2xl border border-slate-200 bg-white/95 p-3 text-sm shadow-[var(--shadow-lift)] backdrop-blur"
          role="dialog"
          aria-label={`${agent.name}, ${agent.title}`}
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white" style={{ background: agent.color }}>
              {agent.name.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="font-semibold text-slate-900">{agent.name}</span>
                <span className="truncate text-xs text-slate-500">{agent.title}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-600">
                <AgentDot color={robot.state === "blocked" ? "#ef4444" : robot.state === "idle" ? "#94a3b8" : agent.color} />
                {stateLabel(robot.state)}
                {robot.task?.status === "running" && robot.task.started_at ? <span className="text-slate-400">· {elapsedLabel(nowMs - Date.parse(robot.task.started_at))}</span> : null}
              </div>
            </div>
          </div>
          <p className="mt-2 line-clamp-2 text-xs text-slate-700">{robot.task ? `${robot.task.title} — ${robot.label}` : robot.label}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
            <span className="font-mono">{robot.task?.model ?? agent.model}</span>
            {robot.task ? <span>{usd(robot.costUsd)}</span> : null}
            {robot.task?.searches ? <span>{robot.task.searches} searches</span> : null}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" onClick={onDetails}>
              <Info className="h-3.5 w-3.5" /> Details
            </Button>
            {robot.mission && (
              <Button size="sm" variant="outline" onClick={() => onOpenMission(robot.mission!.id)}>
                <ArrowUpRight className="h-3.5 w-3.5" /> Mission
              </Button>
            )}
            <span className="ml-auto text-[10px] text-slate-400">Enter</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
