import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { OpenAIRateLimitError, OpenAIRequestError } from "@/lib/ai/openai";
import {
  openaiResponsesCancel,
  openaiResponsesCreate,
  openaiResponsesRetrieve,
  type JsonSchemaFormat,
  type ResponseInputItem,
  type ResponsesTool,
} from "@/lib/ai/responses";
import {
  isPreviousResponseError,
  isToolTypeError,
  isUnknownModelError,
  safeJsonParse,
  toChatUsage,
  type RetrievedResponse,
} from "@/lib/ai/responses-core";
import { recordUsage } from "@/lib/ai-projects/usage";
import { colomboDay } from "@/lib/ai-projects/time-core";
import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";

import { emitOfficeEvent } from "./events";
import { onMissionBlocked, onTaskDone, onTaskFailed, refreshMissionCost } from "./manager";
import {
  DEFAULT_DAILY_CAP_USD,
  DEFAULT_WEB_SEARCH_USD,
  MAX_KILLED_STEPS,
  MAX_TASK_WALL_MS,
  MAX_TOOL_CALLS_PER_ROUND,
  MAX_TOOL_ROUNDS,
  OUTPUT_SCHEMAS,
  defaultDeliverableFor,
  leaseIsFree,
  leaseUntil,
  nextBackoffMs,
  overBudget,
  pickModel,
  readyTaskIds,
  shouldGiveUp,
  validateOutput,
  type OfficeOutputKind,
} from "./office-core";
import type { OfficeAgentView, OfficeMissionRow, OfficeTaskRow } from "./office-types";
import { composeAgentInstructions, openingUserMessage, type PromptContext } from "./prompts";
import { agentByKey, mergeRosterOverrides } from "./roster";
import { processOfficeSchedules } from "./schedules";
import { brandProfileText, executeOfficeTool, toolSchemasFor } from "./tools";

type DB = SupabaseClient<Database>;

/**
 * The stepper (0130): advance one office task by one bounded step.
 *
 * A step is one of exactly three things, none of which waits for a model:
 *   START    compose the prompt, create a background response, PERSIST ITS ID;
 *   POLL     read the response; if it is still running, let go;
 *   ADVANCE  it finished — meter it, run its tool calls and create the next
 *            response, or validate its final answer and mark the task done.
 *
 * The order inside START is the whole cost-safety story: the response id is
 * written before anything else can go wrong, so a step the platform kills
 * polls the same paid response next time instead of buying another. Two
 * counters keep the rest honest — `attempts` counts paid starts (cap 3, with
 * backoff), `killed` counts leased steps that never returned (cap 3) — and a
 * poll bumps neither. The September 2026 bill was every one of these rules
 * missing at once.
 */

export type StepResult = "skipped" | "busy" | "started" | "polled" | "advanced" | "done" | "failed" | "blocked";

export type StepOptions = {
  /** Epoch ms after which no new network call may start. */
  deadline: number;
  roster?: OfficeAgentView[];
  dailyCapUsd?: number;
};

const HEARTBEAT_MS = 60_000;
const MIN_CREATE_MS = 2_500;
const TRANSCRIPT_MAX_ITEMS = 80;

const WEB_SEARCH_USD = Number(process.env.OPENAI_WEB_SEARCH_PER_CALL_USD) || DEFAULT_WEB_SEARCH_USD;

const OUTPUT_KINDS = new Set<string>(Object.keys(OUTPUT_SCHEMAS));

function outputKindFor(task: OfficeTaskRow, agentKey: OfficeAgentView["key"]): OfficeOutputKind {
  const raw = task.input?.deliverable;
  return typeof raw === "string" && OUTPUT_KINDS.has(raw) ? (raw as OfficeOutputKind) : defaultDeliverableFor(agentKey);
}

function textFormatFor(kind: OfficeOutputKind): JsonSchemaFormat {
  const { name, schema } = OUTPUT_SCHEMAS[kind];
  return { type: "json_schema", name, schema, strict: true };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The roster as configured right now. */
export async function loadRoster(db: DB): Promise<OfficeAgentView[]> {
  try {
    const { data } = await db.from("office_agents").select("*");
    return mergeRosterOverrides(data ?? [], process.env);
  } catch {
    return mergeRosterOverrides([], process.env);
  }
}

/** Today's agent spend from the ledger (Colombo day). */
export async function dailyOfficeSpend(db: DB, day = colomboDay()): Promise<number> {
  try {
    const { data } = await db.from("ai_usage_events").select("cost_usd").eq("purpose", "agent").eq("day", day);
    return Math.round((data ?? []).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) * 1e6) / 1e6;
  } catch {
    return 0;
  }
}

/** This month's agent spend. */
export async function monthlyOfficeSpend(db: DB, day = colomboDay()): Promise<number> {
  try {
    const { data } = await db
      .from("ai_usage_events")
      .select("cost_usd")
      .eq("purpose", "agent")
      .eq("period", `${day.slice(0, 7)}-01`);
    return Math.round((data ?? []).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) * 1e6) / 1e6;
  } catch {
    return 0;
  }
}

export type OfficeSettings = { dailyCapUsd: number };

/** `app_settings.content_office`, with env and code defaults behind it. */
export async function loadOfficeSettings(db: DB): Promise<OfficeSettings> {
  const envCap = Number(process.env.OFFICE_DAILY_BUDGET_USD);
  let dailyCapUsd = Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_DAILY_CAP_USD;
  try {
    const { data } = await db.from("app_settings").select("value").eq("key", "content_office").maybeSingle();
    const v = (data?.value ?? {}) as Record<string, unknown>;
    const cap = Number(v.daily_cap_usd);
    if (Number.isFinite(cap) && cap >= 0) dailyCapUsd = cap;
  } catch {
    // no row yet
  }
  return { dailyCapUsd };
}

type Ctx = {
  db: DB;
  task: OfficeTaskRow;
  mission: OfficeMissionRow;
  agent: OfficeAgentView;
  kind: OfficeOutputKind;
  allowedTools: string[];
  tools: ResponsesTool[];
  deadline: number;
  version: number;
};

async function patch(db: DB, taskId: string, fields: Database["public"]["Tables"]["office_tasks"]["Update"]): Promise<void> {
  await db.from("office_tasks").update(fields).eq("id", taskId);
}

/** Give the lease back and clear the kill counter: the step returned normally. */
async function release(ctx: Ctx, extra: Database["public"]["Tables"]["office_tasks"]["Update"] = {}): Promise<void> {
  await ctx.db.from("office_tasks").update({ ...extra, lease_until: null, killed: 0 }).eq("id", ctx.task.id);
}

async function appendTranscript(
  db: DB,
  taskId: string,
  items: unknown[],
  response: Record<string, unknown> | null,
): Promise<void> {
  try {
    const { data } = await db.from("office_task_transcripts").select("items, responses").eq("task_id", taskId).maybeSingle();
    const prevItems = Array.isArray(data?.items) ? data!.items : [];
    const prevResponses = Array.isArray(data?.responses) ? data!.responses : [];
    const nextItems = [...prevItems, ...items].slice(-TRANSCRIPT_MAX_ITEMS);
    const nextResponses = response ? [...prevResponses, response].slice(-40) : prevResponses;
    await db.from("office_task_transcripts").upsert({ task_id: taskId, items: nextItems, responses: nextResponses });
  } catch {
    // The transcript is a record, not the work.
  }
}

async function settleFailed(ctx: Ctx, error: string): Promise<"failed"> {
  const message = clip(error, 500);
  await ctx.db
    .from("office_tasks")
    .update({ status: "failed", error: message, phase: "", step: "Stopped", lease_until: null, finished_at: new Date().toISOString() })
    .eq("id", ctx.task.id);
  await emitOfficeEvent(ctx.db, {
    missionId: ctx.mission.id,
    taskId: ctx.task.id,
    agentKey: ctx.agent.key,
    kind: "failed",
    message: `${ctx.agent.name} could not finish “${ctx.task.title}”: ${clip(message, 140)}`,
  });
  await refreshMissionCost(ctx.db, ctx.mission.id);
  await onTaskFailed(ctx.db, { ...ctx.task, status: "failed", error: message }, message);
  return "failed";
}

function webSearchTool(agent: OfficeAgentView, task: OfficeTaskRow): ResponsesTool | null {
  if (!agent.webSearch) return null;
  const def = agentByKey(agent.key);
  const preview = task.input?.web_search_preview === true || process.env.OPENAI_WEB_SEARCH_TOOL === "web_search_preview";
  return {
    type: preview ? "web_search_preview" : "web_search",
    search_context_size: def?.webSearch?.contextSize ?? "medium",
    user_location: { type: "approximate", country: "LK", city: "Colombo", timezone: "Asia/Colombo" },
  };
}

/** Outputs of the tasks this one depends on, labelled for the fence. */
async function loadReferences(db: DB, task: OfficeTaskRow): Promise<{ label: string; text: string }[]> {
  const refs: { label: string; text: string }[] = [];
  if (task.depends_on.length) {
    const { data } = await db
      .from("office_tasks")
      .select("id, agent_key, title, output, key")
      .in("id", task.depends_on)
      .order("created_at");
    for (const dep of data ?? []) {
      if (!dep.output) continue;
      const name = agentByKey(dep.agent_key)?.name ?? dep.agent_key;
      refs.push({ label: `${name} — ${dep.title}`, text: clip(JSON.stringify(dep.output, null, 1), 14_000) });
    }
  }
  if (task.kind === "review") {
    // The Director reads everything the mission produced.
    const { data } = await db
      .from("office_tasks")
      .select("agent_key, title, output, status, kind")
      .eq("mission_id", task.mission_id)
      .neq("kind", "review")
      .neq("kind", "plan")
      .order("created_at");
    for (const t of data ?? []) {
      if (!t.output || t.status !== "done") continue;
      const name = agentByKey(t.agent_key)?.name ?? t.agent_key;
      refs.push({ label: `${name} — ${t.title}`, text: clip(JSON.stringify(t.output, null, 1), 8_000) });
    }
  }
  const prev = task.input?.previous_output;
  if (prev) refs.push({ label: "Your previous version (to revise)", text: clip(JSON.stringify(prev, null, 1), 8_000) });
  return refs;
}

async function buildPrompt(ctx: Ctx): Promise<{ instructions: string; items: ResponseInputItem[] }> {
  const def = agentByKey(ctx.agent.key)!;
  const roster = ctx.agent.key === "manager" ? await loadRoster(ctx.db) : undefined;
  const brand = await brandProfileText(ctx.db, ctx.mission.brand_profile_id);
  const references = await loadReferences(ctx.db, ctx.task);
  const revision = ctx.task.input?.revision_notes;
  const pctx: PromptContext = {
    instructions: ctx.task.instructions,
    goal: ctx.mission.goal,
    options: ctx.mission.options ?? {},
    today: colomboDay(),
    brand,
    references,
    revisionNotes: typeof revision === "string" && revision ? revision : null,
    tools: ctx.allowedTools,
    webSearch: ctx.agent.webSearch,
    extraInstructions: ctx.agent.instructions,
    roster,
  };
  return {
    instructions: composeAgentInstructions(def, ctx.kind, pctx),
    items: [{ role: "user", content: openingUserMessage(def, ctx.kind) }],
  };
}

function createTimeout(deadline: number): number {
  return Math.max(MIN_CREATE_MS, Math.min(10_000, deadline - Date.now() - 300));
}

// ---- START -------------------------------------------------------------------

async function start(ctx: Ctx, capUsd: number): Promise<StepResult> {
  const { db, task, mission, agent } = ctx;
  if (Date.now() + MIN_CREATE_MS > ctx.deadline) {
    await release(ctx);
    return "busy";
  }

  // The daily cap gates PAID work only: a start, never a poll.
  const spent = await dailyOfficeSpend(db);
  if (overBudget(spent, capUsd)) {
    await release(ctx, { status: "blocked", step: `Daily budget reached ($${spent.toFixed(2)} of $${capUsd.toFixed(2)})` });
    await onMissionBlocked(db, mission.id, `Daily AI budget reached ($${spent.toFixed(2)} of $${capUsd.toFixed(2)}). Raise it in Content Office settings or wait for tomorrow.`);
    await emitOfficeEvent(db, {
      missionId: mission.id,
      taskId: task.id,
      agentKey: agent.key,
      kind: "blocked",
      message: `${agent.name} is waiting: today's AI budget is used up`,
      meta: { spent, cap: capUsd },
    });
    return "blocked";
  }

  const model = pickModel(agent.chain, task.attempts);
  const effort = agent.effort;
  const { instructions, items } = await buildPrompt(ctx);
  const nowIso = new Date().toISOString();
  const attempts = task.attempts + 1;

  // "About to buy" — written before the call so a kill mid-create still counts.
  await patch(db, task.id, { attempts, pending_create_at: nowIso, model, effort, step: `Starting on ${model}…` });

  let created: { id: string };
  try {
    created = await openaiResponsesCreate({
      model,
      instructions,
      input: items,
      tools: ctx.tools.length ? ctx.tools : undefined,
      reasoningEffort: effort,
      textFormat: textFormatFor(ctx.kind),
      maxOutputTokens: task.input?.bumped_tokens === true ? (agentByKey(agent.key)?.maxOutputTokens ?? 4_000) * 2 : agentByKey(agent.key)?.maxOutputTokens,
      metadata: { mission: mission.id, task: task.id, agent: agent.key },
      timeoutMs: createTimeout(ctx.deadline),
    });
  } catch (e) {
    return await startFailed(ctx, e, model, attempts);
  }

  // PERSIST FIRST. Everything after this line is optional bookkeeping.
  await db
    .from("office_tasks")
    .update({
      openai_response_id: created.id,
      response_started_at: nowIso,
      status: "running",
      phase: "thinking",
      step: agent.key === "manager" && ctx.kind === "plan" ? "Planning the brief…" : "Thinking…",
      started_at: task.started_at ?? nowIso,
      pending_create_at: null,
      lease_until: null,
      killed: 0,
      model,
      effort,
      error: null,
    })
    .eq("id", task.id);

  await appendTranscript(db, task.id, [{ kind: "instructions", model, at: nowIso, text: clip(instructions, 12_000) }, ...items], {
    id: created.id,
    model,
    at: nowIso,
    kind: "start",
  });
  await emitOfficeEvent(db, {
    missionId: mission.id,
    taskId: task.id,
    agentKey: agent.key,
    kind: "started",
    message: `${agent.name} started: ${task.title}`,
    meta: { model, effort, attempt: attempts },
  });
  return "started";
}

async function startFailed(ctx: Ctx, e: unknown, model: string, attempts: number): Promise<StepResult> {
  const { db, task, mission, agent } = ctx;
  const message = (e as Error)?.message ?? String(e);

  if (e instanceof OpenAIRateLimitError) {
    // Not a paid start: give the attempt back and wait the server's window.
    const wait = Math.min(15 * 60_000, Math.max(30_000, e.retryAfterMs ?? nextBackoffMs(attempts)));
    await release(ctx, { attempts: task.attempts, pending_create_at: null, run_after: new Date(Date.now() + wait).toISOString(), step: "Rate limited — waiting" });
    return "busy";
  }

  if (e instanceof OpenAIRequestError) {
    if (isUnknownModelError(message)) {
      const next = pickModel(agent.chain, attempts);
      if (next !== model) {
        const note = `${model} is not available on this key → ${next}`;
        await release(ctx, {
          pending_create_at: null,
          model_note: [task.model_note, note].filter(Boolean).join("; ").slice(0, 400),
          step: `Falling back to ${next}`,
          run_after: null,
        });
        await emitOfficeEvent(db, {
          missionId: mission.id,
          taskId: task.id,
          agentKey: agent.key,
          kind: "note",
          message: `${agent.name}: ${note}`,
        });
        return "polled";
      }
      return settleFailed(ctx, `No model in the chain is available on this key (${message.slice(0, 200)}).`);
    }
    if (agent.webSearch && task.input?.web_search_preview !== true && isToolTypeError(message)) {
      await release(ctx, {
        attempts: task.attempts,
        pending_create_at: null,
        input: { ...task.input, web_search_preview: true },
        step: "Retrying with the preview search tool",
      });
      return "polled";
    }
    // Refused outright: nothing was generated, nothing billed.
    await captureError(e, { source: "tick", path: "contentOffice/create", meta: { task: task.id, model } });
    return settleFailed(ctx, `OpenAI refused the request: ${message.slice(0, 300)}`);
  }

  // Network / timeout: the call may or may not have started on their side.
  // We cannot know, so we do NOT re-buy at once: back off and try again.
  const wait = nextBackoffMs(attempts);
  await release(ctx, {
    pending_create_at: null,
    run_after: new Date(Date.now() + wait).toISOString(),
    error: clip(message, 300),
    step: "Connection problem — retrying",
  });
  if (shouldGiveUp(attempts)) return settleFailed(ctx, `Could not reach OpenAI after ${attempts} tries: ${message.slice(0, 200)}`);
  return "busy";
}

// ---- POLL / ADVANCE --------------------------------------------------------------

async function meter(ctx: Ctx, r: RetrievedResponse, status: "complete" | "partial", latencyMs: number | null): Promise<number> {
  const { db, task } = ctx;
  if (!r.usage) return 0;
  const record = await recordUsage(db, {
    projectId: null,
    officeTaskId: task.id,
    kind: "chat",
    purpose: "agent",
    model: r.model ?? task.model ?? "unknown",
    ...toChatUsage(r.usage),
    status,
    latencyMs,
    error: r.error,
  });
  const searchCost = r.webSearchCalls.length * WEB_SEARCH_USD;
  const cost = Math.round((record.costUsd + searchCost) * 1e6) / 1e6;
  await patch(db, task.id, {
    usage_input: task.usage_input + r.usage.promptTokens,
    usage_cached: task.usage_cached + r.usage.cachedTokens,
    usage_output: task.usage_output + r.usage.completionTokens,
    usage_reasoning: task.usage_reasoning + r.usage.reasoningTokens,
    searches: task.searches + r.webSearchCalls.length,
    cost_usd: Math.round((Number(task.cost_usd) + cost) * 1e6) / 1e6,
  });
  for (const ws of r.webSearchCalls) {
    if (!ws.query) continue;
    await emitOfficeEvent(db, {
      missionId: ctx.mission.id,
      taskId: task.id,
      agentKey: ctx.agent.key,
      kind: "search",
      message: `${ctx.agent.name} searched: “${clip(ws.query, 90)}”`,
      meta: { query: ws.query },
    });
  }
  if (r.citations.length) {
    await emitOfficeEvent(db, {
      missionId: ctx.mission.id,
      taskId: task.id,
      agentKey: ctx.agent.key,
      kind: "note",
      message: `${ctx.agent.name} read ${r.citations.length} source${r.citations.length === 1 ? "" : "s"}`,
      meta: { citations: r.citations.slice(0, 12) },
    });
  }
  return cost;
}

async function poll(ctx: Ctx): Promise<StepResult> {
  const { db, task, mission, agent } = ctx;
  const responseId = task.openai_response_id;
  if (!responseId) {
    // Status says running but nothing was bought: back to the start line.
    await release(ctx, { status: "ready" });
    return "polled";
  }

  let r: RetrievedResponse;
  try {
    r = await openaiResponsesRetrieve(responseId, { timeoutMs: Math.max(2_000, Math.min(8_000, ctx.deadline - Date.now() - 300)) });
  } catch {
    await release(ctx);
    return "polled";
  }

  const startedAt = Date.parse(task.response_started_at ?? task.started_at ?? new Date().toISOString());
  const elapsed = Date.now() - startedAt;

  if (r.status === "queued" || r.status === "in_progress") {
    if (elapsed > MAX_TASK_WALL_MS) {
      await openaiResponsesCancel(responseId);
      await emitOfficeEvent(db, {
        missionId: mission.id,
        taskId: task.id,
        agentKey: agent.key,
        kind: "note",
        message: `${agent.name}'s response ran over ${Math.round(MAX_TASK_WALL_MS / 60_000)} minutes and was cancelled`,
      });
      return await retryLater(ctx, "The model ran too long and was cancelled.");
    }
    const minutes = Math.floor(elapsed / 60_000);
    const lastHb = Number(task.input?.last_heartbeat_min ?? -1);
    const step = minutes >= 1 ? `${task.phase === "tools" ? "Working" : "Reasoning"}… ${minutes}m ${Math.floor((elapsed % 60_000) / 1000)}s` : task.step;
    if (minutes >= 1 && minutes !== lastHb && elapsed >= HEARTBEAT_MS) {
      await emitOfficeEvent(db, {
        missionId: mission.id,
        taskId: task.id,
        agentKey: agent.key,
        kind: "thinking",
        message: `${agent.name} is still ${task.phase === "tools" ? "working" : "thinking"} (${minutes}m)`,
      });
      await release(ctx, { step, input: { ...task.input, last_heartbeat_min: minutes } });
    } else {
      await release(ctx, { step });
    }
    return "polled";
  }

  if (r.status !== "completed") {
    await meter(ctx, r, "partial", elapsed);
    const reason = r.error ?? r.status;
    if (r.incompleteReason === "max_output_tokens" && task.input?.bumped_tokens !== true) {
      await release(ctx, {
        status: "ready",
        openai_response_id: null,
        input: { ...task.input, bumped_tokens: true },
        step: "Answer was cut short — retrying with more room",
        error: reason,
      });
      return "polled";
    }
    return await retryLater(ctx, `OpenAI reported: ${reason}`);
  }

  // Completed.
  await meter(ctx, r, "complete", elapsed);
  await appendTranscript(db, task.id, r.functionCalls.map((c) => ({ type: "function_call", call_id: c.callId, name: c.name, arguments: clip(c.arguments, 4_000) })), {
    id: r.id,
    model: r.model,
    at: new Date().toISOString(),
    kind: "completed",
    usage: r.usage,
    text: r.text ? clip(r.text, 6_000) : null,
  });

  if (r.functionCalls.length) return await advanceWithTools(ctx, r);
  return await finish(ctx, r);
}

async function retryLater(ctx: Ctx, reason: string): Promise<StepResult> {
  const { task } = ctx;
  if (shouldGiveUp(task.attempts)) return settleFailed(ctx, reason);
  const wait = nextBackoffMs(task.attempts);
  await release(ctx, {
    status: "ready",
    openai_response_id: null,
    run_after: new Date(Date.now() + wait).toISOString(),
    error: clip(reason, 300),
    step: `Retrying in ${Math.round(wait / 60_000) || 1} min`,
    phase: "",
  });
  return "polled";
}

async function advanceWithTools(ctx: Ctx, r: RetrievedResponse): Promise<StepResult> {
  const { db, task, mission, agent } = ctx;
  const rounds = task.rounds + 1;
  if (rounds > MAX_TOOL_ROUNDS) return settleFailed(ctx, `Used tools ${MAX_TOOL_ROUNDS} times without finishing.`);

  // A continuation that failed to send last time left its outputs behind;
  // reuse them rather than run the tools twice.
  let outputs: ResponseInputItem[];
  const pendingFor = task.input?.pending_for;
  if (pendingFor === r.id && Array.isArray(task.input?.pending_outputs)) {
    outputs = task.input.pending_outputs as ResponseInputItem[];
  } else {
    const calls = r.functionCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    await patch(db, task.id, { phase: "tools", step: `Using ${[...new Set(calls.map((c) => c.name))].join(", ")}` });
    outputs = [];
    for (const call of calls) {
      const res = await executeOfficeTool({ db, mission, task, agent }, call.name, call.arguments, ctx.allowedTools);
      outputs.push({ type: "function_call_output", call_id: call.callId, output: res.output });
    }
    for (const call of r.functionCalls.slice(MAX_TOOL_CALLS_PER_ROUND)) {
      outputs.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify({ error: "Too many tool calls in one turn; call fewer at once." }) });
    }
    await patch(db, task.id, {
      tool_calls: task.tool_calls + calls.length,
      input: { ...task.input, pending_for: r.id, pending_outputs: outputs },
    });
  }

  const drafted = r.functionCalls.some((c) => c.name === "create_carousel_draft");
  const { instructions } = await buildPrompt(ctx);
  const nowIso = new Date().toISOString();

  const send = async (previous: string | null, items: ResponseInputItem[]) =>
    openaiResponsesCreate({
      model: task.model ?? pickModel(agent.chain, Math.max(0, task.attempts - 1)),
      instructions,
      input: items,
      tools: ctx.tools.length ? ctx.tools : undefined,
      reasoningEffort: agent.effort,
      textFormat: textFormatFor(ctx.kind),
      maxOutputTokens: agentByKey(agent.key)?.maxOutputTokens,
      previousResponseId: previous,
      metadata: { mission: mission.id, task: task.id, agent: agent.key },
      timeoutMs: createTimeout(ctx.deadline),
    });

  let created: { id: string };
  let note: string | null = null;
  try {
    created = await send(r.id, outputs);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (e instanceof OpenAIRequestError && isPreviousResponseError(message)) {
      // Continuation refused: resend the whole conversation instead.
      const { items } = await buildPrompt(ctx);
      const summary = outputs.map((o) => (o as { type: string; output: string }).output).join("\n");
      try {
        created = await send(null, [
          ...items,
          { role: "user", content: `Tool results so far (JSON):\n${clip(summary, 20_000)}\n\nContinue and return the final JSON.` },
        ]);
        note = "resent transcript";
      } catch (e2) {
        return await continuationFailed(ctx, e2);
      }
    } else {
      return await continuationFailed(ctx, e);
    }
  }

  await db
    .from("office_tasks")
    .update({
      openai_response_id: created.id,
      response_started_at: nowIso,
      rounds,
      phase: drafted ? "rendering" : "thinking",
      step: drafted ? "Draft sent to the render queue — wrapping up" : "Thinking about the results…",
      input: { ...task.input, pending_for: null, pending_outputs: null },
      model_note: note ? [task.model_note, note].filter(Boolean).join("; ").slice(0, 400) : task.model_note,
      lease_until: null,
      killed: 0,
    })
    .eq("id", task.id);
  await appendTranscript(db, task.id, outputs.map((o) => ({ ...(o as object), output: clip((o as { output: string }).output, 2_000) })), {
    id: created.id,
    model: task.model,
    at: nowIso,
    kind: "continuation",
  });
  return "advanced";
}

async function continuationFailed(ctx: Ctx, e: unknown): Promise<StepResult> {
  const message = (e as Error)?.message ?? String(e);
  if (e instanceof OpenAIRateLimitError) {
    // Outputs are parked on the task; the next poll of the same completed
    // response resends them.
    const wait = Math.min(15 * 60_000, Math.max(30_000, e.retryAfterMs ?? 60_000));
    await release(ctx, { run_after: new Date(Date.now() + wait).toISOString(), step: "Rate limited — waiting" });
    return "busy";
  }
  if (e instanceof OpenAIRequestError) {
    await captureError(e, { source: "tick", path: "contentOffice/continue", meta: { task: ctx.task.id } });
    return settleFailed(ctx, `OpenAI refused the follow-up: ${message.slice(0, 300)}`);
  }
  await release(ctx, { run_after: new Date(Date.now() + 60_000).toISOString(), step: "Connection problem — retrying" });
  return "busy";
}

async function finish(ctx: Ctx, r: RetrievedResponse): Promise<StepResult> {
  const { db, task, mission, agent } = ctx;
  const parsed = safeJsonParse(r.text);
  const checked = validateOutput(ctx.kind, parsed, mission.options ?? {});

  if (!checked.ok) {
    if (task.input?.repaired === true) return settleFailed(ctx, `The answer did not fit the required shape: ${checked.error}`);
    // One repair round: quote the problem back, ask for corrected JSON.
    const { instructions } = await buildPrompt(ctx);
    try {
      const created = await openaiResponsesCreate({
        model: task.model ?? pickModel(agent.chain, Math.max(0, task.attempts - 1)),
        instructions,
        input: [{ role: "user", content: `Your answer did not validate: ${checked.error}\nReturn the corrected JSON only.` }],
        tools: ctx.tools.length ? ctx.tools : undefined,
        reasoningEffort: agent.effort,
        textFormat: textFormatFor(ctx.kind),
        maxOutputTokens: agentByKey(agent.key)?.maxOutputTokens,
        previousResponseId: r.id,
        metadata: { mission: mission.id, task: task.id, agent: agent.key },
        timeoutMs: createTimeout(ctx.deadline),
      });
      await db
        .from("office_tasks")
        .update({
          openai_response_id: created.id,
          response_started_at: new Date().toISOString(),
          input: { ...task.input, repaired: true },
          step: "Fixing the answer's shape…",
          lease_until: null,
          killed: 0,
        })
        .eq("id", task.id);
      return "advanced";
    } catch (e) {
      return await continuationFailed(ctx, e);
    }
  }

  const finishedAt = new Date().toISOString();
  await db
    .from("office_tasks")
    .update({
      status: "done",
      output: checked.value,
      phase: "",
      step: "Done",
      finished_at: finishedAt,
      lease_until: null,
      killed: 0,
      error: null,
      input: { ...task.input, pending_for: null, pending_outputs: null },
    })
    .eq("id", task.id);

  await refreshMissionCost(db, mission.id);
  await unblockDependents(db, mission.id);
  const { data: fresh } = await db.from("office_tasks").select("*").eq("id", task.id).maybeSingle();
  await onTaskDone(db, fresh ?? { ...task, status: "done", output: checked.value, finished_at: finishedAt });
  return "done";
}

/** Flip queued tasks whose dependencies are all done to ready. */
export async function unblockDependents(db: DB, missionId?: string): Promise<number> {
  let q = db.from("office_tasks").select("id, status, depends_on, run_after, mission_id").in("status", ["queued", "done"]);
  if (missionId) q = q.eq("mission_id", missionId);
  const { data } = await q.limit(600);
  const tasks = data ?? [];
  // Readiness is per mission: a task may only depend on its own mission's tasks.
  const byMission = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const arr = byMission.get(t.mission_id) ?? [];
    arr.push(t);
    byMission.set(t.mission_id, arr);
  }
  const ready: string[] = [];
  const now = new Date().toISOString();
  for (const list of byMission.values()) ready.push(...readyTaskIds(list, now));
  if (ready.length) await db.from("office_tasks").update({ status: "ready" }).in("id", ready).eq("status", "queued");
  return ready.length;
}

// ---- The step ----------------------------------------------------------------------

export async function stepOfficeTask(db: DB, taskId: string, opts: StepOptions): Promise<StepResult> {
  const { data: task } = await db.from("office_tasks").select("*").eq("id", taskId).maybeSingle();
  if (!task || (task.status !== "ready" && task.status !== "running")) return "skipped";
  const nowIso = new Date().toISOString();
  if (!leaseIsFree(task.lease_until, nowIso)) return "busy";
  if (task.status === "ready" && task.run_after && task.run_after > nowIso) return "skipped";

  // Take the lease with a compare-and-set on the version counter; bump the
  // kill counter first (a step that returns normally resets it).
  const { data: leased } = await db
    .from("office_tasks")
    .update({ lease_until: leaseUntil(Date.now()), version: task.version + 1, killed: task.killed + 1 })
    .eq("id", task.id)
    .eq("version", task.version)
    .select("id")
    .maybeSingle();
  if (!leased) return "busy";

  const { data: mission } = await db.from("office_missions").select("*").eq("id", task.mission_id).maybeSingle();
  if (!mission || ["cancelled", "failed", "done"].includes(mission.status)) {
    await patch(db, task.id, { status: "cancelled", lease_until: null });
    return "skipped";
  }

  const roster = opts.roster ?? (await loadRoster(db));
  const agent = roster.find((a) => a.key === task.agent_key);
  const allowedTools = agent ? [...agent.tools] : [];
  if (agent?.key === "publisher" && mission.options?.autoPublish) allowedTools.push("queue_post");
  const kind = agent ? outputKindFor(task, agent.key) : "plan";
  const tools: ResponsesTool[] = agent ? [...toolSchemasFor(allowedTools)] : [];
  const ws = agent ? webSearchTool(agent, task) : null;
  if (ws) tools.push(ws);

  const ctx: Ctx = { db, task, mission, agent: agent!, kind, allowedTools, tools, deadline: opts.deadline, version: task.version + 1 };

  if (!agent) return settleFailed(ctx, `No agent called "${task.agent_key}" works here.`);
  if (task.killed + 1 > MAX_KILLED_STEPS) {
    return settleFailed(ctx, `The platform cut this step off ${MAX_KILLED_STEPS} times in a row.`);
  }
  if (mission.status === "paused" || !agent.enabled) {
    await release(ctx, { step: agent.enabled ? "Mission paused" : `${agent.name} is paused` });
    return "skipped";
  }

  try {
    if (task.status === "ready") {
      const cap = opts.dailyCapUsd ?? (await loadOfficeSettings(db)).dailyCapUsd;
      return await start(ctx, cap);
    }
    return await poll(ctx);
  } catch (e) {
    await captureError(e, { source: "tick", path: "contentOffice/step", meta: { task: task.id, status: task.status } });
    // Whatever broke, the lease must not stay held: the next step retries.
    await release(ctx, { error: clip((e as Error).message ?? String(e), 300) });
    return "polled";
  }
}

// ---- The driver ---------------------------------------------------------------------

export type RunOptions = {
  budgetMs: number;
  maxPolls?: number;
  maxStarts?: number;
};

export type RunSummary = { polled: number; started: number; advanced: number; done: number; failed: number; busy: number; schedules: number };

/**
 * One bounded pass over the office: fire due schedules, release tasks whose
 * dependencies finished, poll what is running, start what is ready. Called
 * by the automation tick and by the open page.
 */
export async function runOfficeStep(db: DB, opts: RunOptions): Promise<RunSummary> {
  const deadline = Date.now() + opts.budgetMs;
  const maxPolls = opts.maxPolls ?? 4;
  const maxStarts = opts.maxStarts ?? 2;
  const out: RunSummary = { polled: 0, started: 0, advanced: 0, done: 0, failed: 0, busy: 0, schedules: 0 };

  try {
    out.schedules = await processOfficeSchedules(db, new Date());
  } catch (e) {
    await captureError(e, { source: "tick", path: "contentOffice/schedules" });
  }

  await unblockDependents(db);

  const roster = await loadRoster(db);
  const settings = await loadOfficeSettings(db);
  const nowIso = new Date().toISOString();

  const tally = (r: StepResult) => {
    if (r === "polled") out.polled += 1;
    else if (r === "started") out.started += 1;
    else if (r === "advanced") out.advanced += 1;
    else if (r === "done") out.done += 1;
    else if (r === "failed") out.failed += 1;
    else if (r === "busy" || r === "blocked") out.busy += 1;
  };

  if (maxPolls > 0) {
    const { data: running } = await db
      .from("office_tasks")
      .select("id")
      .eq("status", "running")
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
      .order("updated_at", { ascending: true })
      .limit(maxPolls);
    for (const t of running ?? []) {
      if (Date.now() > deadline - 2_000) break;
      tally(await stepOfficeTask(db, t.id, { deadline, roster, dailyCapUsd: settings.dailyCapUsd }));
    }
  }

  if (maxStarts > 0) {
    const { data: ready } = await db
      .from("office_tasks")
      .select("id")
      .eq("status", "ready")
      .or(`run_after.is.null,run_after.lte.${nowIso}`)
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
      .order("created_at", { ascending: true })
      .limit(maxStarts);
    for (const t of ready ?? []) {
      if (Date.now() > deadline - MIN_CREATE_MS - 1_000) break;
      tally(await stepOfficeTask(db, t.id, { deadline, roster, dailyCapUsd: settings.dailyCapUsd }));
    }
  }

  return out;
}
