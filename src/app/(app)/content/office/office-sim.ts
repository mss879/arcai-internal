/**
 * From rows to robots (0130) — pure.
 *
 * Given the snapshot the page holds (agents, tasks, missions, recent events)
 * and the clock, decide for every agent WHERE it stands and WHAT it is
 * visibly doing, so the floor can animate it. Filler robots wander on a
 * fixed timetable derived from the clock, so two renders in the same second
 * agree and nothing jumps.
 */

import type { OfficeAgentKey } from "@/lib/database.types";
import type {
  OfficeAgentView,
  OfficeEventRow,
  OfficeMissionRow,
  OfficeTaskRow,
  OfficeZoneKey,
  RobotState,
} from "@/lib/agents/office-types";

/** How long a hand-off keeps both parties in the meeting room. */
export const HANDOFF_MS = 4_500;
/** How long a "searched" event keeps the visor sweeping. */
export const SEARCH_MS = 10_000;
/** How long a finished task shows the green visor before the robot sits down. */
export const DONE_MS = 5_000;
/** How long a revision keeps the checker at the writer's desk. */
export const REVISION_MS = 4_000;

export type RobotView = {
  id: string;
  kind: "agent" | "filler";
  agentKey: OfficeAgentKey | null;
  name: string;
  title: string;
  color: string;
  state: RobotState;
  zone: OfficeZoneKey;
  /** Which seat in the zone. */
  seat: number;
  /** One line under the robot / in the card. */
  label: string;
  task: OfficeTaskRow | null;
  mission: OfficeMissionRow | null;
  elapsedMs: number;
  costUsd: number;
  enabled: boolean;
};

export type SimInput = {
  agents: readonly OfficeAgentView[];
  tasks: readonly OfficeTaskRow[];
  missions: readonly OfficeMissionRow[];
  events: readonly OfficeEventRow[];
};

const ACTIVE = new Set(["running", "ready"]);

function recent(events: readonly OfficeEventRow[], nowMs: number, windowMs: number): OfficeEventRow[] {
  const since = nowMs - windowMs;
  const out: OfficeEventRow[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = Date.parse(e.created_at);
    if (Number.isNaN(t) || t < since) break;
    out.push(e);
  }
  return out;
}

/** The task an agent is on right now: running first, then ready, then blocked. */
export function currentTaskFor(agentKey: string, tasks: readonly OfficeTaskRow[]): OfficeTaskRow | null {
  const mine = tasks.filter((t) => t.agent_key === agentKey);
  return (
    mine.find((t) => t.status === "running") ??
    mine.find((t) => t.status === "ready") ??
    mine.find((t) => t.status === "blocked") ??
    null
  );
}

/** Pairs (from, to) that should be seen talking in the meeting room. */
export function handoffPairs(events: readonly OfficeEventRow[], nowMs: number): { from: string; to: string }[] {
  const pairs: { from: string; to: string }[] = [];
  for (const e of recent(events, nowMs, HANDOFF_MS)) {
    if (e.kind !== "handoff") continue;
    const to = typeof e.meta?.to === "string" ? (e.meta.to as string) : null;
    if (e.agent_key === "manager" && to) pairs.push({ from: "manager", to });
  }
  return pairs;
}

function stateFromTask(task: OfficeTaskRow, agentKey: string, events: readonly OfficeEventRow[], nowMs: number): { state: RobotState; label: string } {
  if (task.status === "blocked") return { state: "blocked", label: task.step || "Waiting for budget" };
  if (task.status === "ready") {
    return { state: "idle", label: task.run_after && task.run_after > new Date(nowMs).toISOString() ? task.step || "Retrying soon" : "Waiting to start" };
  }
  // running
  if (agentKey === "research" && recent(events, nowMs, SEARCH_MS).some((e) => e.kind === "search" && e.agent_key === agentKey)) {
    return { state: "searching", label: task.step || "Searching the web" };
  }
  switch (task.phase) {
    case "tools":
      return { state: "working", label: task.step || "Working" };
    case "rendering":
      return { state: "working", label: task.step || "Sending to the render queue" };
    case "thinking":
    default:
      return { state: "thinking", label: task.step || "Thinking…" };
  }
}

/** Every agent's robot for this instant. */
export function deriveRobots(input: SimInput, nowMs: number): RobotView[] {
  const { agents, tasks, missions, events } = input;
  const missionById = new Map(missions.map((m) => [m.id, m] as const));
  const pairs = handoffPairs(events, nowMs);
  const recentDone = recent(events, nowMs, DONE_MS).filter((e) => e.kind === "done");
  const recentRevision = recent(events, nowMs, REVISION_MS).filter((e) => e.kind === "revision");
  const meetingSeats = new Map<string, number>();
  let meetingSeatNext = 0;
  const seatIn = (key: string) => {
    if (!meetingSeats.has(key)) meetingSeats.set(key, meetingSeatNext++);
    return meetingSeats.get(key)!;
  };

  return agents.map((agent) => {
    const task = currentTaskFor(agent.key, tasks);
    const mission = task ? (missionById.get(task.mission_id) ?? null) : null;
    let state: RobotState = "idle";
    let label = agent.enabled ? "At their desk" : "Paused";
    let zone: OfficeZoneKey = agent.zone;
    let seat = agent.seat;

    if (task) {
      const s = stateFromTask(task, agent.key, events, nowMs);
      state = s.state;
      label = s.label;
    } else {
      const done = recentDone.find((e) => e.agent_key === agent.key);
      if (done) {
        state = "done";
        label = "Done";
      }
      if (agent.key === "manager") {
        const waiting = missions.find((m) => m.status === "review");
        if (waiting) label = `“${waiting.title}” is waiting for your approval`;
      }
    }

    // Conversations override position for a few seconds.
    const pair = pairs.find((p) => p.from === agent.key || p.to === agent.key);
    if (pair) {
      zone = "meetingRoom";
      seat = seatIn(agent.key);
      state = "talking";
      label = agent.key === "manager" ? "Briefing the team" : "Taking a brief";
    }
    const revision = recentRevision.find((e) => e.agent_key === "qa");
    if (revision && (agent.key === "qa" || agent.key === "writer")) {
      zone = "writingDesk";
      seat = agent.key === "qa" ? 1 : 0;
      state = "talking";
      label = agent.key === "qa" ? "Sending copy back" : "Taking the notes";
    }
    if (!agent.enabled && !task) state = "blocked";

    const elapsedMs = task?.started_at ? Math.max(0, nowMs - Date.parse(task.started_at)) : 0;
    return {
      id: `agent:${agent.key}`,
      kind: "agent",
      agentKey: agent.key,
      name: agent.name,
      title: agent.title,
      color: agent.color,
      state,
      zone,
      seat,
      label,
      task,
      mission,
      elapsedMs,
      costUsd: Number(task?.cost_usd ?? 0),
      enabled: agent.enabled,
    };
  });
}

// ---- Filler robots ---------------------------------------------------------------

type Stop = { zone: OfficeZoneKey; seat: number; dwellMs: number };

/** The receptionist never leaves the desk; the floor greets through them. */
export const RECEPTIONIST_ID = "filler:reception";

const FILLER_ROUTES: { name: string; offsetMs: number; stops: Stop[]; fixed?: boolean }[] = [
  {
    name: "Dot",
    offsetMs: 0,
    fixed: true,
    stops: [{ zone: "reception", seat: 0, dwellMs: 60_000 }],
  },
  {
    name: "Bolt",
    offsetMs: 0,
    stops: [
      { zone: "breakout", seat: 0, dwellMs: 9_000 },
      { zone: "reception", seat: 1, dwellMs: 6_000 },
      { zone: "breakout", seat: 2, dwellMs: 11_000 },
    ],
  },
  {
    name: "Widget",
    offsetMs: 4_000,
    stops: [
      { zone: "breakout", seat: 1, dwellMs: 12_000 },
      { zone: "corridor", seat: 2, dwellMs: 7_000 },
      { zone: "corridor", seat: 3, dwellMs: 8_000 },
      { zone: "breakout", seat: 3, dwellMs: 10_000 },
    ],
  },
  {
    name: "Sprocket",
    offsetMs: 9_000,
    stops: [
      { zone: "reception", seat: 2, dwellMs: 14_000 },
      { zone: "breakout", seat: 4, dwellMs: 6_000 },
      { zone: "corridor", seat: 4, dwellMs: 9_000 },
    ],
  },
  {
    name: "Gizmo",
    offsetMs: 2_500,
    stops: [
      { zone: "corridor", seat: 0, dwellMs: 8_000 },
      { zone: "corridor", seat: 5, dwellMs: 7_000 },
      { zone: "corridor", seat: 1, dwellMs: 6_000 },
      { zone: "breakout", seat: 4, dwellMs: 13_000 },
    ],
  },
  {
    name: "Pip",
    offsetMs: 6_500,
    stops: [
      { zone: "breakout", seat: 3, dwellMs: 10_000 },
      { zone: "breakout", seat: 1, dwellMs: 9_000 },
      { zone: "reception", seat: 1, dwellMs: 5_000 },
    ],
  },
];

/** A walk shows for this long at the start of every stop. */
const WALK_MS = 1_400;

/** The filler robots' positions for this instant — deterministic in `nowMs`. */
export function fillerBots(nowMs: number): RobotView[] {
  return FILLER_ROUTES.map((route, i) => {
    const total = route.stops.reduce((s, st) => s + st.dwellMs, 0);
    let t = (nowMs + route.offsetMs) % total;
    let stop = route.stops[0];
    for (const st of route.stops) {
      if (t < st.dwellMs) {
        stop = st;
        break;
      }
      t -= st.dwellMs;
    }
    return {
      id: route.fixed ? RECEPTIONIST_ID : `filler:${i}`,
      kind: "filler",
      agentKey: null,
      name: route.name,
      title: route.fixed ? "Receptionist" : "Visitor",
      color: route.fixed ? "#f97316" : "#94a3b8",
      state: !route.fixed && t < WALK_MS ? "walking" : "idle",
      zone: stop.zone,
      seat: stop.seat,
      label: "",
      task: null,
      mission: null,
      elapsedMs: 0,
      costUsd: 0,
      enabled: true,
    };
  });
}

/** Everyone on the floor. */
export function sceneFor(input: SimInput, nowMs: number, withFillers = true): RobotView[] {
  const agents = deriveRobots(input, nowMs);
  return withFillers ? [...agents, ...fillerBots(nowMs)] : agents;
}

/** A short, human line for a state. */
export function stateLabel(state: RobotState): string {
  switch (state) {
    case "idle":
      return "Idle";
    case "walking":
      return "Walking";
    case "working":
      return "Working";
    case "thinking":
      return "Thinking";
    case "searching":
      return "Searching";
    case "talking":
      return "In a hand-off";
    case "blocked":
      return "Blocked";
    case "done":
      return "Finished";
  }
}
