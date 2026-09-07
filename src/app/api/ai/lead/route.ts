import { validateLead } from "@/lib/ai-projects/chat-core";
import { gateRequest, json, preflight } from "@/lib/ai-projects/cors";
import { executeAiTool } from "@/lib/ai-projects/tools";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/ai/lead?p=<public key>  (0126)
 *
 * The fallback lead form the widget shows when the model is unavailable
 * (rate-limited, over the daily cap). Same lead path as the agent's own
 * capture_lead tool, so the client gets the same email either way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;

export async function OPTIONS(request: Request) {
  return preflight(request, "POST, OPTIONS");
}

export async function POST(request: Request) {
  const gate = await gateRequest(request, "POST, OPTIONS");
  if (!gate.ok) return json({ error: gate.error, code: gate.code }, { status: gate.status, headers: gate.headers });
  if (!gate.project.lead_capture_enabled) {
    return json({ error: "This assistant does not take details.", code: "disabled" }, { status: 403, headers: gate.headers });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid request body.", code: "bad_request" }, { status: 400, headers: gate.headers });
  }
  const session = typeof body.session === "string" && KEY_RE.test(body.session) ? body.session : null;
  if (!session) return json({ error: "A session is required.", code: "bad_request" }, { status: 400, headers: gate.headers });

  const admin = createAdminClient();
  const ip = clientIp(request.headers);
  const checks = await Promise.all([
    enforceRateLimit(admin, `ai-lead:session:${gate.project.id}:${session}`, { limit: 5, windowSec: 600 }),
    enforceRateLimit(admin, `ai-lead:ip:${ip}`, { limit: 20, windowSec: 3600 }),
  ]);
  const refused = checks.find((c) => !c.ok);
  if (refused) {
    return json({ error: "Too many submissions.", code: "rate_limited" }, { status: 429, headers: { ...gate.headers, "Retry-After": String(refused.retryAfter) } });
  }

  const checked = validateLead({
    name: body.name,
    email: body.email,
    phone: body.phone,
    interest: typeof body.message === "string" ? body.message.slice(0, 500) : undefined,
  });
  if (!checked.ok) return json({ error: checked.error, code: "bad_request" }, { status: 400, headers: gate.headers });

  const pageUrl = typeof body.page === "string" && /^https?:\/\//i.test(body.page) ? body.page.slice(0, 500) : null;
  const preview = gate.preview && body.preview === true;
  const { data: conversation } = await admin
    .from("ai_conversations")
    .upsert(
      { project_id: gate.project.id, session_key: session, page_url: pageUrl, is_preview: preview, last_message_at: new Date().toISOString() },
      { onConflict: "project_id,session_key" },
    )
    .select("id")
    .single();
  if (!conversation) return json({ error: "Could not save your details.", code: "failed" }, { status: 500, headers: gate.headers });

  const outcome = await executeAiTool(
    { db: admin, project: gate.project, conversationId: conversation.id, pageUrl, preview, customTools: gate.tools },
    "capture_lead",
    checked.lead,
  );
  const ok = Boolean((outcome.content as { ok?: boolean })?.ok);
  if (!ok) {
    const err = (outcome.content as { error?: string })?.error ?? "Could not save your details.";
    return json({ error: err, code: "failed" }, { status: 400, headers: gate.headers });
  }
  // Same as a turn: try to get it onto the client's system now, and let the
  // tick carry anything that fails.
  if (!preview) {
    const { drainProjectDeliveries } = await import("@/lib/ai-projects/delivery");
    await drainProjectDeliveries(admin, gate.project.id, { budgetMs: 4_000 });
  }
  return json({ ok: true }, { headers: gate.headers });
}
