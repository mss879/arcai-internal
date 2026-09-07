import { NextResponse } from "next/server";

import { gateRequest, json, preflight } from "@/lib/ai-projects/cors";
import { publicConfigFor } from "@/lib/ai-projects/projects";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/ai/config?p=<public key>  (0126)
 *
 * What the widget needs to draw itself: the agent's name, welcome message,
 * suggested questions, colours, position, avatar and which abilities are on.
 * Never the prompt, the model or the origin list. Cacheable for five minutes
 * per origin; the widget also caches it in sessionStorage.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return preflight(request, "GET, OPTIONS");
}

export async function GET(request: Request) {
  const gate = await gateRequest(request, "GET, OPTIONS");
  if (!gate.ok) return json({ error: gate.error, code: gate.code }, { status: gate.status, headers: gate.headers });

  const limit = await enforceRateLimit(createAdminClient(), `ai-config:${clientIp(request.headers)}`, {
    limit: 60,
    windowSec: 60,
  });
  if (!limit.ok) {
    return json(
      { error: "Too many requests.", code: "rate_limited" },
      { status: 429, headers: { ...gate.headers, "Retry-After": String(limit.retryAfter) } },
    );
  }

  return NextResponse.json(publicConfigFor(gate.project, gate.enabled), {
    headers: {
      ...gate.headers,
      "Cache-Control": gate.preview ? "no-store" : "public, max-age=300",
    },
  });
}
