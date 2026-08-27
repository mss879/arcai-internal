import { NextResponse } from "next/server";

import { getAssistantProfile } from "@/lib/auth";
import type { ToolContext } from "@/lib/ai/tools";
import {
  ALL_ASSISTANT_TOOLS,
  executeAssistantTool,
} from "@/lib/ai/tool-registry";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Known tool names, so an arbitrary string can't probe the executor. */
const KNOWN = new Set(ALL_ASSISTANT_TOOLS.map((t) => t.function.name));

/**
 * POST { name, args } → one tool call's result (0104).
 *
 * The Realtime voice session runs browser↔OpenAI, but tools must never run
 * anywhere except HERE, on the caller's own session: the ToolContext carries
 * the request's RLS-scoped client — NEVER the service role — so a live voice
 * conversation can reach exactly what the typing user could and not a row
 * more. The browser relays the model's function_call to this route and hands
 * the `content` back over the data channel; `artifacts` and `card` feed the
 * stage exactly as the SSE pipeline's frames would.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let name = "";
  let args: Record<string, unknown> = {};
  try {
    const body = await request.json();
    name = String(body?.name ?? "");
    if (body?.args && typeof body.args === "object" && !Array.isArray(body.args)) {
      args = body.args as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }
  if (!KNOWN.has(name)) {
    return NextResponse.json({ error: `Unknown tool "${name}".` }, { status: 400 });
  }

  const supabase = await createClient();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Colombo",
  }).format(new Date());
  const ctx: ToolContext = { supabase, userId: profile.id, today };

  try {
    const result = await executeAssistantTool(name, args, ctx);
    return NextResponse.json({
      content: result.content,
      event: result.event ?? null,
      card: result.card ?? null,
      artifacts: result.artifacts ?? [],
    });
  } catch (error) {
    return NextResponse.json({
      content: {
        ok: false,
        error: error instanceof Error ? error.message : "The tool failed.",
      },
      event: null,
      card: null,
      artifacts: [],
    });
  }
}
