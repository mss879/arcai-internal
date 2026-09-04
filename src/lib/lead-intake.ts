import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fireAutomationTrigger } from "@/lib/automation";
import { findClientByPhoneOrEmail } from "@/lib/contacts";
import { topLeadPosition } from "@/lib/crm";
import type { Database, LeadUtm } from "@/lib/database.types";
import { normalizePhone } from "@/lib/sms-utils";

type DB = SupabaseClient<Database>;
type Lead = Database["public"]["Tables"]["leads"]["Row"];

/**
 * The one way an inbound enquiry becomes a lead.
 *
 * Four things create leads from outside the CRM — the public form, an inbound
 * webhook, the website's own contact form, and (soon) the site-audit magnet
 * and the website chat. Each grew its own copy of "which pipeline, which
 * stage, is this a duplicate", and they had already drifted: the form route
 * deduped nothing at all, so a client who filled the form twice appeared
 * twice, and the person who called them had no way to know.
 *
 * This is that logic, once:
 *
 *   • where it lands — `app_settings.lead_form`, else the first pipeline's
 *     first stage;
 *   • whether we already know them — an OPEN lead with the same normalised
 *     phone or email is updated rather than duplicated, and a matching client
 *     is linked;
 *   • where they came from — utm, referrer, landing page, referral code;
 *   • and the two triggers that start the keep-warm automations.
 */

export type InboundLeadInput = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  message?: string | null;
  service?: string | null;
  /** Free text, e.g. 'form', 'website_chat', 'audit_magnet', 'webhook'. */
  source?: string | null;
  company?: string | null;
  companyWebsite?: string | null;
  value?: number | null;
  /**
   * Where to put it, when the caller knows better than app_settings — an
   * inbound webhook endpoint carries its own pipeline and stage.
   */
  pipelineId?: string | null;
  stageId?: string | null;
  /** Overrides the generated title. */
  title?: string | null;
  utm?: LeadUtm | null;
  referrer?: string | null;
  landingUrl?: string | null;
  /** A client's referral code, from `?ref=`. */
  referralCode?: string | null;
  /** Extra tags beyond 'inbound'. */
  tags?: string[];
  /** Payload passed to the automation triggers. */
  meta?: Record<string, unknown>;
};

export type InboundLeadResult =
  | { ok: true; lead: Lead; duplicate: boolean }
  | { ok: false; error: string };

/** Where a new inbound lead lands. */
async function destination(
  db: DB,
): Promise<{ pipelineId: string; stageId: string | null } | null> {
  const { data: setting } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "lead_form")
    .maybeSingle();
  const cfg = (setting?.value ?? {}) as { pipeline_id?: string; stage_id?: string };

  let pipelineId = cfg.pipeline_id ?? null;
  let stageId = cfg.stage_id ?? null;

  if (!pipelineId) {
    const { data: pipe } = await db
      .from("pipelines")
      .select("id")
      .order("position")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    pipelineId = pipe?.id ?? null;
  }
  if (!pipelineId) return null;

  if (!stageId) {
    const { data: stage } = await db
      .from("pipeline_stages")
      .select("id")
      .eq("pipeline_id", pipelineId)
      .order("position")
      .limit(1)
      .maybeSingle();
    stageId = stage?.id ?? null;
  }
  return { pipelineId, stageId };
}

/**
 * An OPEN lead for the same person, if there is one.
 *
 * Only open leads: someone who enquired, was marked lost, and has come back
 * six months later is a NEW opportunity, not an update to a dead one.
 */
async function existingOpenLead(
  db: DB,
  phone: string | null,
  email: string | null,
): Promise<Lead | null> {
  if (phone) {
    const normalised = normalizePhone(phone);
    if (normalised.ok) {
      const { data } = await db
        .from("leads")
        .select("*")
        .eq("contact_phone_norm", normalised.value)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) return data;
    }
  }
  if (email) {
    const { data } = await db
      .from("leads")
      .select("*")
      .ilike("contact_email", email.trim())
      .eq("status", "open")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

export async function createInboundLead(
  db: DB,
  input: InboundLeadInput,
): Promise<InboundLeadResult> {
  const name = (input.name ?? "").trim();
  const phone = (input.phone ?? "").trim();
  const email = (input.email ?? "").trim();
  const message = (input.message ?? "").trim();
  const service = (input.service ?? "").trim();
  const source = (input.source ?? "form").trim() || "form";

  if (!name && !phone && !email) {
    return { ok: false, error: "Provide at least a name, phone or email." };
  }

  // Who is this? A known client gets linked; a referral code is resolved to
  // the client who shared it.
  const [client, referrer] = await Promise.all([
    findClientByPhoneOrEmail(db, { phone, email }),
    input.referralCode
      ? db
          .from("clients")
          .select("id")
          .eq("referral_code", input.referralCode.trim().toUpperCase())
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
  ]);

  const attribution = {
    utm: input.utm ?? {},
    referrer: input.referrer?.trim() || null,
    landing_url: input.landingUrl?.trim() || null,
    referral_code: input.referralCode?.trim().toUpperCase() || null,
    referred_by_client_id: referrer?.id ?? null,
  };

  // --- Already have them? Add to that lead rather than making a second ---
  const open = await existingOpenLead(db, phone, email);
  if (open) {
    const appended = [open.notes, message && `${new Date().toISOString().slice(0, 10)}: ${message}`]
      .filter(Boolean)
      .join("\n\n");
    const { data: updated } = await db
      .from("leads")
      .update({
        notes: appended || open.notes,
        contact_name: open.contact_name || name || null,
        contact_phone: open.contact_phone || phone || null,
        contact_email: open.contact_email || email || null,
        client_id: open.client_id ?? client?.id ?? null,
        // Attribution from the FIRST touch is the one that earned them, so
        // it is only filled in where it was blank.
        utm: Object.keys(open.utm ?? {}).length ? open.utm : attribution.utm,
        referrer: open.referrer ?? attribution.referrer,
        landing_url: open.landing_url ?? attribution.landing_url,
        referral_code: open.referral_code ?? attribution.referral_code,
        referred_by_client_id:
          open.referred_by_client_id ?? attribution.referred_by_client_id,
      })
      .eq("id", open.id)
      .select("*")
      .single();

    const lead = updated ?? open;
    await db.from("lead_activities").insert({
      lead_id: lead.id,
      kind: "note",
      title: "They got in touch again",
      body: message || `A second enquiry arrived via ${source}.`,
      actor_id: null,
    });
    // form_submitted fires — they DID submit — but not lead_created, or the
    // welcome sequence starts over from the top.
    await fireAutomationTrigger(db, {
      trigger: "form_submitted",
      lead,
      payload: { message, service, source, repeat: true, ...(input.meta ?? {}) },
    });
    return { ok: true, lead, duplicate: true };
  }

  // --- New lead ---------------------------------------------------------
  const where = input.pipelineId
    ? { pipelineId: input.pipelineId, stageId: input.stageId ?? null }
    : await destination(db);
  if (!where) return { ok: false, error: "No CRM pipeline exists yet." };

  const { data: lead, error } = await db
    .from("leads")
    .insert({
      pipeline_id: where.pipelineId,
      stage_id: where.stageId,
      title:
        input.title?.trim() ||
        (service ? `${name || "Inquiry"} — ${service}` : name || "Website inquiry"),
      contact_name: name || null,
      contact_phone: phone || null,
      contact_email: email || null,
      company: input.company?.trim() || null,
      company_website: input.companyWebsite?.trim() || null,
      value: input.value ?? null,
      notes: message || null,
      source,
      client_id: client?.id ?? null,
      tags: [...new Set(["inbound", ...(input.tags ?? [])])],
      ...attribution,
      // Land at the top of the stage column, above existing cards.
      position: where.stageId ? await topLeadPosition(db, where.stageId) : 0,
      created_by: null,
    })
    .select("*")
    .single();

  if (error || !lead) {
    return { ok: false, error: error?.message ?? "Could not create the lead." };
  }

  // A referral is recorded the moment the lead exists, so the introduction is
  // credited even if the deal takes months.
  if (attribution.referral_code && attribution.referred_by_client_id) {
    await db.from("referrals").insert({
      code: attribution.referral_code,
      referrer_client_id: attribution.referred_by_client_id,
      referred_lead_id: lead.id,
      status: "pending",
    });
  }

  const payload = { message, service, source, ...(input.meta ?? {}) };
  await fireAutomationTrigger(db, { trigger: "form_submitted", lead, payload });
  await fireAutomationTrigger(db, {
    trigger: "lead_created",
    lead,
    payload,
    triggerKey: `${lead.id}:created`,
  });

  return { ok: true, lead, duplicate: false };
}
