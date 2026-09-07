import { runChatTurn } from "@/lib/ai-projects/chat";
import { parseChatRequest } from "@/lib/ai-projects/chat-core";
import { gateRequest, json, preflight } from "@/lib/ai-projects/cors";
import { AI_ERROR_MESSAGES, sseFrame, type AiStreamEvent } from "@/lib/ai-projects/stream-core";
import { colomboDay, colomboDayStartIso } from "@/lib/ai-projects/time-core";
import { isOpenAIConfigured } from "@/lib/ai/openai";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/ai/chat?p=<public key>  (0126)
 *
 * One visitor turn, streamed as SSE frames (see stream-core). Everything
 * that can fail with a status code happens before the stream opens; once
 * the headers say `text/event-stream`, failures are `error` frames.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return preflight(request, "POST, OPTIONS");
}

export async function POST(request: Request) {
  const gate = await gateRequest(request, "POST, OPTIONS");
  if (!gate.ok) return json({ error: gate.error, code: gate.code }, { status: gate.status, headers: gate.headers });
  if (!gate.enabled) {
    return json({ error: AI_ERROR_MESSAGES.disabled, code: "disabled" }, { status: 403, headers: gate.headers });
  }
  if (!isOpenAIConfigured()) {
    return json({ error: AI_ERROR_MESSAGES.failed, code: "failed" }, { status: 503, headers: gate.headers });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body.", code: "bad_request" }, { status: 400, headers: gate.headers });
  }
  const parsed = parseChatRequest(body);
  if (!parsed.ok) return json({ error: parsed.error, code: "bad_request" }, { status: 400, headers: gate.headers });

  const { project } = gate;
  const preview = gate.preview && parsed.request.preview;
  const admin = createAdminClient();
  const ip = clientIp(request.headers);

  // Limits, all checked before a single token is spent.
  const checks = await Promise.all([
    enforceRateLimit(admin, `ai-chat:ip:${ip}`, { limit: 30, windowSec: 60 }),
    enforceRateLimit(admin, `ai-chat:session:${project.id}:${parsed.request.session}`, {
      limit: Math.max(1, project.rate_limit_per_minute),
      windowSec: 60,
    }),
    enforceRateLimit(admin, `ai-chat:project:${project.id}`, { limit: 600, windowSec: 3600 }),
  ]);
  const refused = checks.find((c) => !c.ok);
  if (refused) {
    return json(
      { error: AI_ERROR_MESSAGES.rate_limited, code: "rate_limited", retryAfter: refused.retryAfter },
      { status: 429, headers: { ...gate.headers, "Retry-After": String(refused.retryAfter) } },
    );
  }
  if (!preview) {
    const { count } = await admin
      .from("ai_messages")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("role", "user")
      .gte("created_at", colomboDayStartIso(colomboDay()));
    if ((count ?? 0) >= project.daily_message_cap) {
      return json({ error: AI_ERROR_MESSAGES.busy, code: "busy" }, { status: 429, headers: { ...gate.headers, "Retry-After": "3600" } });
    }
  }

  const encoder = new TextEncoder();
  let writable = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AiStreamEvent) => {
        if (!writable) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          // The visitor left; keep working so the usage and reply are stored.
          writable = false;
        }
      };
      try {
        await runChatTurn({
          db: admin,
          project,
          customTools: gate.tools,
          request: parsed.request,
          preview,
          ip,
          userAgent: request.headers.get("user-agent"),
          country: request.headers.get("x-country") ?? request.headers.get("x-nf-geo-country") ?? null,
          send,
        });
      } catch (e) {
        console.error("[ai/chat] turn failed:", e);
        send({ type: "error", code: "failed", message: AI_ERROR_MESSAGES.failed });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        writable = false;
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...gate.headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
