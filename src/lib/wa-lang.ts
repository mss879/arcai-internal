/**
 * Language detection + labels for the WhatsApp agent — plain data and pure
 * functions, safe on client AND server (the inbox renders the labels).
 *
 * Detection is layered, cheapest first:
 *   1. Native Sinhala/Tamil script → detectScriptLanguage (Unicode ranges,
 *      deterministic, runs in the webhook on every inbound text).
 *   2. Romanized "Singlish"/"Tanglish" → the agent itself calls the
 *      set_language tool when it recognizes it (it reads every message
 *      anyway — no extra LLM cost).
 *   3. Voice notes → Whisper's verbose_json detected language.
 */

import type { WaLanguage } from "@/lib/database.types";

export const WA_LANGUAGE_LABELS: Record<WaLanguage, string> = {
  en: "English",
  si: "සිංහල Sinhala",
  ta: "தமிழ் Tamil",
  "si-latn": "Singlish",
  "ta-latn": "Tanglish",
};

export const WA_LANGUAGES: WaLanguage[] = ["en", "si", "ta", "si-latn", "ta-latn"];

export function isWaLanguage(value: unknown): value is WaLanguage {
  return typeof value === "string" && (WA_LANGUAGES as string[]).includes(value);
}

/** The underlying spoken language, romanized or not — the ISO-639-1 hint
 * Whisper wants ("si-latn" speech is still Sinhala). */
export function baseLanguage(lang: WaLanguage): "en" | "si" | "ta" {
  return lang === "si-latn" ? "si" : lang === "ta-latn" ? "ta" : lang;
}

/**
 * Native-script detection: Sinhala U+0D80–0DFF, Tamil U+0B80–0BFF.
 * Returns 'si'/'ta' when the text clearly uses that script (≥3 chars, or
 * ≥30% of its letters on very short messages); null for Latin/other text —
 * this NEVER claims "English", romanized Sinhala/Tamil is Latin too.
 */
export function detectScriptLanguage(text: string): "si" | "ta" | null {
  const si = (text.match(/[\u0D80-\u0DFF]/g) ?? []).length;
  const ta = (text.match(/[\u0B80-\u0BFF]/g) ?? []).length;
  if (si === 0 && ta === 0) return null;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const best = si >= ta ? ("si" as const) : ("ta" as const);
  const count = Math.max(si, ta);
  return count >= 3 || (letters > 0 && count / letters >= 0.3) ? best : null;
}

/** Whisper's verbose_json reports full names ("sinhala") — map to our codes. */
export function whisperLanguageToCode(
  language: string | null | undefined,
): "en" | "si" | "ta" | null {
  const l = (language ?? "").trim().toLowerCase();
  if (l === "sinhala" || l === "si") return "si";
  if (l === "tamil" || l === "ta") return "ta";
  if (l === "english" || l === "en") return "en";
  return null;
}
