import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AI_MODELS,
  OpenAIRateLimitError,
  OpenAIRequestError,
  isReasoningModel,
  type ChatMessage,
  type ChatUsage,
  type ToolSchema,
} from "@/lib/ai/openai";
import { openaiChatStream } from "@/lib/ai/openai-stream";
import type { Database } from "@/lib/database.types";
import { captureError } from "@/lib/errors";

import {
  HISTORY_MAX_MESSAGES,
  MAX_TOOL_TURNS,
  REPLY_MAX_TOKENS,
  REPLY_MAX_TOKENS_REASONING,
  SESSION_MAX_USER_MESSAGES,
  TOOL_LABELS,
  buildTools,
  composeSystemPrompt,
  retrievalQuery,
  windowHistory,
  type ChatRequest,
  type HistoryMessage,
  type PromptProject,
} from "./chat-core";
import { estimateTokens, selectableModels } from "./pricing-core";
import { businessNameFor, type AiProjectWithClient } from "./projects";
import { compileToolSchema, type ToolDef } from "./tool-core";
import { hasReadySources, retrieveChunks } from "./retrieval";
import { AI_ERROR_MESSAGES, type AiStreamEvent } from "./stream-core";
import { colomboDay } from "./time-core";
import { executeAiTool } from "./tools";
import { loadPriceCatalog, recordUsage, refreshConversationTotals, rollupDay } from "./usage";

type DB = SupabaseClient<Database>;

/**
 * One visitor turn (0126) — the pipeline the plan describes, in order:
 * conversation → user message → retrieval → prompt → streamed model call →
 * tools → (second call) → persist → usage → rollup.
 *
 * Usage is never lost: every model call's token count arrives through a
 * callback and is written the moment the call ends, and a call our own
 * timeout cut short is written as `partial` with an estimate. The model
 * call is deliberately not tied to the request's abort signal — a visitor
 * closing the tab stops the frames, not the metering.
 */

const TURN_BUDGET_MS = Number(process.env.AI_CHAT_BUDGET_MS) || 30_000;
const WRAP_UP_RESERVE_MS = 6_000;
const PER_CALL_MAX_MS = 20_000;
const PER_CALL_FLOOR_MS = 5_000;
const HEARTBEAT_MS = 10_000;

export type ChatTurnInput = {
  db: DB;
  project: AiProjectWithClient;
  /** 0127 — the tools the agency wired to the client's backend. */
  customTools?: ToolDef[];
  request: ChatRequest;
  preview: boolean;
  ip: string;
  userAgent: string | null;
  country: string | null;
  send: (event: AiStreamEvent) => void;
};

function ipHash(ip: string): string {
  return createHash("sha256").update(`arc-ai:${ip}`).digest("hex").slice(0, 32);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The project's model, or the default when the catalog no longer offers it. */
async function resolveModel(db: DB, project: AiProjectWithClient): Promise<string> {
  try {
    const catalog = await loadPriceCatalog(db);
    const offered = selectableModels(catalog, colomboDay()).some((m) => m.model === project.model);
    if (offered) return project.model;
    await captureError(new Error(`AI project ${project.id} uses model "${project.model}", which the catalog no longer offers — using ${AI_MODELS.chat}`), {
      source: "route",
      path: "ai/chat/model",
      meta: { project: project.id, model: project.model },
    });
  } catch {
    // A catalog read failure should not stop a reply.
  }
  return AI_MODELS.chat;
}

export async function runChatTurn(input: ChatTurnInput): Promise<void> {
  const { db, project, request, preview, send } = input;
  const startedAt = Date.now();
  const budgetEnd = startedAt + TURN_BUDGET_MS;
  const billable = !preview;

  // 1. The conversation, and the visitor's message — written first so a
  //    crash later still leaves the question in the transcript.
  const { data: conversation, error: convError } = await db
    .from("ai_conversations")
    .upsert(
      {
        project_id: project.id,
        session_key: request.session,
        visitor_id: request.visitor,
        page_url: request.page.url,
        page_title: request.page.title,
        referrer: request.page.referrer,
        user_agent: input.userAgent?.slice(0, 300) ?? null,
        ip_hash: ipHash(input.ip),
        country: input.country,
        is_preview: preview,
        last_message_at: new Date().toISOString(),
      },
      { onConflict: "project_id,session_key" },
    )
    .select("id, user_messages, message_count, assistant_messages")
    .single();
  if (convError || !conversation) {
    send({ type: "error", code: "failed", message: AI_ERROR_MESSAGES.failed });
    await captureError(new Error(`conversation upsert failed: ${convError?.message}`), { source: "route", path: "ai/chat/conversation", meta: { project: project.id } });
    return;
  }
  if (conversation.user_messages >= SESSION_MAX_USER_MESSAGES) {
    send({ type: "error", code: "session_full", message: AI_ERROR_MESSAGES.session_full });
    return;
  }
  // Narrowed once here; closures below cannot see the null check above.
  const conv = conversation;
  send({ type: "meta", conversation: conv.id, session: request.session });

  const { data: userMessage } = await db
    .from("ai_messages")
    .insert({ conversation_id: conversation.id, project_id: project.id, role: "user", content: request.message })
    .select("id")
    .single();

  // 2. History (before this message) and retrieval, side by side.
  const historyPromise = db
    .from("ai_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversation.id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(HISTORY_MAX_MESSAGES + 2);

  const previousUser = async (): Promise<string | null> => {
    const { data } = await historyPromise;
    // Newest first, this message excluded: the head is the previous question.
    return (data ?? []).find((m) => m.role === "user" && m.id !== userMessage?.id)?.content ?? null;
  };

  const retrievalPromise = (async () => {
    if (!(await hasReadySources(db, project.id))) return { chunks: [], error: null };
    const query = retrievalQuery(request.message, await previousUser());
    return retrieveChunks(db, { projectId: project.id, query, conversationId: conversation.id, billable });
  })();

  const [{ data: historyRows }, retrieval] = await Promise.all([historyPromise, retrievalPromise]);
  const history: HistoryMessage[] = (historyRows ?? [])
    // Drop the message we just wrote — it is sent separately, as the turn.
    .filter((m) => m.id !== userMessage?.id)
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // 3. The prompt.
  const promptProject: PromptProject = {
    agentName: project.agent_name,
    businessName: businessNameFor(project),
    websiteUrl: project.website_url,
    systemPrompt: project.system_prompt,
    leadCapture: project.lead_capture_enabled,
    booking: project.booking_enabled,
    bookingUrl: project.booking_url,
    handoff: project.handoff_enabled,
    customTools: (input.customTools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      kind: t.kind,
      schema: compileToolSchema(t),
    })),
  };
  const system = composeSystemPrompt(promptProject, retrieval.chunks, { url: request.page.url, title: request.page.title });
  const tools = buildTools(promptProject) as ToolSchema[];
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...windowHistory(history).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: request.message },
  ];

  const model = await resolveModel(db, project);
  const reasoning = isReasoningModel(model);
  const spoken: string[] = [];

  /** One model call, metered whatever happens to it. */
  async function speak(withTools: boolean): Promise<ChatMessage | null> {
    const remaining = budgetEnd - Date.now();
    const timeoutMs = Math.max(PER_CALL_FLOOR_MS, Math.min(PER_CALL_MAX_MS, remaining));
    let usage: ChatUsage | null = null;
    let streamed = "";
    const callStart = Date.now();

    const opts = {
      model,
      timeoutMs,
      ...(reasoning ? { reasoningEffort: project.reasoning_effort } : { temperature: Number(project.temperature) || 0 }),
      maxCompletionTokens: reasoning ? REPLY_MAX_TOKENS_REASONING : REPLY_MAX_TOKENS,
      onUsage: (u: ChatUsage) => {
        usage = u;
      },
    };
    const onDelta = (text: string) => {
      streamed += text;
      send({ type: "delta", text });
    };

    let reply: ChatMessage | null = null;
    let failure: unknown = null;
    try {
      reply = await openaiChatStream(messages, withTools && tools.length ? tools : undefined, opts, onDelta);
    } catch (e) {
      failure = e;
    }

    const u = usage as ChatUsage | null;
    if (u) {
      await recordUsage(db, {
        projectId: project.id,
        conversationId: conv.id,
        messageId: userMessage?.id ?? null,
        kind: "chat",
        purpose: "reply",
        model,
        promptTokens: u.promptTokens,
        cachedTokens: u.cachedTokens,
        completionTokens: u.completionTokens,
        billable,
        latencyMs: Date.now() - callStart,
      });
    } else if (!(failure instanceof OpenAIRateLimitError)) {
      // No usage frame. Two very different reasons, and the difference is the
      // client's bill: a call the API REFUSED (bad model, a parameter it does
      // not take, their 500) generated nothing and cost nothing, so it is
      // recorded at zero — visible on the Analytics tab as a failure, absent
      // from the invoice. A call that ran and was cut off did burn tokens
      // nobody counted, so that one is estimated and marked partial.
      const refused = failure instanceof OpenAIRequestError;
      const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
      await recordUsage(db, {
        projectId: project.id,
        conversationId: conv.id,
        messageId: userMessage?.id ?? null,
        kind: "chat",
        purpose: "reply",
        model,
        promptTokens: refused ? 0 : estimateTokens(" ".repeat(promptChars)),
        cachedTokens: 0,
        completionTokens: refused ? 0 : estimateTokens(streamed),
        billable,
        status: "partial",
        latencyMs: Date.now() - callStart,
        error: failure ? (failure instanceof Error ? failure.message.slice(0, 200) : "cut off") : "no usage frame",
      });
    }

    if (failure) throw failure;
    if (reply?.content) spoken.push(reply.content);
    return reply;
  }

  try {
    let retried = false;
    for (let turn = 0; turn < MAX_TOOL_TURNS + 1; turn += 1) {
      const outOfTime = budgetEnd - Date.now() < WRAP_UP_RESERVE_MS;
      const withTools = turn < MAX_TOOL_TURNS && !outOfTime;
      let reply: ChatMessage | null;
      try {
        reply = await speak(withTools);
      } catch (e) {
        if (e instanceof OpenAIRateLimitError && !spoken.length && !retried) {
          retried = true;
          await sleep(Math.min(e.retryAfterMs ?? 3_000, 3_000));
          turn -= 1;
          continue;
        }
        throw e;
      }
      if (!reply) break;

      const toolCalls = reply.tool_calls ?? [];
      if (!toolCalls.length) break;

      messages.push(reply);
      for (const call of toolCalls) {
        const name = call.function.name;
        send({ type: "tool", name, label: TOOL_LABELS[name] ?? name.replace(/_/g, " ") });
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const heartbeat = setInterval(() => send({ type: "ping" }), HEARTBEAT_MS);
        let outcome;
        try {
          outcome = await executeAiTool(
            {
              db,
              project,
              conversationId: conv.id,
              pageUrl: request.page.url,
              preview,
              customTools: input.customTools ?? [],
              remainingMs: budgetEnd - Date.now(),
            },
            name,
            args,
          );
        } finally {
          clearInterval(heartbeat);
        }
        if (outcome.action) send({ type: "action", ...outcome.action });
        await db.from("ai_messages").insert({
          conversation_id: conversation.id,
          project_id: project.id,
          role: "tool",
          tool_name: name,
          content: "",
          meta: { args: name === "capture_lead" ? { name: (args as { name?: string })?.name ?? null } : args, result: outcome.content },
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.content) });
      }
    }
  } catch (e) {
    if (e instanceof OpenAIRateLimitError) {
      send({ type: "error", code: "rate_limited", message: AI_ERROR_MESSAGES.rate_limited, retryAfter: Math.ceil((e.retryAfterMs ?? 5_000) / 1000) });
    } else {
      send({ type: "error", code: "failed", message: AI_ERROR_MESSAGES.failed });
    }
    await captureError(e, { source: "route", path: "ai/chat", meta: { project: project.id, model } });
    if (spoken.length) await persistReply(); // keep whatever was already said
    return;
  }

  await persistReply();
  send({ type: "done", reply: spoken.join("\n\n") });

  // 0127 — the visitor has their reply and the stream is finished, but this
  // invocation is still alive. Spend a few seconds of it getting anything
  // captured in this turn onto the client's own system, so a healthy
  // endpoint has the lead now rather than on the next tick.
  if (!preview) {
    const { drainProjectDeliveries } = await import("./delivery");
    await drainProjectDeliveries(db, project.id, { budgetMs: 5_000 });
  }

  async function persistReply(): Promise<void> {
    const reply = spoken.join("\n\n").trim();
    if (reply) {
      await db.from("ai_messages").insert({ conversation_id: conv.id, project_id: project.id, role: "assistant", content: reply });
    }
    await db
      .from("ai_conversations")
      .update({
        message_count: conv.message_count + (reply ? 2 : 1),
        user_messages: conv.user_messages + 1,
        assistant_messages: conv.assistant_messages + (reply ? 1 : 0),
        last_message_at: new Date().toISOString(),
      })
      .eq("id", conv.id);
    // Best-effort bookkeeping; the ledger rows above are the truth.
    await Promise.all([refreshConversationTotals(db, conv.id), rollupDay(db, project.id, colomboDay())]);
  }
}
