import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createInboundLead } from "@/lib/lead-intake";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";

/**
 * Public inquiry-form endpoint. Point any website form at it:
 *
 *   POST /api/public/forms/lead
 *   { "name": "...", "phone": "...", "email": "...", "message": "...",
 *     "service": "...", "source": "website",
 *     "utm_source": "...", "referrer": "...", "landing_url": "...",
 *     "ref": "ARC-XXXXXX" }
 *
 * The lead itself is created by createInboundLead() (0117), which is also
 * what the inbound webhooks use — so where it lands, whether it is a
 * duplicate, and which triggers fire are decided in ONE place. This route
 * only parses the request.
 *
 * Attribution is accepted flat (utm_source) or nested ({ utm: { ... } }),
 * because the website's own form sends it the second way and third-party
 * forms send it the first.
 *
 * CORS is open so the snippet works from any of the agency's client sites.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  // 0116 — anyone on the internet can post here. Generous enough for a busy
  // client site's real traffic, tight enough that a loop can't fill the CRM.
  const supabaseForLimit = createAdminClient();
  const limit = await enforceRateLimit(
    supabaseForLimit,
    `lead-form:${clientIp(request.headers)}`,
    { limit: 20, windowSec: 300 },
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many submissions. Try again shortly." },
      { status: 429, headers: { ...CORS, "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Send a JSON body." },
      { status: 400, headers: CORS },
    );
  }

  const utm: Record<string, string> = {};
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
  ]) {
    const value = String((body as Record<string, unknown>)[key] ?? "").trim();
    if (value) utm[key] = value.slice(0, 200);
  }
  // Also accept them nested, which is how the website's own form sends them.
  if (body.utm && typeof body.utm === "object") {
    for (const [k, v] of Object.entries(body.utm as Record<string, unknown>)) {
      const value = String(v ?? "").trim();
      if (value) utm[k] = value.slice(0, 200);
    }
  }

  try {
    const supabase = createAdminClient();
    const result = await createInboundLead(supabase, {
      name: String(body.name ?? ""),
      phone: String(body.phone ?? ""),
      email: String(body.email ?? ""),
      message: String(body.message ?? ""),
      service: String(body.service ?? ""),
      source: String(body.source ?? "form").trim() || "form",
      company: String(body.company ?? "") || null,
      utm,
      referrer: String(body.referrer ?? "") || null,
      landingUrl: String(body.landing_url ?? "") || null,
      referralCode: String(body.ref ?? body.referral_code ?? "") || null,
    });

    if (!result.ok) {
      const status = result.error.includes("pipeline") ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status, headers: CORS });
    }

    return NextResponse.json(
      { ok: true, lead_id: result.lead.id, duplicate: result.duplicate },
      { headers: CORS },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Something went wrong." },
      { status: 500, headers: CORS },
    );
  }
}
