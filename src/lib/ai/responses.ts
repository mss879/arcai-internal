import "server-only";

import { OpenAIRateLimitError, OpenAIRequestError } from "./openai";
import { responsesEffortFor, supportsTemperature } from "./reasoning-core";
import {
  parseResponseBody,
  type ResponsesStatus,
  type RetrievedResponse,
} from "./responses-core";

/**
 * The tool-capable Responses API client (0130).
 *
 * `openai.ts` already speaks /v1/responses for text-only background jobs
 * (`openaiResponseStart` / `openaiResponsePoll`) and those callers are left
 * alone. This module exists because the Content Office agents need what
 * those cannot do: function tools, the built-in web search, structured
 * outputs, and continuation of a finished response with tool results —
 * all in background mode, because the deployed platform kills a function at
 * ~26s and an agent step can think for minutes.
 *
 * Everything here returns at once. Nothing awaits a model.
 */

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

/** Starting a background response is a fast POST; retrieving is a fast GET. */
export const RESPONSES_CREATE_TIMEOUT_MS = 10_000;
export const RESPONSES_RETRIEVE_TIMEOUT_MS = 8_000;

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  return key;
}

/** One item of the `input` array. */
export type ResponseInputItem =
  | { role: "user" | "assistant" | "developer"; content: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** A function tool — FLAT, unlike Chat Completions' `{ function: {...} }`. */
export type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

export type ResponsesWebSearchTool = {
  type: "web_search" | "web_search_preview";
  search_context_size?: "low" | "medium" | "high";
  user_location?: {
    type: "approximate";
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
};

export type ResponsesTool = ResponsesFunctionTool | ResponsesWebSearchTool;

/** Structured output. `strict` needs every object to list all keys in
 * `required` and to set `additionalProperties: false`. */
export type JsonSchemaFormat = {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  strict: true;
};

export type ResponsesCreateInput = {
  model: string;
  /** Sent on EVERY call — `previous_response_id` does not carry them. */
  instructions: string;
  input: ResponseInputItem[];
  tools?: ResponsesTool[];
  toolChoice?: "auto" | "required" | "none";
  reasoningEffort?: string | null;
  /** Ignored on reasoning models, which reject it. */
  temperature?: number;
  textFormat?: JsonSchemaFormat;
  previousResponseId?: string | null;
  maxOutputTokens?: number;
  /** ≤16 keys, short strings — mission and task ids for OpenAI's own logs. */
  metadata?: Record<string, string>;
  timeoutMs?: number;
};

function retryAfterMs(res: Response): number | null {
  const ms = res.headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const s = res.headers.get("retry-after");
  if (s && Number.isFinite(Number(s))) return Number(s) * 1000;
  return null;
}

/**
 * Start a response in background mode. Returns the id at once; the model
 * works on OpenAI's side and `openaiResponsesRetrieve` reads the result from
 * any later invocation — a tick, a page poll, a retry after a kill.
 *
 * Throws `OpenAIRequestError` when the API refuses the request (nothing was
 * generated, nothing is billed) and `OpenAIRateLimitError` on a 429.
 */
export async function openaiResponsesCreate(
  input: ResponsesCreateInput,
): Promise<{ id: string; status: ResponsesStatus }> {
  const model = input.model.trim();
  const effort = responsesEffortFor(model, input.reasoningEffort ?? null);

  const body: Record<string, unknown> = {
    model,
    background: true,
    store: true,
    instructions: input.instructions,
    input: input.input,
  };
  if (input.tools?.length) {
    body.tools = input.tools;
    body.tool_choice = input.toolChoice ?? "auto";
  }
  if (effort) body.reasoning = { effort };
  if (typeof input.temperature === "number" && supportsTemperature(model)) {
    body.temperature = input.temperature;
  }
  if (input.textFormat) body.text = { format: input.textFormat };
  if (input.previousResponseId) body.previous_response_id = input.previousResponseId;
  if (input.maxOutputTokens) body.max_output_tokens = input.maxOutputTokens;
  if (input.metadata) body.metadata = input.metadata;

  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    signal: AbortSignal.timeout(Math.max(1_000, input.timeoutMs ?? RESPONSES_CREATE_TIMEOUT_MS)),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 800);
    if (res.status === 429) {
      throw new OpenAIRateLimitError(
        `OpenAI responses rate limited (429): ${detail}`,
        retryAfterMs(res),
      );
    }
    throw new OpenAIRequestError(res.status, detail, "responses");
  }

  const json = (await res.json()) as { id?: unknown; status?: unknown };
  if (typeof json?.id !== "string" || !json.id) {
    throw new Error("OpenAI responses returned no id.");
  }
  const status = typeof json.status === "string" ? (json.status as ResponsesStatus) : "queued";
  return { id: json.id, status };
}

/**
 * Read a response. A 404 means OpenAI no longer has it (background bodies
 * are kept for a bounded time), which is reported as a failed response
 * rather than thrown — the caller retries the step, it does not crash.
 * Any other non-OK status throws, and the caller treats that as transient.
 */
export async function openaiResponsesRetrieve(
  id: string,
  opts?: { timeoutMs?: number },
): Promise<RetrievedResponse> {
  const res = await fetch(`${BASE_URL}/responses/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(Math.max(1_000, opts?.timeoutMs ?? RESPONSES_RETRIEVE_TIMEOUT_MS)),
  });
  if (res.status === 404) {
    return {
      id,
      status: "failed",
      model: null,
      text: null,
      functionCalls: [],
      webSearchCalls: [],
      citations: [],
      usage: null,
      error: "expired: OpenAI no longer has this response",
      incompleteReason: null,
    };
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`OpenAI responses retrieve failed (${res.status}): ${detail}`);
  }
  return parseResponseBody(await res.json());
}

/** Stop a running response. Idempotent on OpenAI's side; never throws. */
export async function openaiResponsesCancel(id: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/responses/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(RESPONSES_RETRIEVE_TIMEOUT_MS),
    });
  } catch {
    // Best effort: a response that cannot be cancelled simply finishes and
    // is ignored by a task that has already moved on.
  }
}
