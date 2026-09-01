import "server-only";

/**
 * Missions — Arcus doing an errand instead of answering a question (0103).
 *
 * "Chase every overdue invoice" is not one tool call. It is: list who owes,
 * check each balance, write the invoices, prepare the emails — eight steps
 * across three areas, each depending on the last. A mission is that whole
 * errand, planned up front, approved once, then executed a step at a time
 * with a live trail and a report at the end.
 *
 * FOUR RULES HOLD THE SAFETY MODEL TOGETHER:
 *
 * 1. THE PLAN IS APPROVED BEFORE ANYTHING RUNS. `planMission` writes a
 *    `proposed` row and a card. Approval is an HTTP route with the user's
 *    own session — never a tool — so the model can propose a plan and can
 *    never authorise one.
 *
 * 2. NOTHING LEAVES THE BUILDING. The tools already refuse to send: the
 *    `prepare_*` family returns a confirm card. A mission intercepts that
 *    card and parks it in `assistant_approvals` for the tray. This module
 *    must never import `@/lib/email` or `@/lib/sms`, and the only code that
 *    sends remains the two `/api/assistant/send-*` routes, which need a
 *    browser session. A mission running on a cron cannot reach them.
 *
 * 3. EVERY TOOL CALL IS LOGGED to `assistant_run_logs`. Autonomy you cannot
 *    audit is just a machine doing things you did not see.
 *
 * 4. IT IS RESUMABLE. Steps are claimed under a lease on `due_at`; a run
 *    that dies mid-step is picked up by a later tick rather than lost, and
 *    two ticks can never drive the same mission at once.
 *
 * The same executor serves both drivers — the tick, and the user-present SSE
 * route — so a mission behaves identically whether or not anyone is watching.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { AI_MODELS, openaiChat, openaiChatJSON } from "@/lib/ai/openai";
import { APP_AREAS } from "@/lib/ai/app-map";
import {
  ALL_ASSISTANT_TOOLS,
  executeAssistantTool,
  toolLabel,
} from "@/lib/ai/tool-registry";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import type { AssistantCard } from "@/lib/assistant-cards";
import type { Artifact } from "@/lib/assistant-artifacts";
import { textArtifact } from "@/lib/assistant-artifacts";
import type { ChatMessage } from "@/lib/ai/openai";
import type {
  AssistantApprovalKind,
  Database,
  MissionStep,
} from "@/lib/database.types";
import { sendPushToUser } from "@/lib/push";

type DB = SupabaseClient<Database>;

/** Tool rounds allowed per step. A step is one small job, not a conversation. */
const MAX_ROUNDS_PER_STEP = 4;

/** How long a tick may spend draining missions before it must yield. Must
 * sit inside the ~26s platform window (with the model call's own 20s cap on
 * top of the last-started step) — a bigger number here was never real budget,
 * just a guarantee of being killed mid-step. */
const DRAIN_BUDGET_MS = 18_000;

/** Lease length: a crashed run is retried after this. */
const LEASE_MS = 3 * 60_000;

/** Missions advanced per tick. */
const MAX_MISSIONS_PER_TICK = 3;

/** Retry backoff, matching the WA agent's ladder. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MAX_ATTEMPTS = 3;

/** Longest a planner may make a mission. */
const MAX_PLAN_STEPS = 8;

const PLANNER_SYSTEM = `You turn one goal into a short plan for Arcus, an assistant that works inside a small agency's own CRM and project-management app.

You are given the exact tools Arcus has. Plan ONLY work those tools can do.

Rules:
- At most ${MAX_PLAN_STEPS} steps. Fewer is better. Each step is one concrete piece of work, phrased as an instruction to Arcus.
- Order matters: a step may rely on what earlier steps found.
- Anything that would reach a client — an email, a text message — must be phrased as "prepare … for approval", never "send". Arcus cannot send; a person approves every outgoing message afterwards.
- Never plan a step that needs information nobody has given you. If the goal is too vague to plan honestly, return an empty steps list and say why in "problem".
- Give the mission a short title (3-6 words) in the user's own language.

Reply with JSON only:
{"title":"...","steps":[{"title":"..."}],"problem":"..."}
`;

// ---- Planning ------------------------------------------------------------

export type PlanResult =
  | { ok: true; title: string; steps: MissionStep[] }
  | { ok: false; problem: string };

/**
 * Draft a plan for a goal.
 *
 * The model is given the real tool names and the real area map, so it cannot
 * plan a step the app has no way to perform — the same discipline
 * `app_capabilities` applies to what Arcus claims it can do.
 */
export async function planMission(goal: string): Promise<PlanResult> {
  const toolList = ALL_ASSISTANT_TOOLS.map(
    (t) => `${t.function.name}: ${t.function.description.slice(0, 160)}`,
  ).join("\n");
  const areas = APP_AREAS.map((a) => `${a.label} (${a.href})`).join(", ");
  const model = process.env.OPENAI_PLANNER_MODEL?.trim() || AI_MODELS.chat;

  try {
    const raw = await openaiChatJSON(
      [
        { role: "system", content: PLANNER_SYSTEM },
        {
          role: "user",
          content: `AREAS OF THE APP: ${areas}\n\nTOOLS AVAILABLE:\n${toolList}\n\nGOAL: ${goal}`,
        },
      ],
      {
        model,
        // The one place a mission is worth real thinking: a bad plan wastes
        // every step after it. But the serverless window is ~26s, so the
        // budget must fit it — a 120s "allowance" only ever meant being
        // killed mid-plan and paying for the tokens anyway.
        reasoningEffort: "high",
        temperature: 0.2,
        timeoutMs: 20_000,
      },
    );
    const parsed = JSON.parse(raw) as {
      title?: unknown;
      steps?: unknown;
      problem?: unknown;
    };
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const clean: MissionStep[] = steps
      .slice(0, MAX_PLAN_STEPS)
      .map((raw): MissionStep | null => {
        const title = String((raw as Record<string, unknown>)?.title ?? "").trim();
        // `n` is renumbered below, once the empties have been dropped.
        return title ? { n: 0, title, status: "pending" } : null;
      })
      .filter((s): s is MissionStep => s !== null)
      .map((s, i) => ({ ...s, n: i + 1 }));

    if (!clean.length) {
      return {
        ok: false,
        problem:
          String(parsed.problem ?? "").trim() ||
          "That goal is too vague to plan. Ask what they want done, specifically.",
      };
    }
    return {
      ok: true,
      title: String(parsed.title ?? "").trim().slice(0, 80) || goal.slice(0, 60),
      steps: clean,
    };
  } catch (e) {
    return {
      ok: false,
      problem: `Could not plan that: ${(e as Error).message}`.slice(0, 200),
    };
  }
}

// ---- Execution -----------------------------------------------------------

type MissionRow = Database["public"]["Tables"]["assistant_missions"]["Row"];

export type StepOutcome = {
  status: "done" | "failed" | "waiting_approval";
  note: string;
  approvals: number;
};

/**
 * Run one step of a mission.
 *
 * A bounded mini-conversation: the model is told the goal, the plan, what the
 * earlier steps found, and this step's instruction, then given the full tool
 * registry for a few rounds. Everything it does is logged; anything it
 * prepares for a client is parked as an approval instead of being dropped
 * into a stream nobody is reading.
 */
async function runStep(
  supabase: DB,
  ctx: ToolContext,
  mission: MissionRow,
  step: MissionStep,
  memories: string[],
): Promise<StepOutcome> {
  const model = process.env.OPENAI_MISSION_MODEL?.trim() || AI_MODELS.chat;
  const done = mission.plan
    .filter((s) => s.n < step.n && s.note)
    .map((s) => `Step ${s.n} (${s.title}): ${s.note}`)
    .join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        `You are Arcus, working through one step of a mission inside the ARC AI workspace. Today is ${ctx.today}. Currency is LKR.`,
        ``,
        `THE GOAL: ${mission.goal}`,
        `THE PLAN:`,
        ...mission.plan.map((s) => `  ${s.n}. ${s.title}`),
        ``,
        done ? `WHAT EARLIER STEPS FOUND:\n${done}\n` : ``,
        `YOUR STEP RIGHT NOW: ${step.title}`,
        ``,
        `Do only this step. Use the tools — never state a figure a tool did not return.`,
        `You CANNOT send anything. prepare_invoice_email and prepare_sms produce a draft that a person approves later; calling one completes your step, and you must describe it as prepared, never as sent.`,
        `When the step is done, reply with ONE short sentence saying what you found or did, in plain text. That sentence is handed to the next step, so put the facts in it — names, numbers, ids.`,
        `If the step turns out to be impossible or unnecessary, say so plainly in that sentence instead of inventing work.`,
        ...(memories.length
          ? [``, `WHAT YOU REMEMBER about how they work:`, ...memories.map((m) => `- ${m}`)]
          : []),
      ].join("\n"),
    },
    { role: "user", content: step.title },
  ];

  let approvals = 0;
  let note = "";

  for (let round = 0; round < MAX_ROUNDS_PER_STEP; round++) {
    let assistant: ChatMessage;
    try {
      assistant = await openaiChat(messages, ALL_ASSISTANT_TOOLS, {
        model,
        reasoningEffort: "low",
        timeoutMs: 20_000,
      });
    } catch (e) {
      return {
        status: "failed",
        note: `The model failed: ${(e as Error).message}`.slice(0, 300),
        approvals,
      };
    }
    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (!calls.length) {
      note = (assistant.content ?? "").trim().slice(0, 400);
      break;
    }

    for (const call of calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }

      let result: ToolResult;
      let failure: string | null = null;
      try {
        result = await executeAssistantTool(name, args, ctx);
      } catch (e) {
        failure = (e as Error).message;
        result = { content: { ok: false, error: failure } };
      }

      await supabase.from("assistant_run_logs").insert({
        mission_id: mission.id,
        tool: name,
        args,
        ok: !failure,
        result: JSON.stringify(result.content).slice(0, 2_000),
      });

      // The gate. A confirm card means the tool prepared something that
      // would leave the building; it is parked for a human, never sent here.
      if (result.card && isConfirmCard(result.card)) {
        await parkApproval(supabase, mission, result.card);
        approvals += 1;
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.content).slice(0, 6_000),
      });
    }
  }

  if (!note) {
    // Out of rounds with nothing said — ask once more, without tools, so the
    // step still hands something to the next one.
    try {
      const wrap = await openaiChat(messages, undefined, {
        model,
        reasoningEffort: "low",
        timeoutMs: 15_000,
      });
      note = (wrap.content ?? "").trim().slice(0, 400);
    } catch {
      note = "Step ran but produced no summary.";
    }
  }

  return {
    status: approvals > 0 ? "waiting_approval" : "done",
    note: note || "Done.",
    approvals,
  };
}

function isConfirmCard(card: AssistantCard): boolean {
  return card.type === "confirm_send" || card.type === "confirm_send_sms";
}

/** Persist a prepared send for the approvals tray. */
async function parkApproval(
  supabase: DB,
  mission: MissionRow,
  card: AssistantCard,
): Promise<void> {
  const kind: AssistantApprovalKind =
    card.type === "confirm_send_sms" ? "sms" : "invoice_email";
  await supabase.from("assistant_approvals").insert({
    user_id: mission.user_id,
    mission_id: mission.id,
    thread_id: mission.thread_id,
    kind,
    card: card as unknown as Record<string, unknown>,
  });
}

// ---- The tick driver -----------------------------------------------------

/**
 * Advance every mission that is due.
 *
 * Claims each by pushing `due_at` forward under a lease, so a crash retries
 * rather than losing the mission, and a second tick skips what this one holds.
 */
export async function processAssistantMissions(
  supabase: DB,
): Promise<{ advanced: number; completed: number }> {
  const startedAt = Date.now();
  try {
    const { data: due } = await supabase
      .from("assistant_missions")
      .select("*")
      .in("status", ["approved", "running"])
      .not("due_at", "is", null)
      .lte("due_at", new Date().toISOString())
      .order("due_at", { ascending: true })
      .limit(MAX_MISSIONS_PER_TICK);
    if (!due?.length) return { advanced: 0, completed: 0 };

    let advanced = 0;
    let completed = 0;

    for (const mission of due) {
      if (Date.now() - startedAt > DRAIN_BUDGET_MS) break;

      // Claim: push the lease forward, but only if nobody else already did.
      const lease = new Date(Date.now() + LEASE_MS).toISOString();
      const { data: claimed } = await supabase
        .from("assistant_missions")
        .update({ due_at: lease, status: "running" })
        .eq("id", mission.id)
        .eq("due_at", mission.due_at as string)
        .select("id");
      if (!claimed?.length) continue;

      const finished = await advanceMission(supabase, mission);
      advanced += 1;
      if (finished) completed += 1;
    }

    return { advanced, completed };
  } catch {
    return { advanced: 0, completed: 0 };
  }
}

/** Run the next pending step of one mission. Returns true when it finished. */
async function advanceMission(supabase: DB, mission: MissionRow): Promise<boolean> {
  const step = mission.plan.find((s) => s.status === "pending");
  if (!step) {
    await finishMission(supabase, mission, "completed");
    return true;
  }

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
  }).format(new Date());
  // Background steps run on the tick's service-role client but stay attributed
  // to the mission's owner, so anything created is theirs, not the system's.
  const ctx: ToolContext = { supabase, userId: mission.user_id, today };

  const { data: memoryRows } = await supabase
    .from("assistant_memories")
    .select("content")
    .eq("user_id", mission.user_id)
    .eq("status", "active")
    .limit(20);
  const memories = (memoryRows ?? []).map((m) => m.content);

  let outcome: StepOutcome;
  try {
    outcome = await runStep(supabase, ctx, mission, step, memories);
  } catch (e) {
    outcome = {
      status: "failed",
      note: (e as Error).message.slice(0, 300),
      approvals: 0,
    };
  }

  const plan = mission.plan.map((s) =>
    s.n === step.n
      ? {
          ...s,
          status: outcome.status === "failed" ? ("failed" as const) : ("done" as const),
          note: outcome.note,
        }
      : s,
  );

  if (outcome.status === "failed") {
    const attempts = mission.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await supabase
        .from("assistant_missions")
        .update({ plan, attempts, status: "failed", due_at: null, error: outcome.note })
        .eq("id", mission.id);
      await notify(
        supabase,
        mission,
        `Mission stopped: ${mission.title}`,
        outcome.note,
      );
      return true;
    }
    // Retry the SAME step after a backoff — the plan entry stays pending.
    await supabase
      .from("assistant_missions")
      .update({
        attempts,
        due_at: new Date(
          Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)],
        ).toISOString(),
      })
      .eq("id", mission.id);
    return false;
  }

  const stepsDone = plan.filter((s) => s.status === "done").length;
  const remaining = plan.some((s) => s.status === "pending");

  await appendProgress(supabase, mission, step, outcome);

  if (!remaining) {
    await supabase
      .from("assistant_missions")
      .update({ plan, steps_done: stepsDone, attempts: 0 })
      .eq("id", mission.id);
    await finishMission(supabase, { ...mission, plan }, "completed");
    return true;
  }

  await supabase
    .from("assistant_missions")
    .update({
      plan,
      steps_done: stepsDone,
      attempts: 0,
      // Next step on the next tick — a fresh invocation with a fresh budget.
      due_at: new Date(Date.now() + 2_000).toISOString(),
      status: "running",
    })
    .eq("id", mission.id);
  return false;
}

/** Write one step's result into the mission's own conversation. */
async function appendProgress(
  supabase: DB,
  mission: MissionRow,
  step: MissionStep,
  outcome: StepOutcome,
): Promise<void> {
  if (!mission.thread_id) return;
  const at = Date.now();
  await supabase.from("assistant_messages").insert({
    id: `${mission.id}-step-${step.n}`,
    thread_id: mission.thread_id,
    user_id: mission.user_id,
    role: "assistant",
    content: `**${step.n}. ${step.title}** — ${outcome.note}`,
    at,
    payload: {
      steps: [
        {
          id: `${mission.id}-${step.n}`,
          name: "mission_step",
          label: toolLabel("mission_step"),
          state: "done",
        },
      ],
    },
  });
  await supabase
    .from("assistant_threads")
    .update({ updated_at: new Date(at).toISOString() })
    .eq("id", mission.thread_id);
}

/** Close the mission out with a report the user can read at a glance. */
async function finishMission(
  supabase: DB,
  mission: MissionRow,
  status: "completed" | "failed",
): Promise<void> {
  const { count: pendingApprovals } = await supabase
    .from("assistant_approvals")
    .select("id", { count: "exact", head: true })
    .eq("mission_id", mission.id)
    .eq("status", "pending");

  const lines = mission.plan.map(
    (s) => `**${s.n}. ${s.title}**\n${s.note ?? "—"}`,
  );
  const waiting = pendingApprovals ?? 0;
  const body = [
    `## ${mission.title}`,
    ``,
    ...lines,
    ``,
    waiting
      ? `**${waiting} ${waiting === 1 ? "message is" : "messages are"} waiting for your OK.** Nothing has been sent.`
      : `Nothing was sent — this mission produced no outgoing messages.`,
  ].join("\n\n");

  const report: Artifact = textArtifact({
    title: `${mission.title} — report`,
    subtitle: status === "completed" ? "Mission complete" : "Mission stopped",
    area: "dashboard",
    body,
  });

  await supabase
    .from("assistant_missions")
    .update({
      status: waiting > 0 && status === "completed" ? "waiting_approval" : status,
      due_at: null,
      result: { report: body, pending_approvals: waiting },
    })
    .eq("id", mission.id);

  if (mission.thread_id) {
    const at = Date.now();
    await supabase.from("assistant_messages").insert({
      id: `${mission.id}-report`,
      thread_id: mission.thread_id,
      user_id: mission.user_id,
      role: "assistant",
      content:
        status === "completed"
          ? waiting
            ? `Done — ${waiting} ${waiting === 1 ? "message needs" : "messages need"} your approval before anything goes out.`
            : `Done.`
          : `I had to stop: ${mission.error ?? "something went wrong"}.`,
      at,
      payload: { artifacts: [report] },
    });
    await supabase
      .from("assistant_threads")
      .update({ updated_at: new Date(at).toISOString() })
      .eq("id", mission.thread_id);
  }

  await notify(
    supabase,
    mission,
    status === "completed" ? `Done: ${mission.title}` : `Stopped: ${mission.title}`,
    waiting
      ? `${waiting} ${waiting === 1 ? "message is" : "messages are"} waiting for your OK.`
      : null,
  );
}

async function notify(
  supabase: DB,
  mission: MissionRow,
  title: string,
  body: string | null,
): Promise<void> {
  const link = mission.thread_id
    ? `/dashboard?arc=thread:${mission.thread_id}`
    : "/dashboard";
  await supabase.from("notifications").insert({
    user_id: mission.user_id,
    type: "assistant",
    title,
    body,
    link,
  });
  await sendPushToUser({ userId: mission.user_id, title, body, link });
}
