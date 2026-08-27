import "server-only";

/**
 * The tools that let Arcus take on an errand (0103).
 *
 * Three tools, and one conspicuous absence.
 *
 *   propose_mission  plans the work and shows the plan
 *   mission_status   reports on what is running
 *   control_mission  pauses, resumes or cancels one
 *
 * There is NO approve tool, and that is the design. A mission only starts
 * when a person taps Approve on the card, which posts to
 * `/api/assistant/missions/[id]/approve` with their own session — the same
 * wall that keeps the model away from the two send routes. The model can
 * propose any plan it likes and can never authorise one, so "give it a goal"
 * never becomes "it decided to do something".
 *
 * `propose_mission` is admin-gated in v1: background steps run on the tick's
 * service-role client, which does not re-apply the caller's RLS, so a member
 * could otherwise reach admin-only data by asking a mission to fetch it.
 */

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import type { ArtifactColumn } from "@/lib/assistant-artifacts";
import { rowsToTable, tableArtifact } from "@/lib/assistant-artifacts";
import { assistantId } from "@/lib/assistant-threads";
import { planMission } from "@/lib/assistant/missions";

export const MISSION_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "propose_mission",
      description:
        "Plan a multi-step job and show the plan for approval. Use it when the user asks for an ERRAND rather than an answer — 'chase every overdue invoice', 'get the Musa kickoff ready', 'clean up the stale leads' — anything that clearly takes several steps across the app. Do NOT use it for something one tool already does: just do that instead. The plan runs only after the user taps Approve, and any message to a client still waits for them to press Send afterwards. Tell them the plan is ready for their OK; never say the work has started.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "What they want done, in one clear sentence, in their own words. Include anything specific they named — a client, an amount, a deadline.",
          },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mission_status",
      description:
        "Show what missions are running, waiting for approval or recently finished, and how far each one got. Use for 'what are you working on', 'did that chase finish', 'what's waiting on me'.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "all"],
            description:
              "active = still running, approved or waiting for approval. Default active.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "control_mission",
      description:
        "Pause, resume or cancel a mission that is already running, found by its title. Cancelling stops it for good; anything it already prepared stays in the approvals tray for the user to deal with.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Part of the mission's title." },
          action: { type: "string", enum: ["pause", "resume", "cancel"] },
        },
        required: ["query", "action"],
        additionalProperties: false,
      },
    },
  },
];

async function proposeMission(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const goal = String(args.goal ?? "").trim();
  if (goal.length < 8) {
    return {
      content: {
        ok: false,
        error: "That goal is too thin to plan. Ask what they actually want done.",
      },
    };
  }

  // v1 gate — see the file header.
  const { data: profile } = await ctx.supabase
    .from("profiles")
    .select("role")
    .eq("id", ctx.userId)
    .maybeSingle();
  if (profile?.role !== "admin") {
    return {
      content: {
        ok: false,
        error: "Missions are admin-only for now.",
        say: "Tell them you can still do each step if they ask for it directly.",
      },
    };
  }

  const plan = await planMission(goal);
  if (!plan.ok) {
    return {
      content: {
        ok: false,
        error: plan.problem,
        ask: "Ask for the missing detail in one short question, then try again.",
      },
    };
  }

  // The mission narrates itself into its own conversation, so its trail and
  // its report live where every other conversation does.
  const threadId = assistantId("mission");
  await ctx.supabase.from("assistant_threads").insert({
    id: threadId,
    user_id: ctx.userId,
    title: plan.title,
    kind: "mission",
  });

  const { data: mission, error } = await ctx.supabase
    .from("assistant_missions")
    .insert({
      user_id: ctx.userId,
      thread_id: threadId,
      title: plan.title,
      goal,
      plan: plan.steps,
      status: "proposed",
    })
    .select("id")
    .single();
  if (error) return { content: { ok: false, error: error.message } };

  return {
    content: {
      ok: true,
      mission_id: mission.id,
      title: plan.title,
      steps: plan.steps.map((s) => `${s.n}. ${s.title}`),
      note: "The plan is on screen with an Approve button. NOTHING has started. Say what the plan does in one sentence and ask them to approve it — never say the work is underway.",
    },
    event: { kind: "created", label: `Planned: ${plan.title}` },
    card: {
      type: "mission_plan",
      mission: {
        id: mission.id,
        title: plan.title,
        goal,
        steps: plan.steps.map((s) => ({ n: s.n, title: s.title })),
      },
    },
  };
}

async function missionStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const scope = String(args.status ?? "active");
  let query = ctx.supabase
    .from("assistant_missions")
    .select("id, title, status, plan, steps_done, created_at, thread_id")
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(25);
  if (scope !== "all") {
    query = query.in("status", [
      "proposed",
      "approved",
      "running",
      "waiting_approval",
      "paused",
    ]);
  }

  const { data, error } = await query;
  if (error) return { content: { ok: false, error: error.message } };
  const rows = data ?? [];

  const { count: pending } = await ctx.supabase
    .from("assistant_approvals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ctx.userId)
    .eq("status", "pending");

  const columns: ArtifactColumn[] = [
    { key: "title", label: "Mission" },
    { key: "progress", label: "Progress" },
    { key: "state", label: "State", format: "status" },
    { key: "when", label: "Started", format: "datetime" },
  ];
  const artifact = tableArtifact({
    title: scope === "all" ? "All missions" : "Missions on the go",
    subtitle: `${rows.length} ${rows.length === 1 ? "mission" : "missions"}`,
    area: "dashboard",
    columns,
    rows: rowsToTable(rows, columns, (r) => ({
      id: r.id,
      tone:
        r.status === "failed"
          ? ("danger" as const)
          : r.status === "waiting_approval"
            ? ("warning" as const)
            : r.status === "completed"
              ? ("positive" as const)
              : ("info" as const),
      cells: {
        title: r.title,
        progress: `${r.steps_done} of ${r.plan.length} steps`,
        state: r.status.replace(/_/g, " "),
        when: r.created_at,
      },
    })),
  });

  return {
    content: {
      ok: true,
      count: rows.length,
      pending_approvals: pending ?? 0,
      missions: rows.map((r) => ({
        title: r.title,
        state: r.status,
        progress: `${r.steps_done}/${r.plan.length}`,
        current_step:
          r.plan.find((s) => s.status === "pending")?.title ?? null,
      })),
      note: (pending ?? 0)
        ? `${pending} prepared ${pending === 1 ? "message is" : "messages are"} waiting for approval — mention it.`
        : "Nothing is waiting for approval.",
    },
    event: { kind: "read", label: "Checked the missions" },
    artifacts: [artifact],
  };
}

async function controlMission(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  const action = String(args.action ?? "");
  if (!query) return { content: { ok: false, error: "Say which mission." } };

  const { data, error } = await ctx.supabase
    .from("assistant_missions")
    .select("id, title, status")
    .eq("user_id", ctx.userId)
    .ilike("title", `%${query}%`)
    .in("status", ["proposed", "approved", "running", "waiting_approval", "paused"])
    .limit(3);
  if (error) return { content: { ok: false, error: error.message } };
  const rows = data ?? [];
  if (!rows.length)
    return { content: { ok: false, error: `No live mission matches "${query}".` } };
  if (rows.length > 1)
    return {
      content: {
        ok: false,
        error: `More than one mission matches "${query}". Ask which.`,
        candidates: rows.map((r) => r.title),
      },
    };

  const mission = rows[0];
  const patch =
    action === "pause"
      ? { status: "paused" as const, due_at: null }
      : action === "resume"
        ? { status: "approved" as const, due_at: new Date().toISOString() }
        : { status: "cancelled" as const, due_at: null };

  const { error: updateError } = await ctx.supabase
    .from("assistant_missions")
    .update(patch)
    .eq("id", mission.id);
  if (updateError) return { content: { ok: false, error: updateError.message } };

  return {
    content: {
      ok: true,
      mission: mission.title,
      now: patch.status,
      note:
        action === "cancel"
          ? "Stopped for good. Anything it already prepared is still in the approvals tray — nothing was sent."
          : action === "pause"
            ? "Paused. The step in flight finishes; nothing new starts."
            : "Running again from where it left off.",
    },
    event: { kind: "updated", label: `${action}: ${mission.title}` },
  };
}

/**
 * Run one mission tool.
 *
 * Returns `null` when the name belongs to another module.
 */
export async function executeMissionTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "propose_mission":
      return proposeMission(args, ctx);
    case "mission_status":
      return missionStatus(args, ctx);
    case "control_mission":
      return controlMission(args, ctx);
    default:
      return null;
  }
}
