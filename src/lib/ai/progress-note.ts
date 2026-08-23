import "server-only";

import { isOpenAIConfigured, openaiVisionJSON } from "@/lib/ai/openai";

/**
 * A screenshot becomes an update (AI-5).
 *
 * The work actually happens in a browser or a design tool. What gets skipped
 * is the part after: telling the client, and leaving a note the next person
 * can read. Both are five minutes of writing that nobody does at 7pm.
 *
 * Drop the screenshot you already took. Get back two texts — one for the
 * client, one for the team. Drafts, never sends: the same contract as
 * receipt.ts (MON-8) and draft_client_update (AUTO-2).
 */

export type ProgressNote = {
  /** Warm, plain, sendable — what the client would want to read. */
  client_update: string;
  /** Factual, specific — what the next person on the job needs to know. */
  internal_note: string;
  /** 3-8 words for the delivery-event line. */
  headline: string;
  /** True when the image doesn't look like project work at all. */
  off_topic: boolean;
};

function prompt(context: string): string {
  return `You are looking at a screenshot of work in progress at ARC AI, a digital agency in Sri Lanka.

${context}

Return STRICT JSON with exactly these keys:
{
  "headline": string,        // 3-8 words naming what is shown, e.g. "Homepage hero and nav built"
  "client_update": string,   // 2-4 sentences TO THE CLIENT: warm, plain, no jargon, no markdown, no emoji. Say what is now done and what happens next.
  "internal_note": string,   // 1-3 sentences for the team: specific and factual, including anything visibly unfinished or broken.
  "off_topic": boolean       // true if this is clearly not project work (a meme, a random photo, a screenshot of this app)
}

Rules:
- Describe ONLY what is visible. Never claim a feature works if the screenshot just shows it exists.
- If something looks unfinished, broken or placeholder (lorem ipsum, missing images, an error), say so in internal_note — and do NOT mention it in client_update as if it were finished.
- Never mention money, margin, internal costs or deadlines you were not given.
- If off_topic is true, leave client_update and internal_note as empty strings.
- Output JSON only.`;
}

/**
 * Read a screenshot into a client update and an internal note.
 *
 * `imageUrl` may be a data: URL, so a screenshot that turns out to be the
 * wrong one never leaves a stray object in storage.
 */
export async function readProgressScreenshot(
  imageUrl: string,
  context?: { projectName?: string; stage?: string | null; note?: string },
): Promise<{ ok: true; note: ProgressNote } | { ok: false; error: string }> {
  if (!isOpenAIConfigured())
    return { ok: false, error: "OPENAI_API_KEY is not configured." };

  const lines = [
    context?.projectName ? `The project is "${context.projectName}".` : "",
    context?.stage ? `It is currently at the "${context.stage}" stage.` : "",
    context?.note ? `The person sending this added: "${context.note}"` : "",
  ].filter(Boolean);

  try {
    const raw = await openaiVisionJSON(
      imageUrl,
      prompt(lines.join(" ") || "You have no other context about the project."),
      { timeoutMs: 45_000 },
    );
    const r = JSON.parse(raw) as Record<string, unknown>;

    const note: ProgressNote = {
      headline: typeof r.headline === "string" ? r.headline.trim().slice(0, 120) : "",
      client_update:
        typeof r.client_update === "string" ? r.client_update.trim().slice(0, 1200) : "",
      internal_note:
        typeof r.internal_note === "string" ? r.internal_note.trim().slice(0, 1200) : "",
      off_topic: r.off_topic === true,
    };

    if (note.off_topic)
      return {
        ok: false,
        error:
          "That doesn't look like project work — try a screenshot of the build itself.",
      };
    if (!note.client_update && !note.internal_note)
      return { ok: false, error: "Nothing could be read from that image." };

    return { ok: true, note };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The screenshot could not be read.",
    };
  }
}
