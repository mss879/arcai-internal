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
import type { AssistantCard } from "@/lib/assistant-cards";

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
    `ACCURACY IS CRITICAL — the user depends on this to not miss meetings or deadlines. Hard rules:`,
    `- Only state facts that a tool actually returned in this conversation. Never invent or estimate a title, name, date, time, amount or status.`,
    `- If you have not looked something up, call the tool first. If a tool returns nothing, or doesn't include the detail asked for, say plainly that you don't have it and suggest where to check — do not fill the gap from memory or assumption.`,
    `- All dates and times from your tools are already in Sri Lanka time and formatted for you. Repeat them back exactly as given. Never convert, shift, round or recompute a time yourself.`,
    `- If you are not certain, say you're not sure rather than guessing.`,
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
    ``,
    `INVOICES — you can create invoices and prepare them to be emailed:`,
    `- To create one, call create_invoice with the client/company name and the line items, plus the amount due today if the user states one. The saved invoice is shown to the user automatically, so just confirm it briefly out loud (number, who it's for, total).`,
    `- For each line item, map the user's words to the right fields: a service or product NAME (e.g. they say "the service is Smart website") goes in 'item'; any extra detail (e.g. "the description is upgrade from Wordpress") goes in 'description'. If they only give one phrase for the line, put it in 'description'. Capture BOTH when the user gives both — never drop the service name.`,
    `- To email an invoice OR send a payment reminder, call prepare_invoice_email. Pass recipient_emails as the full list of every address the user names (one or many). If the user wants a note or reminder in the email (e.g. a warning about what happens if they don't pay), put that text in 'message' as close to word-for-word as you can. Convert spoken emails to standard form (e.g. "john at acme dot com" to "john@acme.com").`,
    `- If the user asks in one go to create an invoice AND send it / send a reminder, call create_invoice first, then prepare_invoice_email for the same invoice.`,
    `- CRITICAL: prepare_invoice_email does NOT send anything. It shows the user the invoice, the recipients and the message to confirm. The invoice is only sent when the user taps the Send button. NEVER say you have sent or emailed the invoice. Instead say something like "Here's the invoice — please check it and the addresses, then tap Send to confirm." Read the email addresses back clearly so they can verify them.`,
    ``,
    `CONTACTS & PAYMENTS — look people and money up before acting; never guess an email address or an amount:`,
    `- list_clients returns a client's saved details, including their email. When the user names a client, use it to find their email instead of asking.`,
    `- list_payments returns outstanding (unpaid) payments from the Payments page — the company/client and how much they still owe.`,
    `- To send a payment reminder to a client by name: (1) call list_clients to get their email; (2) call list_payments to get their outstanding amount; (3) call create_invoice billed to that client for the outstanding amount, with one line item whose item is "Outstanding payment" (no description) and due today = that amount; (4) call prepare_invoice_email to their email with a short reminder message, and OMIT invoice_number so the invoice you just created is the one used. If they have several outstanding payments, total them. If you can't find their email or any outstanding payment, say so plainly instead of guessing.`,
    `- Whenever you email or remind about an invoice you just created in this same conversation, omit invoice_number in prepare_invoice_email — never invent one.`,
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
    const cards: AssistantCard[] = [];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const assistant = await openaiChat(messages, ASSISTANT_TOOLS);
      messages.push(assistant);

      const toolCalls = assistant.tool_calls ?? [];
      if (!toolCalls.length) {
        return NextResponse.json({
          reply: assistant.content ?? "",
          events,
          cards,
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
        if (result.card) cards.push(result.card);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result.content),
        });
      }
    }

    // Ran out of tool turns — ask the model for a final word without tools.
    const wrap = await openaiChat(messages);
    return NextResponse.json({ reply: wrap.content ?? "", events, cards });
  } catch (error) {
    console.error("Assistant chat error:", error);
    return NextResponse.json(
      { error: "The assistant ran into a problem." },
      { status: 500 },
    );
  }
}
