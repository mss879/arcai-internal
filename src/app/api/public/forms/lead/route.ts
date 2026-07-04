import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { fireAutomationTrigger } from "@/lib/automation";

/**
 * Public inquiry-form endpoint. Point any website form at it:
 *
 *   POST /api/public/forms/lead
 *   { "name": "...", "phone": "...", "email": "...", "message": "...",
 *     "service": "...", "source": "website" }
 *
 * Creates a CRM lead in the default pipeline's first stage and fires the
 * `form_submitted` + `lead_created` automation triggers — which is what
 * runs the "keep warm" welcome SMS flow.
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
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Send a JSON body." },
      { status: 400, headers: CORS },
    );
  }

  const name = String(body.name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const email = String(body.email ?? "").trim();
  const message = String(body.message ?? "").trim();
  const service = String(body.service ?? "").trim();
  const source = String(body.source ?? "form").trim() || "form";

  if (!name && !phone && !email) {
    return NextResponse.json(
      { error: "Provide at least a name, phone or email." },
      { status: 400, headers: CORS },
    );
  }

  try {
    const supabase = createAdminClient();

    // Where new form leads land: app_settings.lead_form or the first
    // pipeline's first stage.
    const { data: setting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "lead_form")
      .maybeSingle();
    const cfg = (setting?.value ?? {}) as { pipeline_id?: string; stage_id?: string };

    let pipelineId = cfg.pipeline_id ?? null;
    let stageId = cfg.stage_id ?? null;
    if (!pipelineId) {
      const { data: pipe } = await supabase
        .from("pipelines")
        .select("id")
        .order("position")
        .order("created_at")
        .limit(1)
        .maybeSingle();
      pipelineId = pipe?.id ?? null;
    }
    if (!pipelineId) {
      return NextResponse.json(
        { error: "No CRM pipeline exists yet." },
        { status: 409, headers: CORS },
      );
    }
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
        title: service ? `${name || "Inquiry"} — ${service}` : name || "Website inquiry",
        contact_name: name || null,
        contact_phone: phone || null,
        contact_email: email || null,
        notes: message || null,
        source,
        tags: ["inbound"],
        created_by: null,
      })
      .select("*")
      .single();
    if (error || !lead) {
      return NextResponse.json(
        { error: error?.message ?? "Could not create the lead." },
        { status: 500, headers: CORS },
      );
    }

    // Kick off the keep-warm automations.
    await fireAutomationTrigger(supabase, {
      trigger: "form_submitted",
      lead,
      payload: { message, service, source },
    });
    await fireAutomationTrigger(supabase, {
      trigger: "lead_created",
      lead,
      payload: { message, service, source },
      triggerKey: `${lead.id}:created`,
    });

    return NextResponse.json({ ok: true, lead_id: lead.id }, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Something went wrong." },
      { status: 500, headers: CORS },
    );
  }
}
