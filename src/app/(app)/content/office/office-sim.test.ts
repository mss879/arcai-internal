import { describe, expect, it } from "vitest";

import type { OfficeAgentView, OfficeEventRow, OfficeTaskRow } from "@/lib/agents/office-types";
import { ROSTER, mergeRosterOverrides } from "@/lib/agents/roster";

import { seatPoint, ZONES } from "./office-layout";
import { deriveRobots, fillerBots, handoffPairs } from "./office-sim";

/**
 * Which desk a robot walks to for which state. The floor is the product's
 * face; a robot standing in the wrong room while "thinking" is the bug the
 * owner sees first.
 */

const agents: OfficeAgentView[] = mergeRosterOverrides([]);
const now = Date.parse("2026-09-09T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function task(over: Partial<OfficeTaskRow>): OfficeTaskRow {
  return {
    id: "t1",
    mission_id: "m1",
    key: "k",
    agent_key: "research",
    kind: "work",
    title: "Trends",
    instructions: "",
    depends_on: [],
    status: "running",
    phase: "thinking",
    step: "",
    input: {},
    output: null,
    attempts: 1,
    rounds: 0,
    version: 1,
    lease_until: null,
    killed: 0,
    run_after: null,
    openai_response_id: "r",
    response_started_at: iso(now - 30_000),
    pending_create_at: null,
    model: "gpt-5.6-terra",
    effort: "medium",
    model_note: null,
    usage_input: 0,
    usage_cached: 0,
    usage_output: 0,
    usage_reasoning: 0,
    tool_calls: 0,
    searches: 0,
    cost_usd: 0.12,
    revision_of: null,
    revision_round: 0,
    error: null,
    started_at: iso(now - 30_000),
    finished_at: null,
    created_at: iso(now - 60_000),
    updated_at: iso(now - 1_000),
    ...over,
  };
}

function event(over: Partial<OfficeEventRow>): OfficeEventRow {
  return { id: 1, mission_id: "m1", task_id: "t1", agent_key: "manager", kind: "note", message: "", meta: {}, created_at: iso(now - 1_000), ...over };
}

describe("deriveRobots", () => {
  it("puts every idle agent at its own desk", () => {
    const robots = deriveRobots({ agents, tasks: [], missions: [], events: [] }, now);
    expect(robots).toHaveLength(ROSTER.length);
    for (const r of robots) {
      const def = ROSTER.find((a) => a.key === r.agentKey)!;
      expect(r.zone).toBe(def.zone);
      expect(r.state).toBe("idle");
    }
  });

  it("thinks at its desk, works with tools, searches after a search event", () => {
    const thinking = deriveRobots({ agents, tasks: [task({})], missions: [], events: [] }, now).find((r) => r.agentKey === "research")!;
    expect(thinking.state).toBe("thinking");
    expect(thinking.zone).toBe("library");
    expect(thinking.elapsedMs).toBe(30_000);

    const working = deriveRobots({ agents, tasks: [task({ phase: "tools", step: "Using get_brand_profile" })], missions: [], events: [] }, now).find(
      (r) => r.agentKey === "research",
    )!;
    expect(working.state).toBe("working");
    expect(working.label).toBe("Using get_brand_profile");

    const searching = deriveRobots(
      { agents, tasks: [task({})], missions: [], events: [event({ kind: "search", agent_key: "research" })] },
      now,
    ).find((r) => r.agentKey === "research")!;
    expect(searching.state).toBe("searching");
  });

  it("sends both parties of a fresh hand-off to the meeting room, then home", () => {
    const events = [event({ kind: "handoff", agent_key: "manager", meta: { to: "planner" }, created_at: iso(now - 2_000) })];
    const robots = deriveRobots({ agents, tasks: [], missions: [], events }, now);
    const manager = robots.find((r) => r.agentKey === "manager")!;
    const planner = robots.find((r) => r.agentKey === "planner")!;
    expect(manager.zone).toBe("meetingRoom");
    expect(planner.zone).toBe("meetingRoom");
    expect(manager.seat).not.toBe(planner.seat);
    expect(planner.state).toBe("talking");
    expect(handoffPairs(events, now)).toEqual([{ from: "manager", to: "planner" }]);

    const later = deriveRobots({ agents, tasks: [], missions: [], events }, now + 10_000);
    expect(later.find((r) => r.agentKey === "planner")!.zone).toBe("strategyTable");
  });

  it("shows blocked and paused robots with a red visor, and a finished one green", () => {
    const blocked = deriveRobots({ agents, tasks: [task({ status: "blocked", step: "Daily budget reached" })], missions: [], events: [] }, now).find(
      (r) => r.agentKey === "research",
    )!;
    expect(blocked.state).toBe("blocked");
    expect(blocked.label).toBe("Daily budget reached");

    const paused = deriveRobots({ agents: agents.map((a) => (a.key === "qa" ? { ...a, enabled: false } : a)), tasks: [], missions: [], events: [] }, now).find(
      (r) => r.agentKey === "qa",
    )!;
    expect(paused.state).toBe("blocked");

    const done = deriveRobots({ agents, tasks: [], missions: [], events: [event({ kind: "done", agent_key: "writer" })] }, now).find(
      (r) => r.agentKey === "writer",
    )!;
    expect(done.state).toBe("done");
  });
});

describe("fillerBots", () => {
  it("is deterministic and stays on known seats", () => {
    const a = fillerBots(now);
    const b = fillerBots(now);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(4);
    for (const f of a) {
      expect(ZONES[f.zone]).toBeTruthy();
      expect(f.kind).toBe("filler");
      expect(seatPoint(f.zone, f.seat).c).toBeGreaterThanOrEqual(0);
    }
  });

  it("moves over time", () => {
    const zonesNow = fillerBots(now).map((f) => `${f.zone}:${f.seat}`);
    const zonesLater = fillerBots(now + 20_000).map((f) => `${f.zone}:${f.seat}`);
    expect(zonesNow).not.toEqual(zonesLater);
    // The receptionist is always at the desk.
    expect(fillerBots(now)[0].zone).toBe("reception");
    expect(fillerBots(now + 33_000)[0].zone).toBe("reception");
  });
});
