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

/** One round-trip to chat completions. Returns the assistant message. */
export async function openaiChat(
  messages: ChatMessage[],
  tools?: ToolSchema[],
): Promise<ChatMessage> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: AI_MODELS.chat,
      messages,
      // Keep it factual/deterministic — this assistant must not improvise data.
      temperature: 0,
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI chat failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  const message = json?.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI chat returned no message.");
  return message as ChatMessage;
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

// ---- Text to speech ------------------------------------------------------

export async function openaiSpeech(text: string): Promise<ArrayBuffer> {
  const res = await fetch(`${BASE_URL}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: AI_MODELS.tts,
      voice: AI_MODELS.voice,
      input: text,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI speech failed (${res.status}): ${detail}`);
  }

  return res.arrayBuffer();
}
