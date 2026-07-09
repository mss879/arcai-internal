"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { createClient } from "@/lib/supabase/server";
import {
  drainProspectScan,
  isProspectingConfigured,
  processPendingProspectScans,
  queueScanRecheck,
  requalifyCandidate,
} from "@/lib/prospecting";
import { sendGenericEmail } from "@/lib/email";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";
import type { ActionResult } from "@/lib/types";

export type StartScanInput = {
  country: string;
  city: string;
  categories: string[];
  max_results: number;
  min_score: number;
  fire_automations: boolean;
  pipeline_id?: string | null;
  stage_id?: string | null;
};

/**
 * Launch a "Find Leads" scan. Returns as soon as the row is queued — the
 * Places + Firecrawl + OpenAI work runs after the response via `after()`
 * (and the automation tick resumes it if that pass is cut short), so the
 * click never hangs. The page shows live progress via realtime + the
 * `useDriveProspecting` poll.
 */
export async function startProspectScan(
  input: StartScanInput,
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!isProspectingConfigured()) {
    return {
      ok: false,
      error:
        "Prospecting isn't configured. Add GOOGLE_PLACES_API_KEY (business discovery) and FIRECRAWL_API_KEY (website checks) to .env.local.",
    };
  }
  const city = input.city.trim();
  if (!city) return { ok: false, error: "Pick a city or area to scan." };
  if (!input.categories.length) {
    return { ok: false, error: "Pick at least one business category." };
  }

  const { data, error } = await supabase
    .from("prospect_scans")
    .insert({
      country: input.country.trim() || "Sri Lanka",
      city,
      categories: input.categories.slice(0, 12),
      max_results: Math.min(Math.max(input.max_results, 5), 120),
      min_score: Math.min(Math.max(input.min_score, 20), 90),
      fire_automations: input.fire_automations,
      pipeline_id: input.pipeline_id || null,
      stage_id: input.stage_id || null,
      analysis: { runStartedAt: Date.now() },
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not start the scan." };
  }

  const scanId = data.id;
  after(async () => {
    await drainProspectScan(supabase, scanId);
  });

  revalidatePath("/crm/prospecting");
  return { ok: true, id: scanId };
}

/**
 * Advance any in-progress scan while the page is open (the local-dev cron
 * substitute + orphan resumer — the same pattern as `advanceResearch`).
 * Never throws; the next poll retries.
 */
export async function advanceProspecting(): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  try {
    await processPendingProspectScans(supabase, 3);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Re-check EVERY scrape-based verdict in a scan (the "Re-check all" button).
 * Returns as soon as the ids are queued — the scan re-enters `qualifying`
 * and the pipeline (inline drain here + tick + page poll) works through the
 * batches in the background, then re-drafts changed pitches and imports any
 * newly-qualified candidates. Progress shows live like a normal scan.
 */
export async function recheckScanAll(
  scanId: string,
): Promise<ActionResult<{ queued: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  try {
    const res = await queueScanRecheck(supabase, scanId);
    if (!res.ok) return res;

    after(async () => {
      await drainProspectScan(supabase, scanId, 80);
    });

    revalidatePath("/crm/prospecting");
    return { ok: true, queued: res.queued };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Re-check failed.",
    };
  }
}

/**
 * Re-run the full verification ladder for one prospect (the "Re-check"
 * button) — fresh scrape with retry, direct HTTP probe, re-grade. If the
 * re-check re-opened the scan's drafting step (a newly-qualified candidate
 * needs a pitch/lead), drain the pipeline after the response so it lands
 * without waiting for the next tick.
 */
export async function recheckProspect(
  candidateId: string,
): Promise<ActionResult<{ verdict: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  try {
    const res = await requalifyCandidate(supabase, candidateId);
    if (!res.ok) return res;

    const { data: c } = await supabase
      .from("prospect_candidates")
      .select("scan_id")
      .eq("id", candidateId)
      .maybeSingle();
    if (c) {
      const scanId = c.scan_id;
      after(async () => {
        await drainProspectScan(supabase, scanId);
      });
    }

    revalidatePath("/crm/prospecting");
    return { ok: true, verdict: res.verdict };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Re-check failed.",
    };
  }
}

/** Send the drafted cold email to a qualified candidate, and log it. */
export async function sendProspectEmail(
  candidateId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: c } = await supabase
    .from("prospect_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (!c) return { ok: false, error: "Prospect not found." };

  const to = c.emails[0];
  if (!to) return { ok: false, error: "No email address found for this prospect." };
  if (!c.draft_body) return { ok: false, error: "No draft to send yet." };

  try {
    const sent = await sendGenericEmail({
      to,
      subject: c.draft_subject || `A website for ${c.name}?`,
      body: c.draft_body,
    });
    if (!sent.sent) {
      return { ok: false, error: sent.error || "Email could not be sent." };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Email could not be sent.",
    };
  }

  await supabase
    .from("prospect_candidates")
    .update({ status: "emailed" })
    .eq("id", candidateId);
  if (c.lead_id) {
    await supabase.from("lead_activities").insert({
      lead_id: c.lead_id,
      kind: "email",
      title: `Cold email sent: ${c.draft_subject || "outreach"}`,
      body: c.draft_body,
    });
  }

  revalidatePath("/crm/prospecting");
  return { ok: true };
}

/** Send the drafted cold SMS to a qualified candidate, and log it. */
export async function sendProspectSms(
  candidateId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!isSmsConfigured()) {
    return { ok: false, error: "SMS isn't configured (Notify.lk keys missing)." };
  }

  const { data: c } = await supabase
    .from("prospect_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (!c) return { ok: false, error: "Prospect not found." };
  if (!c.draft_sms) return { ok: false, error: "No SMS draft for this prospect." };

  const phone = normalizePhone(c.phone);
  if (!phone.ok) return { ok: false, error: phone.error };

  const sent = await sendSms({
    to: phone.value,
    message: c.draft_sms,
    contactName: c.contact_name || c.name,
  });

  await supabase.from("sms_messages").insert({
    to_number: phone.value,
    message: c.draft_sms,
    client_name: c.name,
    kind: "prospecting",
    status: sent.ok ? "sent" : "failed",
    error: sent.ok ? null : sent.error,
    segments: countSmsSegments(c.draft_sms),
    created_by: user.id,
  });
  if (!sent.ok) return { ok: false, error: sent.error };

  await supabase
    .from("prospect_candidates")
    .update({ status: "emailed" })
    .eq("id", candidateId);
  if (c.lead_id) {
    await supabase.from("lead_activities").insert({
      lead_id: c.lead_id,
      kind: "sms",
      title: "Cold SMS sent",
      body: c.draft_sms,
    });
  }

  revalidatePath("/crm/prospecting");
  return { ok: true };
}

/** Delete a scan (its candidate rows cascade; imported CRM leads remain). */
export async function deleteProspectScan(scanId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("prospect_scans")
    .delete()
    .eq("id", scanId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm/prospecting");
  return { ok: true };
}
