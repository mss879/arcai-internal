/**
 * The widget ↔ chat route wire format (0126).
 *
 * Server-sent events, one JSON object per `data:` line. Framework-free on
 * purpose: the route imports `sseFrame`, the CRM's own preview and tests
 * import `createSseParser`, and `public/ai-widget.js` carries a hand-ported
 * copy of the parser (it cannot import from here).
 *
 * The frames, in the order a turn sends them:
 *
 *   meta    → the conversation id and the session key the server settled on
 *   delta   → a chunk of the reply, in order
 *   tool    → a tool is running ("Saving your details…")
 *   action  → something the widget should render: a booking button, a
 *             "details saved" tick, a "someone will follow up" note
 *   done    → the whole reply, for the transcript restore
 *   error   → terminal failure; `code` picks the widget's copy
 *   ping    → keep-alive while a tool runs
 *
 * Every turn ends with exactly one `done` or one `error`.
 */

export type AiActionKind = "booking" | "lead_saved" | "handoff_done";

export type AiErrorCode =
  | "bad_request"
  | "forbidden"
  | "disabled"
  | "rate_limited"
  | "busy"
  | "session_full"
  | "failed";

export type AiStreamEvent =
  | { type: "meta"; conversation: string; session: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; label: string }
  | { type: "action"; kind: AiActionKind; url?: string }
  | { type: "done"; reply: string }
  | { type: "error"; code: AiErrorCode; message: string; retryAfter?: number }
  | { type: "ping" };

/** Serialise one event as an SSE frame. */
export function sseFrame(event: AiStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Turn a raw SSE body into events. Feed it chunks of decoded text; it
 * returns the events completed by that chunk and keeps a partial frame
 * buffered until the rest arrives.
 */
export function createSseParser(): (chunk: string) => AiStreamEvent[] {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const out: AiStreamEvent[] = [];
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload) as AiStreamEvent;
          if (parsed && typeof parsed === "object" && typeof parsed.type === "string") out.push(parsed);
        } catch {
          // A malformed frame is dropped rather than killing the stream.
        }
      }
      index = buffer.indexOf("\n\n");
    }
    return out;
  };
}

/** The copy the widget shows for each error code. Kept here so the route,
 * the preview and the widget agree on the words. */
export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  bad_request: "That message couldn't be sent. Please try again.",
  forbidden: "This assistant isn't available on this website.",
  disabled: "This assistant is taking a break right now.",
  rate_limited: "I'm getting a lot of questions at once — please try again in a moment.",
  busy: "I've reached today's limit for conversations. Please leave your details and the team will get back to you.",
  session_full: "This chat has run long — start a new chat to keep going.",
  failed: "Something went wrong on my side. Please try again.",
};
