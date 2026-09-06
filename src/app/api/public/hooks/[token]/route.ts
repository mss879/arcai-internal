import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enrollAutomationRun, fireAutomationTrigger } from "@/lib/automation";
import { createInboundLead } from "@/lib/lead-intake";
import { recordHookConversion } from "@/lib/web-analytics/ledger";

/**
 * Inbound webhooks: POST /api/public/hooks/<token>
 *
 * Each endpoint is created on the CRM → Webhooks tab (or Automation →
 * Connect) and either
 *   - create_lead     : maps the payload to a new CRM lead, or
 *   - fire_automation : enrolls the payload straight into an automation.
 *
 * This is what a website contact form, Zapier/Make, or a landing-page
 * builder posts to. Bodies may be JSON, url-encoded or multipart form
 * data — whatever the sending form uses. CORS is open so a browser form
 * on any site can post here.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Read the request body as a flat object, whatever content-type it uses. */
async function readPayload(request: Request): Promise<Record<string, unknown>> {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const j = await request.json();
      return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
    }
    if (
      ct.includes("application/x-www-form-urlencoded") ||
      ct.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      const obj: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) obj[k] = typeof v === "string" ? v : v.name;
      return obj;
    }
    // Unknown/absent content-type: try JSON first, then url-encoded text.
    const text = await request.text();
    if (!text.trim()) return {};
    try {
      const j = JSON.parse(text);
      return j && typeof j === "object" ? j : {};
    } catch {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of new URLSearchParams(text).entries()) obj[k] = v;
      return obj;
    }
  } catch {
    return {};
  }
}

/** First non-empty value whose (normalised) key matches one of `keys`. */
function pick(payload: Record<string, unknown>, keys: string[]): string {
  for (const rawKey of Object.keys(payload)) {
    const norm = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (keys.includes(norm)) {
      const v = payload[rawKey];
      if (v != null && String(v).trim() !== "") return String(v).trim().slice(0, 500);
    }
  }
  return "";
}

/**
 * 0117 — the attribution a form or ad platform sends along.
 *
 * Read with the same normalising rule as `pick`, because a webhook payload
 * spells these `utm_source`, `utmSource` or `UTM Source` depending on who
 * built the form.
 */
function utmFrom(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
  ]) {
    const value = pick(payload, [key.replace(/_/g, "")]);
    if (value) out[key] = value.slice(0, 200);
  }
  return out;
}

// Common form-field names, normalised (letters/digits only).
const ALIAS = {
  name: ["name", "fullname", "yourname", "contactname"],
  first: ["firstname", "fname"],
  last: ["lastname", "lname", "surname"],
  website: ["website", "url", "site", "web", "companywebsite", "websiteurl", "webaddress"],
  email: ["email", "emailaddress", "youremail", "contactemail", "mail"],
  phone: [
    "phone", "mobile", "tel", "telephone", "phonenumber", "mobilenumber",
    "contactnumber", "whatsapp", "contact",
  ],
  company: ["company", "companyname", "organization", "organisation", "business", "businessname"],
  message: ["message", "notes", "comments", "comment", "enquiry", "inquiry", "details", "description"],
  subject: ["subject", "service", "topic", "interestedin", "interest", "reason"],
  value: ["budget", "value", "amount", "dealvalue", "price"],
};
// Everything mapped above, so leftover fields can be appended to the notes.
const CONSUMED = new Set(
  [
    ...Object.values(ALIAS).flat(),
    "source", "title", "firstname", "lastname", "endpointid", "site", "sessionid",
    // 0125 — the website's analytics ids ride along with an enquiry; they
    // are keys for the lead ledger, not notes for a person to read.
    "leadid", "websiteleadid", "analyticssessionid", "analyticsvisitorid", "test",
  ],
);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // 0116 — bucketed by the endpoint's own token, so a misconfigured or
  // hostile caller on one webhook cannot silence everyone else's.
  const supabase = createAdminClient();
  const limit = await enforceRateLimit(supabase, `hook:${token}`, {
    limit: 300,
    windowSec: 60,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { ...CORS, "Retry-After": String(limit.retryAfter) } },
    );
  }

  const payload = await readPayload(request);

  try {
    const { data: endpoint } = await supabase
      .from("webhook_endpoints")
      .select("*")
      .eq("token", token)
      .maybeSingle();
    if (!endpoint) {
      return NextResponse.json({ error: "Unknown webhook." }, { status: 404, headers: CORS });
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
      const name =
        pick(payload, ALIAS.name) ||
        [pick(payload, ALIAS.first), pick(payload, ALIAS.last)].filter(Boolean).join(" ");
      const email = pick(payload, ALIAS.email);
      const website = pick(payload, ALIAS.website);
      const phone = pick(payload, ALIAS.phone);
      const company = pick(payload, ALIAS.company);
      const message = pick(payload, ALIAS.message);
      const subject = pick(payload, ALIAS.subject);
      const budget = pick(payload, ALIAS.value);
      const value = budget ? Number(budget.replace(/[^0-9.]/g, "")) || null : null;

      // Keep every other submitted field so nothing from the form is lost.
      const extras: string[] = [];
      for (const rawKey of Object.keys(payload)) {
        const norm = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (CONSUMED.has(norm)) continue;
        const v = payload[rawKey];
        if (v != null && String(v).trim() !== "") {
          extras.push(`${rawKey}: ${String(v).trim()}`.slice(0, 300));
        }
      }
      const notes =
        [subject && `Subject: ${subject}`, message, extras.join("\n")]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 4000) || null;

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
        return NextResponse.json({ error: "No pipeline exists." }, { status: 409, headers: CORS });
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

      const created = await createInboundLead(supabase, {
        name,
        phone,
        email,
        message: notes,
        company,
        companyWebsite: website,
        value,
        title: name || company || website || email || `Website lead (${endpoint.name})`,
        source:
          cfg.source ||
          (typeof payload.source === "string" ? payload.source : "") ||
          "website",
        tags: cfg.tags ?? [],
        // This endpoint's own destination beats the workspace default.
        pipelineId,
        stageId,
        utm: utmFrom(payload),
        referrer: pick(payload, ["referrer", "referer"]) || null,
        landingUrl: pick(payload, ["landingurl", "landingpage", "pageurl"]) || null,
        referralCode: pick(payload, ["ref", "referralcode"]) || null,
        meta: { endpoint_id: endpoint.id, endpoint: endpoint.name },
        websiteLeadId: pick(payload, ["leadid", "websiteleadid"]) || null,
        webSessionId: pick(payload, ["analyticssessionid", "sessionid"]) || null,
        webVisitorId: pick(payload, ["analyticsvisitorid", "visitorid"]) || null,
      });
      if (!created.ok) {
        return NextResponse.json(
          { error: created.error },
          { status: 500, headers: CORS },
        );
      }
      const lead = created.lead;

      // 0125 — the ledger's side of the key, written the moment the lead
      // exists. The analytics event for the same conversion arrives on the
      // next sync and merges into this row; this side is written first
      // because it is the side that cannot be lost. Never fails the hook.
      const websiteLeadId = pick(payload, ["leadid", "websiteleadid"]);
      if (/^lead_/.test(websiteLeadId)) {
        const testFlag = payload.test === true || payload.test === "true";
        await recordHookConversion(supabase, {
          leadKey: websiteLeadId,
          sessionId: pick(payload, ["analyticssessionid", "sessionid"]) || null,
          visitorId: pick(payload, ["analyticsvisitorid", "visitorid"]) || null,
          crmLeadId: lead.id,
          kind: "contact_form",
          test: testFlag,
          contact: { name: name || null, email: email || null, phone: phone || null },
          landingUrl: pick(payload, ["landingurl", "landingpage", "pageurl"]) || null,
          utm: utmFrom(payload),
        }).catch((e) => console.error("[hooks] lead ledger write failed:", e));
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
      return NextResponse.json({ ok: true, lead_id: lead.id }, { headers: CORS });
    }

    // fire_automation
    if (!cfg.automation_id) {
      return NextResponse.json(
        { error: "Endpoint has no automation configured." },
        { status: 409, headers: CORS },
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
        { status: 409, headers: CORS },
      );
    }
    await enrollAutomationRun(supabase, automation, {
      trigger: "webhook",
      payload: { ...payload, endpoint_id: endpoint.id },
    });
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Webhook failed." },
      { status: 500, headers: CORS },
    );
  }
}
