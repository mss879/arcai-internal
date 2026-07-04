import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { fireAutomationTrigger } from "@/lib/automation";

/**
 * Open API — leads. Authenticate with an API key from the Automation page:
 *
 *   GET  /api/public/v1/leads            list recent leads
 *   POST /api/public/v1/leads            create a lead (fires automations)
 *
 * Header: `x-api-key: arc_…`  (or `Authorization: Bearer arc_…`)
 * This is the surface Zapier/Make/agency integrations build on.
 */

async function authenticate(
  request: Request,
): Promise<{ supabase: SupabaseClient<Database> } | NextResponse> {
  const key =
    request.headers.get("x-api-key")?.trim() ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    "";
  if (!key) {
    return NextResponse.json({ error: "Missing API key." }, { status: 401 });
  }
  const supabase = createAdminClient();
  const { data: apiKey } = await supabase
    .from("api_keys")
    .select("*")
    .eq("key", key)
    .eq("is_active", true)
    .maybeSingle();
  if (!apiKey) {
    return NextResponse.json({ error: "Invalid API key." }, { status: 401 });
  }
  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", apiKey.id);
  return { supabase };
}

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const status = url.searchParams.get("status");

  let q = auth.supabase
    .from("leads")
    .select(
      "id, title, contact_name, contact_email, contact_phone, value, currency, status, score, source, tags, stage_id, pipeline_id, created_at",
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status && ["open", "won", "lost"].includes(status)) {
    q = q.eq("status", status as "open");
  }
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, leads: data });
}

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const title = String(body.title ?? body.name ?? "").trim();
  if (!title) {
    return NextResponse.json({ error: "title (or name) is required." }, { status: 400 });
  }

  let pipelineId = body.pipeline_id ? String(body.pipeline_id) : null;
  if (!pipelineId) {
    const { data: pipe } = await supabase
      .from("pipelines")
      .select("id")
      .order("position")
      .limit(1)
      .maybeSingle();
    pipelineId = pipe?.id ?? null;
  }
  if (!pipelineId) {
    return NextResponse.json({ error: "No pipeline exists." }, { status: 409 });
  }
  let stageId = body.stage_id ? String(body.stage_id) : null;
  if (!stageId) {
    const { data: stage } = await supabase
      .from("pipeline_stages")
      .select("id")
      .eq("pipeline_id", pipelineId)
      .order("position")
      .limit(1)
      .maybeSingle();
    stageId = stage?.id ?? null;
  }

  const { data: lead, error } = await supabase
    .from("leads")
    .insert({
      pipeline_id: pipelineId,
      stage_id: stageId,
      title,
      contact_name: body.contact_name ? String(body.contact_name) : (body.name ? String(body.name) : null),
      contact_email: body.email ? String(body.email) : null,
      contact_phone: body.phone ? String(body.phone) : null,
      value: body.value != null ? Number(body.value) : null,
      notes: body.notes ? String(body.notes) : null,
      source: body.source ? String(body.source) : "api",
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      created_by: null,
    })
    .select("*")
    .single();
  if (error || !lead) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create the lead." },
      { status: 500 },
    );
  }

  await fireAutomationTrigger(supabase, {
    trigger: "lead_created",
    lead,
    payload: { source: lead.source },
    triggerKey: `${lead.id}:created`,
  });

  return NextResponse.json({ ok: true, lead_id: lead.id }, { status: 201 });
}
