import "server-only";

import { AI_MODELS, isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";
import { cleanNoticeBody } from "@/lib/notice";

/**
 * Turns whatever the user dictated or typed ("tell them the site will be down
 * saturday night for the upgrade, sorry") into the formal prose that goes in
 * the middle of the notice template.
 *
 * Deliberately defaults to the fast chat model rather than a reasoning model:
 * a human is sitting there waiting for this, it's a rewrite rather than a hard
 * reasoning problem, and the whole call has to finish inside Netlify's ~30s
 * serverless budget. Override per-env if the copy needs more muscle.
 */
const MODEL = process.env.OPENAI_NOTICE_MODEL || AI_MODELS.chat;

/** Interactive flow — fail into an editable draft rather than hang the button. */
const TIMEOUT_MS = Number(process.env.OPENAI_NOTICE_TIMEOUT_MS || 25_000);

export type DraftNoticeInput = {
  /** What the user said or typed — the raw intent. */
  rawInput: string;
  /** Who it's addressed to, if known — lets the AI pitch the tone. */
  toName?: string;
  /** An existing subject to keep, if the user already wrote one. */
  subject?: string;
};

export type DraftedNotice = { subject: string; body: string };

const SYSTEM = `You are the office manager for ARC AI (PVT) LTD, a premium web studio. You turn a director's rough spoken notes into the body of a formal written notice sent to a client on company letterhead.

Write clear, courteous, professional British-English business prose. Be direct and specific. Keep it short — a notice is not an essay.

HARD RULES:
- Preserve every concrete fact from the notes: dates, times, amounts, names, deadlines. Never invent facts, dates, figures or commitments that are not in the notes.
- If the notes are vague, stay vague. Do not fabricate specifics to fill space.
- Do NOT write a greeting ("Dear ...") — the letterhead prints one already.
- Do NOT write a sign-off ("Sincerely", "Regards", a name) — the letterhead prints a signed one already.
- Do NOT mention letterhead, contact details or bank details; those are printed around your text.
- No markdown, no bullet characters, no headings. Plain paragraphs only.
- Output ONLY a single JSON object matching the requested schema.`;

function userPrompt(input: DraftNoticeInput): string {
  const to = input.toName?.trim()
    ? `The notice is addressed to: ${input.toName.trim()}\n`
    : "";
  const subj = input.subject?.trim()
    ? `The director already chose this subject line — keep it, do not replace it: "${input.subject.trim()}"\n`
    : "";

  return `${to}${subj}
The director's rough notes (dictated — may ramble, may have transcription slips; interpret the intent):
"""
${input.rawInput.trim()}
"""

Return a JSON object with EXACTLY these keys:
{
  "subject": "a short subject line in Title Case, max 8 words, naming what this notice is about",
  "body": "the notice body: 1-3 short paragraphs separated by \\n\\n"
}

Guidance:
- Open by stating the point of the notice in the first sentence. No throat-clearing.
- Close the final paragraph with a courteous line inviting the client to get in touch with questions — but no sign-off name.
- Total body: roughly 60-160 words.`;
}

/** True when notice drafting can run (same key as the rest of the AI features). */
export function isNoticeAIConfigured(): boolean {
  return isOpenAIConfigured();
}

/**
 * Draft the notice. Throws on a missing key, a model error or a timeout — the
 * caller surfaces that and leaves the user's raw text in the box to edit by
 * hand, so a bad AI day never blocks sending a notice.
 */
export async function draftNotice(
  input: DraftNoticeInput,
): Promise<DraftedNotice> {
  if (!input.rawInput?.trim()) {
    throw new Error("Nothing to write about yet.");
  }

  const raw = await openaiChatJSON(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(input) },
    ],
    { model: MODEL, temperature: 0.4, timeoutMs: TIMEOUT_MS },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The AI returned something unreadable. Try again.");
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const body = cleanNoticeBody(
    typeof obj.body === "string" ? obj.body : "",
  );
  if (!body) throw new Error("The AI returned an empty notice. Try again.");

  const subject =
    input.subject?.trim() ||
    (typeof obj.subject === "string" ? obj.subject.trim() : "");

  return { subject, body };
}
