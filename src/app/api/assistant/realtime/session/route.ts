import { NextResponse } from "next/server";

import { getAssistantProfile } from "@/lib/auth";
import { assistantSystemPrompt } from "@/lib/ai/assistant-prompt";
import { loadPersona } from "@/lib/ai/assistant-persona";
import { isOpenAIConfigured } from "@/lib/ai/openai";
import { ALL_ASSISTANT_TOOLS } from "@/lib/ai/tool-registry";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const BASE_URL =
  process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") ||
  "https://api.openai.com/v1";

/**
 * POST → an ephemeral Realtime session credential (0104).
 *
 * The low-latency voice mode is browser↔OpenAI WebRTC — this host runs on
 * serverless, which cannot hold a WebSocket open, so the server's ONLY job
 * is to mint a short-lived client secret with the real API key and hand the
 * browser everything the session needs baked in: the same system prompt the
 * text pipeline uses (persona, memories, page context) and the same 70-odd
 * tools, unwrapped to the flat shape the Realtime API takes.
 *
 * Tool EXECUTION stays on this server (`/api/assistant/execute-tool`) under
 * the caller's own RLS — the model calls a function over the data channel,
 * the browser relays it here, the result goes back. The ephemeral secret
 * can talk to OpenAI; it can never touch the database.
 *
 * Endpoint drift note: the GA surface is `POST /realtime/client_secrets`;
 * the earlier beta was `POST /realtime/sessions`. Both are tried, in that
 * order, so an account on either vintage works.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isOpenAIConfigured()) {
    return NextResponse.json(
      { error: "Voice is not configured. Add OPENAI_API_KEY." },
      { status: 503 },
    );
  }

  let pageContext: { pathname: string; title?: string } | undefined;
  try {
    const body = await request.json();
    if (typeof body?.context?.pathname === "string") {
      pageContext = {
        pathname: String(body.context.pathname).slice(0, 200),
        ...(typeof body.context.title === "string"
          ? { title: String(body.context.title).slice(0, 160) }
          : {}),
      };
    }
  } catch {
    // No body is fine — the context line is optional.
  }

  const supabase = await createClient();
  const persona = await loadPersona(supabase, profile.id);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
  }).format(new Date());

  const instructions = assistantSystemPrompt({
    name: profile.full_name,
    today,
    mode: "voice",
    context: pageContext,
    ...persona,
  });

  // The chat-completions schema nests under `function`; Realtime wants the
  // fields flat. Same tools, same descriptions — one unwrap, no rewrite.
  const tools = ALL_ASSISTANT_TOOLS.map((tool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));

  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";
  const voice = process.env.OPENAI_REALTIME_VOICE?.trim() || "cedar";
  const key = process.env.OPENAI_API_KEY!;

  // GA shape first.
  try {
    const res = await fetch(`${BASE_URL}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          instructions,
          tools,
          audio: { output: { voice } },
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      const secret = data?.value ?? data?.client_secret?.value;
      if (secret) {
        return NextResponse.json({
          clientSecret: secret,
          model,
          surface: "ga",
          expiresAt: data?.expires_at ?? data?.client_secret?.expires_at ?? null,
        });
      }
    }
  } catch {
    // Fall through to the beta shape.
  }

  // Beta fallback.
  try {
    const res = await fetch(`${BASE_URL}/realtime/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
      },
      body: JSON.stringify({ model, instructions, tools, voice }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      const secret = data?.client_secret?.value;
      if (secret) {
        return NextResponse.json({
          clientSecret: secret,
          model,
          surface: "beta",
          expiresAt: data?.client_secret?.expires_at ?? null,
        });
      }
    }
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Could not start a live session. ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  } catch {
    return NextResponse.json(
      { error: "Could not reach the voice service." },
      { status: 502 },
    );
  }
}
