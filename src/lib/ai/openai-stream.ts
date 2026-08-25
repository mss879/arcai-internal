import "server-only";

/**
 * The streaming twin of `openaiChat`.
 *
 * `openaiChat` waits for the whole reply, which is fine when a route answers
 * in one JSON blob but shows the user a spinner for as long as the model
 * takes. The assistant workspace needs the words as they are written and the
 * tool calls the moment they are complete, so this issues the same Chat
 * Completions request with `stream: true` and reassembles the message from
 * the delta frames.
 *
 * Reassembly is the whole job here, and it is fiddlier than it looks:
 * OpenAI streams a tool call in pieces. The `id` and the function `name`
 * arrive on the first delta for a call, and the JSON `arguments` arrive as a
 * run of string fragments across many later deltas — often not even split on
 * a token boundary. The only thing tying them together is the `index` field,
 * which is why everything below accumulates into a map keyed by it rather
 * than by array position.
 *
 * Behaviour otherwise matches `openaiChat` deliberately: same base URL, same
 * key, same finite timeout, same `temperature`-vs-reasoning-model handling,
 * and the same `OpenAIRateLimitError` on a 429 so a caller can back off on
 * the server's own window instead of guessing.
 */

import {
  AI_MODELS,
  isReasoningModel,
  OpenAIRateLimitError,
  type ChatMessage,
  type ToolCall,
  type ToolSchema,
} from "@/lib/ai/openai";

// Re-derived rather than imported: `openai.ts` keeps its base URL and key
// helper module-private, and that file is not ours to widen.
const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

/** Mirrors the ceiling in `openai.ts` — one round-trip, streamed or not. */
const CHAT_TIMEOUT_MS = 45_000;

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  return key;
}

/** A tool call being rebuilt from its fragments. */
type PartialToolCall = { id: string; name: string; arguments: string };

/** Called with each chunk of assistant text, in order, as it arrives. */
export type ChatStreamDelta = (text: string) => void;

/** Knobs shared with `openaiChat`. */
export type ChatStreamOptions = {
  model?: string;
  timeoutMs?: number;
  temperature?: number;
};

/**
 * One streamed round-trip to chat completions.
 *
 * Calls `onDelta` with every chunk of visible text as it arrives, and
 * resolves with the complete assistant message — content plus fully
 * reassembled `tool_calls` — so the caller can push it straight into the
 * conversation and run the tools exactly as it would after `openaiChat`.
 *
 * @param messages Conversation so far, including the system prompt.
 * @param tools Schemas to advertise. Omit to force a plain text answer.
 * @param opts Model, timeout and temperature overrides.
 * @param onDelta Receives each text chunk. Never receives tool-call JSON.
 * @throws {OpenAIRateLimitError} on a 429, carrying the server's retry window.
 */
export async function openaiChatStream(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  opts?: ChatStreamOptions,
  onDelta?: ChatStreamDelta,
): Promise<ChatMessage> {
  const model = opts?.model?.trim() || AI_MODELS.chat;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // Same default as `openaiChat`: this assistant must not improvise data.
      // (Reasoning models reject temperature — omit it for them.)
      ...(isReasoningModel(model) ? {} : { temperature: opts?.temperature ?? 0 }),
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    }),
    signal: AbortSignal.timeout(
      Math.max(1_000, opts?.timeoutMs ?? CHAT_TIMEOUT_MS),
    ),
  });

  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const seconds = header ? Number(header) : NaN;
      throw new OpenAIRateLimitError(
        `OpenAI chat rate-limited: ${detail}`,
        Number.isFinite(seconds) ? seconds * 1000 : null,
      );
    }
    throw new Error(`OpenAI chat failed (${res.status}): ${detail}`);
  }
  if (!res.body) throw new Error("OpenAI chat returned no stream body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const partials = new Map<number, PartialToolCall>();
  let buffer = "";
  let content = "";

  /** Fold one `data:` payload into the message being assembled. */
  const consume = (payload: string) => {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      // A frame we cannot parse is dropped rather than failing the turn —
      // losing one chunk beats losing an answer the model already paid for.
      return;
    }

    const delta = (
      json as {
        choices?: { delta?: Record<string, unknown> }[];
      }
    )?.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }

    const calls = delta.tool_calls;
    if (!Array.isArray(calls)) return;
    for (const raw of calls) {
      const call = raw as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      // A single-call stream sometimes omits `index` entirely; slot 0 is the
      // only sane reading of that, and it keeps the fragments together.
      const index = typeof call.index === "number" ? call.index : 0;
      const found = partials.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) found.id = call.id;
      if (call.function?.name) found.name = call.function.name;
      if (typeof call.function?.arguments === "string") {
        found.arguments += call.function.arguments;
      }
      partials.set(index, found);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      consume(payload);
    }
  }

  // The loop above only ever acts on a line that arrived with its newline, so
  // a last frame delivered without one is dropped. That is not hypothetical
  // harm: the tail of a stream is where the final `arguments` fragment lives,
  // and losing it yields a tool call whose JSON is truncated rather than
  // absent — the caller's `JSON.parse` fails, falls back to `{}`, and the tool
  // runs with no arguments instead of the ones the model chose. Flush the
  // decoder and give the remainder the same treatment. A genuinely half-
  // written frame still parses as nothing and is discarded by `consume`.
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== "[DONE]") consume(payload);
  }

  const toolCalls: ToolCall[] = [...partials.entries()]
    .sort((a, b) => a[0] - b[0])
    // A fragment that never carried a name is not a callable tool — it would
    // execute as "unknown tool" and waste a turn, so drop it here.
    .filter(([, call]) => Boolean(call.name))
    .map(([index, call]) => ({
      // The id must survive: the next turn sends a `tool` message keyed by it,
      // and the API rejects an empty `tool_call_id`. A synthesised one keeps
      // the pairing valid if a stream ever withholds the real one.
      id: call.id || `call_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    }));

  return {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}
