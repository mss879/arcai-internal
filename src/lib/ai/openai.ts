import "server-only";

import {
  effortParam,
  isReasoningModel,
  reasoningEffortFor,
} from "./reasoning-core";

/**
 * Thin wrapper around the OpenAI REST API used by the voice assistant.
 *
 * We talk to OpenAI over plain `fetch` (no SDK dependency) so the feature
 * works the instant an `OPENAI_API_KEY` is present — nothing to install.
 * Every call here is server-only; the key never reaches the browser, exactly
 * like the Supabase service-role key.
 *
 * All model names are overridable via env so you can tune cost/quality
 * without touching code.
 */

const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

export const AI_MODELS = {
  /** Drives the conversation + tool calling. */
  chat: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  /** Speech -> text. */
  transcribe: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
  /** Text -> speech. */
  tts: process.env.OPENAI_TTS_MODEL || "tts-1",
  /** The spoken voice. alloy | echo | fable | onyx | nova | shimmer */
  voice: process.env.OPENAI_TTS_VOICE || "alloy",
} as const;

/** True when an OpenAI key is configured. */
export function isOpenAIConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Reasoning models take `reasoning_effort` where the others take
 * `temperature`, and which values each accepts depends on whether the request
 * also carries function tools. All of that lives in `reasoning-core.ts`,
 * which is pure so the rules can be pinned by tests; it is re-exported here
 * because this module has always been where callers look for it.
 */
export { effortParam, isReasoningModel, reasoningEffortFor };

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  return key;
}

// ---- Chat / tool calling -------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Token usage for one call, as the API reports it.
 *
 * `promptTokens` INCLUDES `cachedTokens`: the billed input is
 * (prompt − cached) at the input price plus cached at the cached price.
 * `completionTokens` includes reasoning tokens on reasoning models.
 */
export type ChatUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
};

/** Pull the usage object out of a chat-completions body (or a stream's final
 * frame). Null when the body carries none. */
export function readUsage(json: unknown): ChatUsage | null {
  const usage = (json as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    cachedTokens: num(details?.cached_tokens),
  };
}

/**
 * Thrown when the API refuses a request outright — a bad model name, a
 * parameter this model does not take, a malformed body, an auth failure, a
 * fault on their side. Distinct from a call that ran and was cut off, and the
 * distinction is money: nothing was generated here, so OpenAI charged nothing,
 * so a caller that meters tokens must not estimate any for it.
 */
export class OpenAIRequestError extends Error {
  readonly status: number;
  constructor(status: number, detail: string, what = "chat") {
    // Same text as the plain Error it replaces — logs and captured errors
    // that already exist keep reading exactly as they did.
    super(`OpenAI ${what} failed (${status}): ${detail}`);
    this.name = "OpenAIRequestError";
    this.status = status;
  }
}

/** Thrown on a 429 so callers can wait the server's own retry window
 * instead of guessing (or, worse, dropping the work). */
export class OpenAIRateLimitError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "OpenAIRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Ceiling on any single chat round-trip. Finite by default on purpose: an
 * opt-in timeout leaves every un-migrated caller able to hang a serverless
 * invocation forever. 20s by default because the deployed platform kills the
 * whole invocation at ~26s — a 45s "timeout" was really "wait to be killed,
 * billed for the tokens, with nothing persisted". Callers with real room
 * (background jobs, local dev) pass their own timeoutMs. */
const CHAT_TIMEOUT_MS = Number(process.env.OPENAI_CHAT_TIMEOUT_MS) || 20_000;

/** One round-trip to chat completions. Returns the assistant message. */
export async function openaiChat(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  opts?: {
    model?: string;
    timeoutMs?: number;
    temperature?: number;
    /** Only used by reasoning models: minimal | low | medium | high | xhigh.
     * Without it a gpt-5/o-series model runs at the provider's own default
     * effort — noticeably slower than the caller usually wants. */
    reasoningEffort?: string;
  },
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
      // Factual/deterministic by default — this assistant must not improvise
      // data. Conversational callers (the WhatsApp sales agent) pass their own
      // temperature so every lead doesn't get a byte-identical reply.
      // (Reasoning models reject temperature — they take reasoning_effort,
      // and which values they accept depends on the tools below.)
      ...(isReasoningModel(model)
        ? effortParam(reasoningEffortFor(model, opts?.reasoningEffort, Boolean(tools?.length)))
        : { temperature: opts?.temperature ?? 0 }),
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
    throw new OpenAIRequestError(res.status, detail);
  }

  const json = await res.json();
  const message = json?.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI chat returned no message.");
  return message as ChatMessage;
}

/**
 * One round-trip that asks the model for a strict JSON object back.
 * Used by the proposal generator. Returns the raw JSON string (the caller
 * parses + validates it). Defaults to a little creative temperature since
 * this writes prose, unlike the deterministic assistant above.
 */
export async function openaiChatJSON(
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    model?: string;
    timeoutMs?: number;
    /** Only used by reasoning models: minimal | low | medium | high | xhigh. */
    reasoningEffort?: string;
  },
): Promise<string> {
  const model = opts?.model || AI_MODELS.chat;
  const reasoning = isReasoningModel(model);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    // Finite by default: a caller that forgets a timeout used to be able to
    // hang a serverless invocation forever on one stuck request. 60s covers
    // the JSON-writing calls this helper serves; heavier callers (the
    // proposal writer) pass their own, larger ceiling.
    signal: AbortSignal.timeout(Math.max(1_000, opts?.timeoutMs ?? 60_000)),
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      // Reasoning models reject temperature; they take reasoning_effort instead.
      ...(reasoning
        ? effortParam(reasoningEffortFor(model, opts?.reasoningEffort || "medium", false))
        : { temperature: opts?.temperature ?? 0.6 }),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new OpenAIRequestError(res.status, detail);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content.");
  return content as string;
}

// ---- Background responses (long reasoning, polled) ------------------------

/**
 * Start a Responses API call in background mode and return at once.
 *
 * For the calls that take minutes — a high-effort reasoning model over a
 * whole analytics export — a synchronous request is impossible here: the
 * deployed platform kills the invocation at ~26s, and a killed call is
 * billed for the tokens with nothing persisted. Background mode hands the
 * work to OpenAI and gives back an id; `openaiResponsePoll` reads the
 * answer later, from any invocation — the tick, a page poll, a retry.
 */
export async function openaiResponseStart(
  input: { instructions: string; input: string },
  opts: {
    model: string;
    /** Only used by reasoning models: minimal | low | medium | high | xhigh. */
    reasoningEffort?: string;
    /** Ask for a JSON object back (the prompt must mention JSON). */
    json?: boolean;
    timeoutMs?: number;
  },
): Promise<{ id: string; status: string }> {
  const model = opts.model.trim();
  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    signal: AbortSignal.timeout(Math.max(1_000, opts.timeoutMs ?? 15_000)),
    body: JSON.stringify({
      model,
      background: true,
      store: true,
      instructions: input.instructions,
      input: input.input,
      ...(isReasoningModel(model) && opts.reasoningEffort
        ? { reasoning: { effort: opts.reasoningEffort } }
        : {}),
      ...(opts.json ? { text: { format: { type: "json_object" } } } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI responses failed (${res.status}): ${detail}`);
  }
  const json = await res.json();
  if (!json?.id) throw new Error("OpenAI responses returned no id.");
  return { id: String(json.id), status: String(json.status ?? "queued") };
}

export type BackgroundResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

/** Read a background response: its status, and its text once it has one. */
export async function openaiResponsePoll(
  id: string,
  opts?: { timeoutMs?: number },
): Promise<{ status: BackgroundResponseStatus; text: string | null; error: string | null }> {
  const res = await fetch(`${BASE_URL}/responses/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(Math.max(1_000, opts?.timeoutMs ?? 15_000)),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI responses poll failed (${res.status}): ${detail}`);
  }
  const json = await res.json();
  const status = String(json?.status ?? "failed") as BackgroundResponseStatus;

  // The REST body carries the answer as message items; `output_text` is an
  // SDK convenience that is not on the wire.
  let text: string | null = null;
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          text = (text ?? "") + part.text;
        }
      }
    }
  }
  const error =
    (typeof json?.error?.message === "string" && json.error.message) ||
    (typeof json?.incomplete_details?.reason === "string" &&
      `incomplete: ${json.incomplete_details.reason}`) ||
    null;
  return { status, text, error };
}

// ---- Vision (image -> structured JSON) ------------------------------------

/**
 * Ask a vision-capable model to analyze one image and answer with a strict
 * JSON object. Standalone on purpose — the plain-string ChatMessage type
 * used everywhere else stays untouched. The image can be a public URL or a
 * data: URI. Model override via OPENAI_VISION_MODEL (the default chat model
 * gpt-4o-mini is vision-capable).
 */
export async function openaiVisionJSON(
  imageUrl: string,
  prompt: string,
  opts?: {
    model?: string;
    timeoutMs?: number;
    /** 0126 — receives the token usage so the caller can meter the call. */
    onUsage?: (usage: ChatUsage) => void;
  },
): Promise<string> {
  const model =
    opts?.model?.trim() ||
    process.env.OPENAI_VISION_MODEL?.trim() ||
    AI_MODELS.chat;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      ...(isReasoningModel(model) ? {} : { temperature: 0 }),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new OpenAIRequestError(res.status, detail, "vision");
  }

  const json = await res.json();
  // Meter before checking the content: an empty answer was still paid for.
  const usage = readUsage(json);
  if (usage) opts?.onUsage?.(usage);
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI vision returned no content.");
  return content as string;
}

// ---- Embeddings ------------------------------------------------------------

/** The embedding model. 1536 dimensions for text-embedding-3-small, which is
 * what `ai_kb_chunks.embedding vector(1536)` (0126) is sized for — switching
 * to a model with another width needs a new column, not just a new name. */
export const EMBED_MODEL =
  process.env.OPENAI_EMBED_MODEL?.trim() || "text-embedding-3-small";

/** Inputs per call. The API takes up to 2048; 64 keeps one call comfortably
 * inside a serverless step even for long chunks. */
export const EMBED_BATCH_MAX = 64;

export type EmbedResult = {
  /** One vector per input, in input order. */
  vectors: number[][];
  /** Tokens the API counted for the whole batch — the number that is billed. */
  totalTokens: number;
  model: string;
};

/**
 * Embed a batch of texts. One round-trip, vectors in input order.
 *
 * Throws on an empty string (the API rejects it and the batch with it) and
 * on a batch over `EMBED_BATCH_MAX` — the caller chunks, this does not.
 * @throws {OpenAIRateLimitError} on a 429, carrying the server's retry window.
 */
export async function openaiEmbed(
  texts: string[],
  opts?: { model?: string; timeoutMs?: number },
): Promise<EmbedResult> {
  const model = opts?.model?.trim() || EMBED_MODEL;
  const inputs = texts.map((t) => t.trim());
  if (!inputs.length) return { vectors: [], totalTokens: 0, model };
  if (inputs.some((t) => !t)) {
    throw new Error("openaiEmbed: an empty string cannot be embedded.");
  }
  if (inputs.length > EMBED_BATCH_MAX) {
    throw new Error(`openaiEmbed: at most ${EMBED_BATCH_MAX} inputs per call.`);
  }

  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    signal: AbortSignal.timeout(Math.max(1_000, opts?.timeoutMs ?? 20_000)),
    body: JSON.stringify({ model, input: inputs, encoding_format: "float" }),
  });

  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const seconds = header ? Number(header) : NaN;
      throw new OpenAIRateLimitError(
        `OpenAI embeddings rate-limited: ${detail}`,
        Number.isFinite(seconds) ? seconds * 1000 : null,
      );
    }
    throw new OpenAIRequestError(res.status, detail, "embeddings");
  }

  const json = await res.json();
  const data: unknown[] = Array.isArray(json?.data) ? json.data : [];
  // Items carry an `index`; place by it rather than trusting array order.
  const vectors: number[][] = new Array(inputs.length);
  for (const raw of data) {
    const item = raw as { index?: number; embedding?: unknown };
    if (
      typeof item?.index === "number" &&
      item.index >= 0 &&
      item.index < inputs.length &&
      Array.isArray(item.embedding)
    ) {
      vectors[item.index] = item.embedding as number[];
    }
  }
  if (vectors.some((v) => !v)) {
    throw new Error("OpenAI embeddings returned fewer vectors than inputs.");
  }
  return {
    vectors,
    totalTokens: Number(json?.usage?.total_tokens) || 0,
    model,
  };
}

// ---- Transcription (speech -> text) --------------------------------------

export async function openaiTranscribe(
  audio: Blob,
  filename = "audio.webm",
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", AI_MODELS.transcribe);

  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI transcription failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  return (json?.text ?? "").toString();
}

/**
 * Transcription that also returns Whisper's detected language ("sinhala",
 * "tamil", "english", …). verbose_json is whisper-1-only — on other
 * transcribe models this degrades to a plain transcription with language
 * null. An ISO-639-1 `languageHint` (e.g. "si") from a known contact
 * noticeably improves short-clip accuracy.
 */
export async function openaiTranscribeVerbose(
  audio: Blob,
  filename = "audio.webm",
  opts?: { languageHint?: string },
): Promise<{ text: string; language: string | null }> {
  const model = AI_MODELS.transcribe;
  const verbose = model === "whisper-1";
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  if (verbose) form.append("response_format", "verbose_json");
  if (opts?.languageHint?.trim()) form.append("language", opts.languageHint.trim());

  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI transcription failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  return {
    text: (json?.text ?? "").toString(),
    language: verbose && json?.language ? String(json.language) : null,
  };
}

// ---- Text to speech ------------------------------------------------------

export async function openaiSpeech(
  text: string,
  opts?: { instructions?: string },
): Promise<ArrayBuffer> {
  const model = AI_MODELS.tts;
  const res = await fetch(`${BASE_URL}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model,
      voice: AI_MODELS.voice,
      input: text,
      response_format: "mp3",
      // Speaking-style steering exists only on the newer TTS models —
      // the classic tts-1/tts-1-hd reject the param outright.
      ...(opts?.instructions?.trim() && !/^tts-1/.test(model)
        ? { instructions: opts.instructions.trim() }
        : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI speech failed (${res.status}): ${detail}`);
  }

  return res.arrayBuffer();
}
