import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  isOpenAIConfigured,
  openaiChat,
  type ChatMessage,
} from "@/lib/ai/openai";
import {
  ASSISTANT_TOOLS,
  executeTool,
  type ToolContext,
  type ToolEvent,
} from "@/lib/ai/tools";

export const runtime = "nodejs";

const MAX_TOOL_TURNS = 6;

function systemPrompt(name: string, today: string): string {
  const weekday = new Date(today + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
  });
  return [
    `You are Arc, the friendly voice assistant for the ARC AI agency workspace (a CRM + project management app).`,
    `You are speaking with ${name}. Today is ${weekday}, ${today}. The workspace currency is LKR.`,
    ``,
    `You can read and act on the live workspace through your tools — clients, to-dos, projects, the CRM pipeline, meetings, payments and team. Always use a tool to look things up or make changes instead of guessing or making up data.`,
    ``,
    `Your replies are spoken out loud, so:`,
    `- Keep answers short and natural — usually one to three sentences.`,
    `- Never use markdown, bullet points, headings or emojis. Speak in plain sentences.`,
    `- Read numbers and money naturally (e.g. "120 thousand rupees").`,
    ``,
    `When the user refers to a relative date like "tomorrow" or "next Friday", convert it to an ISO date (YYYY-MM-DD) based on today before calling a tool.`,
    `When assigning a task, pass the person's name as assignee_name; use "me" when the user means themselves.`,
    `You can also edit existing records — update a client's details, move a CRM lead between stages or change its value, and reschedule or cancel meetings. To edit, find the record with the matching tool's "query" first, then change only what was asked.`,
    `Before cancelling a meeting or any other destructive change, briefly confirm with the user first instead of doing it immediately.`,
    `After you create or change anything, briefly confirm what you did. If a tool reports an error, explain it simply.`,
  ].join("\n");
}

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
      { role: "system", content: systemPrompt(profile.full_name, today) },
      ...history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: String(m.content ?? ""),
        })),
    ];

    const events: ToolEvent[] = [];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const assistant = await openaiChat(messages, ASSISTANT_TOOLS);
      messages.push(assistant);

      const toolCalls = assistant.tool_calls ?? [];
      if (!toolCalls.length) {
        return NextResponse.json({
          reply: assistant.content ?? "",
          events,
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

        let result;
        try {
          result = await executeTool(call.function.name, args, ctx);
        } catch (err) {
          result = {
            content: { ok: false, error: (err as Error).message },
          };
        }

        if (result.event) events.push(result.event);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result.content),
        });
      }
    }

    // Ran out of tool turns — ask the model for a final word without tools.
    const wrap = await openaiChat(messages);
    return NextResponse.json({ reply: wrap.content ?? "", events });
  } catch (error) {
    console.error("Assistant chat error:", error);
    return NextResponse.json(
      { error: "The assistant ran into a problem." },
      { status: 500 },
    );
  }
}
