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

import { loadPersona } from "@/lib/ai/assistant-persona";
import { assistantSystemPrompt, type AssistantMode } from "@/lib/ai/assistant-prompt";
import {
  isOpenAIConfigured,
  OpenAIRateLimitError,
  type ChatMessage,
} from "@/lib/ai/openai";
import { openaiChatStream } from "@/lib/ai/openai-stream";
import {
  ALL_ASSISTANT_TOOLS,
  executeAssistantTool,
  toolLabel,
} from "@/lib/ai/tool-registry";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import { sseFrame, type AssistantStreamEvent } from "@/lib/assistant-stream";
import { getAssistantProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Matches the one-shot route: enough headroom for a read-then-write chain. */
const MAX_TOOL_TURNS = 10;

/**
 * Wall-clock ceiling for the whole turn — the WA agent's RUN_BUDGET_MS
 * pattern. Ten tool turns at up to 45s each used to have no overall limit, so
 * a long chain sailed past the serverless platform's own ceiling and was
 * killed from outside: the client saw a dead stream with no terminal frame,
 * which is the "error with no response" the budget exists to end. When the
 * budget runs low the loop stops offering tools and lands the plane with the
 * final no-tools pass instead.
 */
const TURN_BUDGET_MS = 60_000;

/** Stop starting new tool turns when less than this is left — the wrap-up
 * pass needs real room to produce a sentence. */
const WRAP_UP_RESERVE_MS = 12_000;

/** No single model call may outlive the budget; floor keeps a late retry from
 * being handed a 1-second corpse of a timeout. */
const PER_CALL_FLOOR_MS = 8_000;

/** Emit a `working` frame this often while a tool runs, so a slow tool (the
 * proposal writer can take a minute) never leaves the SSE idle long enough
 * for a proxy to drop it. The client ignores repeated status frames. */
const HEARTBEAT_MS = 10_000;

/** The one brain, thinking lightly: interactive turns run the shared chat
 * model at low effort so a reasoning-class model answers at chat speed. */
const REASONING_EFFORT = "low";

export async function POST(request: Request) {
  const profile = await getAssistantProfile();
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
  // Situational awareness (0104): which page the user is on. Length-capped
  // strings and nothing else — this is display context, not a data channel.
  let pageContext: { pathname: string; title?: string } | undefined;
  try {
    const body = await request.json();
    if (Array.isArray(body?.messages)) history = body.messages;
    if (body?.mode === "text" || body?.mode === "voice") mode = body.mode;
    if (typeof body?.context?.pathname === "string") {
      pageContext = {
        pathname: body.context.pathname.slice(0, 200),
        ...(typeof body.context.title === "string"
          ? { title: body.context.title.slice(0, 160) }
          : {}),
      };
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createClient();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
  }).format(new Date());

  const ctx: ToolContext = { supabase, userId: profile.id, today };

  // Persona and memory (0101). Both are optional: a workspace that has not
  // run the migration, or a member who has never set anything, simply gets
  // the prompt exactly as it was before.
  const persona = await loadPersona(supabase, profile.id);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: assistantSystemPrompt({
        name: profile.full_name,
        today,
        mode,
        context: pageContext,
        ...persona,
      }),
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

      const startedAt = Date.now();
      const remaining = () => TURN_BUDGET_MS - (Date.now() - startedAt);

      /**
       * Stream one model turn, remembering anything it said.
       *
       * Retries exactly once on a rate limit or a transient failure — but
       * ONLY if the failed attempt emitted no text. A 429/5xx fails before
       * the first delta, so retrying is invisible; a connection that died
       * mid-stream already put words on the user's screen, and re-running it
       * would print them twice.
       */
      const speakTurn = async (withTools: boolean) => {
        let text = "";
        const attempt = () =>
          openaiChatStream(
            messages,
            withTools ? ALL_ASSISTANT_TOOLS : undefined,
            {
              reasoningEffort: REASONING_EFFORT,
              timeoutMs: Math.min(
                45_000,
                Math.max(PER_CALL_FLOOR_MS, remaining()),
              ),
            },
            (chunk) => {
              text += chunk;
              send({ type: "delta", text: chunk });
            },
          );

        let assistant: ChatMessage;
        try {
          assistant = await attempt();
        } catch (err) {
          const name = (err as Error)?.name;
          const rateLimited = err instanceof OpenAIRateLimitError;
          // Our own per-call timeout fired: retrying with even less budget
          // is pointless, and text may already be on screen. Give up here
          // and let the outer catch report it.
          const timedOut = name === "AbortError" || name === "TimeoutError";
          const wait = rateLimited
            ? Math.min(err.retryAfterMs ?? 2_000, 8_000)
            : 1_000;
          if (timedOut || text.length > 0 || remaining() < wait + WRAP_UP_RESERVE_MS) {
            throw err;
          }
          send({ type: "status", status: "thinking" });
          await new Promise((resolve) => setTimeout(resolve, wait));
          assistant = await attempt();
        }
        if (text.trim()) spoken.push(text.trim());
        return assistant;
      };

      try {
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          // Budget check BEFORE committing to another tool round — when the
          // clock is nearly out, fall through to the wrap-up pass below so
          // the stream always ends in `done`, never in a platform kill.
          if (turn > 0 && remaining() < WRAP_UP_RESERVE_MS) break;

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
            // A slow tool (the proposal writer runs a whole model call) can
            // hold the SSE silent for a minute — long enough for a proxy to
            // decide the connection is dead. Tick a status frame while it
            // works so there is always traffic on the wire.
            const heartbeat = setInterval(
              () => send({ type: "status", status: "working" }),
              HEARTBEAT_MS,
            );
            try {
              result = await executeAssistantTool(name, args, ctx);
            } catch (err) {
              failure = (err as Error).message;
              result = { content: { ok: false, error: failure } };
            } finally {
              clearInterval(heartbeat);
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

        // Out of tool turns, or out of budget. One last pass with no tools so
        // the user gets a sentence rather than silence after all that work.
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
