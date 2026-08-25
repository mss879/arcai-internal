/**
 * The assistant's streaming endpoint.
 *
 * `/api/assistant/chat` runs the same loop and answers once, at the end. That
 * is fine for the mobile voice screen, where the reply is spoken anyway, but
 * the full-screen workspace has a preview canvas and an activity trail to
 * fill, and both of those are interesting *while* the work happens: which
 * tool is running, each document the moment it exists, the reply as it is
 * written. So this route sends the same work as a stream of SSE frames
 * described by `@/lib/assistant-stream`, and the client falls back to the
 * one-shot route only if this one produces nothing at all.
 *
 * Two rules shape the error handling below. First, a half-written SSE frame
 * is worse than no frame — a client parsing `data:` lines cannot recover from
 * one — so every failure is reported as a complete `error` event rather than
 * by tearing the connection down mid-write. Second, the controller must be
 * closed exactly once on every path, including the one where the user
 * navigated away and `enqueue` is already throwing.
 */

import { NextResponse } from "next/server";

import { assistantSystemPrompt, type AssistantMode } from "@/lib/ai/assistant-prompt";
import { isOpenAIConfigured, type ChatMessage } from "@/lib/ai/openai";
import { openaiChatStream } from "@/lib/ai/openai-stream";
import {
  ALL_ASSISTANT_TOOLS,
  executeAssistantTool,
  toolLabel,
} from "@/lib/ai/tool-registry";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import { sseFrame, type AssistantStreamEvent } from "@/lib/assistant-stream";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Matches the one-shot route: enough headroom for a read-then-write chain. */
const MAX_TOOL_TURNS = 10;

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isOpenAIConfigured()) {
    return NextResponse.json(
      { error: "Voice assistant is not configured. Add OPENAI_API_KEY." },
      { status: 503 },
    );
  }

  // Everything that can fail with a normal status code is done before the
  // stream opens — once the headers say `text/event-stream`, a JSON error
  // body is no longer something the client will read.
  let history: { role: string; content: string }[] = [];
  let mode: AssistantMode = "voice";
  try {
    const body = await request.json();
    if (Array.isArray(body?.messages)) history = body.messages;
    if (body?.mode === "text" || body?.mode === "voice") mode = body.mode;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createClient();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
  }).format(new Date());

  const ctx: ToolContext = { supabase, userId: profile.id, today };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: assistantSystemPrompt({ name: profile.full_name, today, mode }),
    },
    ...history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: String(m.content ?? ""),
      })),
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Flips as soon as writing becomes impossible — a closed controller, or
      // a client that hung up. Guards every later `send` so one dead write
      // does not turn into an exception storm.
      let writable = true;

      const send = (event: AssistantStreamEvent) => {
        if (!writable) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          writable = false;
        }
      };

      // Each model turn's text, joined at the end. Kept per turn rather than
      // as one running string so a "let me check that" preamble and the real
      // answer after the tools don't end up welded together.
      const spoken: string[] = [];

      /** Stream one model turn, remembering anything it said. */
      const speakTurn = async (withTools: boolean) => {
        let text = "";
        const assistant = await openaiChatStream(
          messages,
          withTools ? ALL_ASSISTANT_TOOLS : undefined,
          undefined,
          (chunk) => {
            text += chunk;
            send({ type: "delta", text: chunk });
          },
        );
        if (text.trim()) spoken.push(text.trim());
        return assistant;
      };

      try {
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          send({ type: "status", status: "thinking" });

          const assistant = await speakTurn(true);
          messages.push(assistant);

          const toolCalls = assistant.tool_calls ?? [];
          if (!toolCalls.length) {
            send({ type: "done", reply: spoken.join("\n\n") });
            return;
          }

          send({ type: "status", status: "working" });

          for (const call of toolCalls) {
            const name = call.function.name;
            send({ type: "tool_start", id: call.id, name, label: toolLabel(name) });

            let args: Record<string, unknown> = {};
            try {
              args = call.function.arguments
                ? JSON.parse(call.function.arguments)
                : {};
            } catch {
              args = {};
            }

            let result: ToolResult;
            let failure: string | null = null;
            try {
              result = await executeAssistantTool(name, args, ctx);
            } catch (err) {
              failure = (err as Error).message;
              result = { content: { ok: false, error: failure } };
            }

            // Cards and artifacts go out before `tool_end` so the canvas has
            // the document by the time the step stops spinning.
            if (result.card) send({ type: "card", card: result.card });
            for (const artifact of result.artifacts ?? []) {
              send({ type: "artifact", artifact });
            }

            send({
              type: "tool_end",
              id: call.id,
              name,
              ok: !failure,
              ...(result.event ? { event: result.event } : {}),
              ...(failure ? { error: failure } : {}),
            });

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result.content),
            });
          }
        }

        // Out of tool turns. One last pass with no tools so the user gets a
        // sentence rather than silence after all that work.
        send({ type: "status", status: "thinking" });
        await speakTurn(false);
        send({ type: "done", reply: spoken.join("\n\n") });
      } catch (error) {
        console.error("Assistant stream error:", error);
        send({ type: "error", error: "The assistant ran into a problem." });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed or errored — nothing left to do.
        }
        writable = false;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // Nginx and friends buffer a response by default, which would hold
      // every frame back until the turn ended — the exact thing this route
      // exists to avoid.
      "X-Accel-Buffering": "no",
    },
  });
}
