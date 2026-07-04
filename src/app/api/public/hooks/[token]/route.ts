import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { enrollAutomationRun, fireAutomationTrigger } from "@/lib/automation";

/**
 * Inbound webhooks: POST /api/public/hooks/<token>
 *
 * Each endpoint is created on the Automation page and either
 *   - create_lead     : maps the JSON payload to a new CRM lead, or
 *   - fire_automation : enrolls the payload straight into an automation.
 *
 * This is what Zapier/Make/landing-page builders post to.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  try {
    const supabase = createAdminClient();
    const { data: endpoint } = await supabase
      .from("webhook_endpoints")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (!endpoint) {
      return NextResponse.json({ error: "Unknown webhook." }, { status: 404 });
    }

    await supabase
      .from("webhook_endpoints")
      .update({ hits: endpoint.hits + 1, last_hit_at: new Date().toISOString() })
      .eq("id", endpoint.id);

    const cfg = (endpoint.config ?? {}) as {
      pipeline_id?: string;
      stage_id?: string;
      tags?: string[];
      source?: string;
      automation_id?: string;
    };

    if (endpoint.action === "create_lead") {
      const name = String(payload.name ?? payload.full_name ?? "").trim();
      const phone = String(payload.phone ?? payload.mobile ?? "").trim();
      const email = String(payload.email ?? "").trim();
      const message = String(payload.message ?? payload.notes ?? "").trim();

      let pipelineId = cfg.pipeline_id ?? null;
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
      let stageId = cfg.stage_id ?? null;
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
          title: name || `Webhook lead (${endpoint.name})`,
          contact_name: name || null,
          contact_phone: phone || null,
          contact_email: email || null,
          notes: message || null,
          source: cfg.source ?? "webhook",
          tags: cfg.tags ?? ["inbound"],
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
        trigger: "webhook",
        lead,
        payload: { ...payload, endpoint_id: endpoint.id },
      });
      await fireAutomationTrigger(supabase, {
        trigger: "lead_created",
        lead,
        payload: { ...payload, endpoint_id: endpoint.id },
        triggerKey: `${lead.id}:created`,
      });
      return NextResponse.json({ ok: true, lead_id: lead.id });
    }

    // fire_automation
    if (!cfg.automation_id) {
      return NextResponse.json(
        { error: "Endpoint has no automation configured." },
        { status: 409 },
      );
    }
    const { data: automation } = await supabase
      .from("automations")
      .select("*")
      .eq("id", cfg.automation_id)
      .maybeSingle();
    if (!automation?.is_active) {
      return NextResponse.json(
        { error: "Automation is missing or inactive." },
        { status: 409 },
      );
    }
    await enrollAutomationRun(supabase, automation, {
      trigger: "webhook",
      payload: { ...payload, endpoint_id: endpoint.id },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Webhook failed." },
      { status: 500 },
    );
  }
}
