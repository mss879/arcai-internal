import "server-only";

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
 * Reasoning models (o-series + GPT-5 family) behave differently on the Chat
 * Completions API: they REJECT `temperature`/`top_p` (400 error) and take an
 * optional `reasoning_effort` instead. Detect them by name so the caller can't
 * accidentally send a param that fails the whole request.
 */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model.trim());
}

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
      // (Reasoning models reject temperature — they take reasoning_effort.)
      ...(isReasoningModel(model)
        ? opts?.reasoningEffort
          ? { reasoning_effort: opts.reasoningEffort }
          : {}
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
    throw new Error(`OpenAI chat failed (${res.status}): ${detail}`);
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
        ? { reasoning_effort: opts?.reasoningEffort || "medium" }
        : { temperature: opts?.temperature ?? 0.6 }),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI chat failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content.");
  return content as string;
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
  opts?: { model?: string; timeoutMs?: number },
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
    throw new Error(`OpenAI vision failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI vision returned no content.");
  return content as string;
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
