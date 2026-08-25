/**
 * The assistant's one-shot endpoint.
 *
 * `/api/assistant/stream` is the richer path — it reports each tool and each
 * artifact as it happens. This one runs the identical loop with the identical
 * prompt and tools, then answers in a single JSON body. It stays because the
 * mobile voice screen has nothing to do with a half-finished reply, and
 * because it is the fallback the workspace uses when the stream never starts.
 *
 * Whatever changes here must change there too, which is why the prompt lives
 * in `@/lib/ai/assistant-prompt` and the tools in `@/lib/ai/tool-registry`
 * rather than in either route.
 */

import { NextResponse } from "next/server";

import { assistantSystemPrompt } from "@/lib/ai/assistant-prompt";
import { isOpenAIConfigured, openaiChat, type ChatMessage } from "@/lib/ai/openai";
import { ALL_ASSISTANT_TOOLS, executeAssistantTool } from "@/lib/ai/tool-registry";
import type { ToolContext, ToolEvent, ToolResult } from "@/lib/ai/tools";
import type { Artifact } from "@/lib/assistant-artifacts";
import type { AssistantCard } from "@/lib/assistant-cards";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Proposal conversations chain more calls than an invoice does (read the
// pricing, write it, then revise it), and the wider tool set adds reads
// before those writes — so there's a little more headroom here.
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

  try {
    const body = await request.json();
    const history: { role: string; content: string }[] = Array.isArray(
      body?.messages,
    )
      ? body.messages
      : [];

    const supabase = await createClient();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Colombo",
    }).format(new Date());

    const ctx: ToolContext = { supabase, userId: profile.id, today };

    const messages: ChatMessage[] = [
      {
        role: "system",
        // This route is the spoken one, so it keeps the strict voice style —
        // the streaming route passes the caller's own mode.
        content: assistantSystemPrompt({
          name: profile.full_name,
          today,
          mode: "voice",
        }),
      },
      ...history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: String(m.content ?? ""),
        })),
    ];

    const events: ToolEvent[] = [];
    const cards: AssistantCard[] = [];
    // The preview canvas is fed by the streaming route, but a fallback turn
    // still has to hand its documents over — otherwise the same question
    // answers with a table one time and with nothing the next.
    const artifacts: Artifact[] = [];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const assistant = await openaiChat(messages, ALL_ASSISTANT_TOOLS);
      messages.push(assistant);

      const toolCalls = assistant.tool_calls ?? [];
      if (!toolCalls.length) {
        return NextResponse.json({
          reply: assistant.content ?? "",
          events,
          cards,
          artifacts,
        });
      }

      // Run every requested tool, then feed results back to the model.
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments
            ? JSON.parse(call.function.arguments)
            : {};
        } catch {
          args = {};
        }

        let result: ToolResult;
        try {
          result = await executeAssistantTool(call.function.name, args, ctx);
        } catch (err) {
          result = {
            content: { ok: false, error: (err as Error).message },
          };
        }

        if (result.event) events.push(result.event);
        if (result.card) cards.push(result.card);
        if (result.artifacts?.length) artifacts.push(...result.artifacts);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result.content),
        });
      }
    }

    // Ran out of tool turns — ask the model for a final word without tools.
    const wrap = await openaiChat(messages);
    return NextResponse.json({
      reply: wrap.content ?? "",
      events,
      cards,
      artifacts,
    });
  } catch (error) {
    console.error("Assistant chat error:", error);
    return NextResponse.json(
      { error: "The assistant ran into a problem." },
      { status: 500 },
    );
  }
}
