/**
 * Reading an OpenAI Responses API body (0130).
 *
 * Pure, and separate from `responses.ts`, because that module is server-only
 * and the parsing is the part that must be pinned by tests: the wire format
 * differs from Chat Completions in every place that matters —
 *
 *   * the answer is `output[]` items, not `choices[]`; text lives in
 *     `message.content[].text` where `type === "output_text"` (the SDK's
 *     `output_text` convenience is NOT on the wire);
 *   * tool calls are top-level `function_call` items with a `call_id`;
 *   * usage is `usage.input_tokens` / `output_tokens`, so the Chat
 *     `readUsage()` would report zeros and every agent call would meter at $0.
 */

/** Structurally identical to `ChatUsage` in openai.ts, which is server-only and so cannot be imported here. */
export type ChatUsageLike = { promptTokens: number; completionTokens: number; cachedTokens: number };

export type ResponsesStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

const STATUSES: readonly ResponsesStatus[] = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
];

/** Token usage for one response. `promptTokens` INCLUDES `cachedTokens`;
 * `completionTokens` INCLUDES `reasoningTokens` — the same convention as
 * Chat Completions, so `costUsd` prices both identically. */
export type ResponsesUsage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
};

export type ResponseFunctionCall = {
  /** The output item id. */
  id: string;
  /** What a `function_call_output` must echo back. */
  callId: string;
  name: string;
  /** Raw JSON text, exactly as the model wrote it. */
  arguments: string;
};

export type ResponseWebSearchCall = {
  id: string;
  status: string;
  query: string | null;
};

export type ResponseCitation = { url: string; title: string };

export type RetrievedResponse = {
  id: string;
  status: ResponsesStatus;
  model: string | null;
  text: string | null;
  functionCalls: ResponseFunctionCall[];
  webSearchCalls: ResponseWebSearchCall[];
  citations: ResponseCitation[];
  usage: ResponsesUsage | null;
  error: string | null;
  incompleteReason: string | null;
};

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length ? v : null;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;

/** The `usage` block, or null when the body carries none. */
export function readResponsesUsage(json: unknown): ResponsesUsage | null {
  const usage = rec(rec(json)?.usage);
  if (!usage) return null;
  const inDetails = rec(usage.input_tokens_details);
  const outDetails = rec(usage.output_tokens_details);
  return {
    promptTokens: num(usage.input_tokens),
    cachedTokens: num(inDetails?.cached_tokens),
    completionTokens: num(usage.output_tokens),
    reasoningTokens: num(outDetails?.reasoning_tokens),
  };
}

/** The shape `recordUsage` meters. */
export function toChatUsage(u: ResponsesUsage): ChatUsageLike {
  return {
    promptTokens: u.promptTokens,
    cachedTokens: u.cachedTokens,
    completionTokens: u.completionTokens,
  };
}

/** Walk a Responses body into the parts the runtime acts on. Never throws. */
export function parseResponseBody(json: unknown): RetrievedResponse {
  const body = rec(json) ?? {};
  const rawStatus = str(body.status);
  const status: ResponsesStatus = STATUSES.includes(rawStatus as ResponsesStatus)
    ? (rawStatus as ResponsesStatus)
    : "failed";

  let text: string | null = null;
  const functionCalls: ResponseFunctionCall[] = [];
  const webSearchCalls: ResponseWebSearchCall[] = [];
  const citations: ResponseCitation[] = [];
  const seenUrls = new Set<string>();

  const output = Array.isArray(body.output) ? body.output : [];
  for (const raw of output) {
    const item = rec(raw);
    if (!item) continue;
    const type = str(item.type);

    if (type === "message" && Array.isArray(item.content)) {
      for (const partRaw of item.content) {
        const part = rec(partRaw);
        if (!part || part.type !== "output_text") continue;
        if (typeof part.text === "string") text = (text ?? "") + part.text;
        const annotations = Array.isArray(part.annotations) ? part.annotations : [];
        for (const aRaw of annotations) {
          const a = rec(aRaw);
          if (!a || a.type !== "url_citation") continue;
          const url = str(a.url);
          if (!url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          citations.push({ url, title: str(a.title) ?? url });
        }
      }
      continue;
    }

    if (type === "function_call") {
      const name = str(item.name);
      const callId = str(item.call_id);
      if (!name || !callId) continue;
      functionCalls.push({
        id: str(item.id) ?? callId,
        callId,
        name,
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      });
      continue;
    }

    if (type === "web_search_call") {
      const action = rec(item.action);
      const queries = Array.isArray(action?.queries) ? action?.queries : null;
      webSearchCalls.push({
        id: str(item.id) ?? "",
        status: str(item.status) ?? "completed",
        query:
          str(action?.query) ??
          (queries && typeof queries[0] === "string" ? (queries[0] as string) : null),
      });
    }
  }

  const errorObj = rec(body.error);
  const incomplete = rec(body.incomplete_details);
  const incompleteReason = str(incomplete?.reason);
  const error =
    str(errorObj?.message) ??
    (incompleteReason ? `incomplete: ${incompleteReason}` : null);

  return {
    id: str(body.id) ?? "",
    status,
    model: str(body.model),
    text,
    functionCalls,
    webSearchCalls,
    citations,
    usage: readResponsesUsage(body),
    error,
    incompleteReason,
  };
}

/** A 4xx that means "this key has no such model" — the chain moves on. */
export function isUnknownModelError(message: string): boolean {
  return (
    /model[_ ]not[_ ]found|does not exist|do not have access to (the )?model|invalid model|unknown model|no such model/i.test(
      message,
    ) || /\(404\)/.test(message)
  );
}

/** A 4xx that means "this model does not take that parameter". */
export function isUnsupportedParamError(message: string, param: string): boolean {
  return (
    /unsupported[_ ]parameter|not supported|unknown parameter|unrecognized request argument|invalid[_ ]request/i.test(
      message,
    ) && message.toLowerCase().includes(param.toLowerCase())
  );
}

/** The continuation was refused — resend the transcript instead. */
export function isPreviousResponseError(message: string): boolean {
  return /previous_response/i.test(message);
}

/** A tool type this endpoint/model does not know (web_search vs _preview). */
export function isToolTypeError(message: string): boolean {
  return /tool|tools\[/i.test(message) && /type|not supported|unsupported|invalid/i.test(message);
}

/** JSON.parse that returns null instead of throwing, tolerating a fenced block. */
export function safeJsonParse(text: string | null | undefined): unknown | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
