/**
 * The wire protocol between the assistant's streaming endpoint and the UI.
 *
 * `/api/assistant/chat` answers in one shot (still used as a fallback and by
 * anything that just wants a reply). `/api/assistant/stream` sends the same
 * work as it happens — which tool it is running, each artifact the moment it
 * exists, and the reply token by token — so a full-screen workspace can show
 * progress instead of a spinner.
 *
 * Framework-free and server-safe: both the route and the browser import it.
 *
 * Transport: `text/event-stream`, one JSON object per `data:` line.
 */

import type { AssistantCard } from "@/lib/assistant-cards";
import type { Artifact } from "@/lib/assistant-artifacts";

/**
 * What a tool did, surfaced as a chip in the transcript. Structurally the
 * same as the server-side `ToolEvent` in `@/lib/ai/tools`, declared here so
 * the browser can import it without pulling in a "server-only" module.
 */
export type AssistantEvent = {
  kind: "read" | "created" | "updated";
  label: string;
  href?: string;
};

/** A tool call in flight, shown as a live step in the activity trail. */
export type ToolStep = {
  /** The model's tool_call id — stable across start and end. */
  id: string;
  /** Tool name, e.g. "list_clients". */
  name: string;
  /** Human label, e.g. "Reading clients". */
  label: string;
  state: "running" | "done" | "error";
  /** Set on completion. */
  event?: AssistantEvent;
  error?: string;
};

export type AssistantStreamEvent =
  /** The model is composing (no tool running). */
  | { type: "status"; status: "thinking" | "working" }
  /** A tool call started. */
  | { type: "tool_start"; id: string; name: string; label: string }
  /** A tool call finished. */
  | {
      type: "tool_end";
      id: string;
      name: string;
      ok: boolean;
      event?: AssistantEvent;
      error?: string;
    }
  /** A document for the preview canvas. */
  | { type: "artifact"; artifact: Artifact }
  /** An inline transcript card (invoice/SMS confirmations, etc.). */
  | { type: "card"; card: AssistantCard }
  /** A chunk of the spoken/written reply. */
  | { type: "delta"; text: string }
  /** Terminal success — carries the assembled reply for TTS and history. */
  | { type: "done"; reply: string }
  /** Terminal failure. */
  | { type: "error"; error: string };

/** Serialise one event as an SSE frame. */
export function sseFrame(event: AssistantStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Turn a raw SSE body into events. Feed it chunks of decoded text; it returns
 * the events completed by that chunk and keeps any partial frame buffered.
 */
export function createSseParser(): (chunk: string) => AssistantStreamEvent[] {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const out: AssistantStreamEvent[] = [];
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          out.push(JSON.parse(payload) as AssistantStreamEvent);
        } catch {
          // A malformed frame is dropped rather than killing the stream.
        }
      }
      index = buffer.indexOf("\n\n");
    }
    return out;
  };
}

/** Readable label for a tool name, used when a tool doesn't supply one. */
export function defaultToolLabel(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
