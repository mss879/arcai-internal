import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { getWaAgentConfig, isQuietHours } from "@/lib/wa-agent";
import { localDateInTimezone } from "@/lib/wa-coaching";
import { isWhatsAppConfigured, sendWhatsAppTemplate } from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;
type WaConfig = Database["public"]["Tables"]["wa_agent_config"]["Row"];

/**
 * Revival — knock again on doors that once opened.
 *
 * Cold outreach opens NEW conversations; this re-opens OLD ones: contacts
 * who genuinely talked to us (at least one inbound message) and then went
 * silent past the configured age. Each gets ONE approved-template message —
 * the 24h window is long dead, so a template is the only thing Meta will
 * carry — and their reply, if it comes, flows into the normal agent
 * pipeline like any inbound message.
 *
 * Deliberately timid, because re-engagement templates are Marketing
 * category and Meta frequency-caps senders who spray them:
 *
 *   - OFF by default (`revival_enabled`) until the team picks a template
 *   - hard daily cap (default 3), one send per tick, ≥90 min apart
 *   - once per contact per 90 days, ever
 *   - quiet-hours aware; skips anyone with an open deal signal (pending
 *     promise, future booked call) or a closed lead
 *
 * Reply detection is polled here (the cold-outreach pattern): the webhook
 * only stamps wa_contacts.last_inbound_at, and any inbound newer than our
 * send flips the row to `replied`.
 */

const REVIVAL_GAP_MIN_MS = 90 * 60_000;
const REVIVAL_COOLDOWN_DAYS = 90;
const CANDIDATE_POOL = 25;

export type WaRevivalTick = {
  sent: number;
  replied: number;
  skipped: number;
};

export async function processWaRevival(supabase: DB): Promise<WaRevivalTick> {
  const out: WaRevivalTick = { sent: 0, replied: 0, skipped: 0 };
  try {
    if (!isWhatsAppConfigured()) return out;
    const config = await getWaAgentConfig(supabase);

    // Reconcile replies first — it's free and keeps the stats honest even
    // while sending is disabled.
    out.replied = await reconcileReplies(supabase);

    if (!config.enabled || !config.revival_enabled) return out;
    const template = config.revival_template_name?.trim();
    if (!template) return out;
    if (isQuietHours(config)) return out;

    const tz = config.timezone || "Asia/Colombo";
    const today = localDateInTimezone(tz);

    // Daily cap — failed attempts burn a slot on purpose (a broken template
    // must never retry itself into Meta's spam radar).
    const { count: usedToday } = await supabase
      .from("wa_revival")
      .select("id", { count: "exact", head: true })
      .eq("picked_for", today)
      .in("status", ["sent", "failed"]);
    if ((usedToday ?? 0) >= (config.revival_daily_cap ?? 3)) return out;

    // Spacing — the most recent send anywhere must be ≥90 min old.
    const { data: lastSent } = await supabase
      .from("wa_revival")
      .select("sent_at")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (
      lastSent?.sent_at &&
      Date.now() - Date.parse(lastSent.sent_at) < REVIVAL_GAP_MIN_MS
    )
      return out;

    const contact = await pickCandidate(supabase, config);
    if (!contact) return out;

    // Claim first: the row exists before the send, so a crash mid-send can
    // never double-message the same contact (the 90-day check sees the row).
    const { data: claim, error: claimError } = await supabase
      .from("wa_revival")
      .insert({
        contact_id: contact.id,
        picked_for: today,
        status: "queued",
        template_name: template,
        template_lang: config.revival_template_lang || "en",
      })
      .select("id")
      .single();
    if (claimError || !claim) {
      console.error(
        "[wa-revival] claim failed (is migration 0076 applied?):",
        claimError?.message,
      );
      return out;
    }

    const name =
      contact.display_name || contact.profile_name || "there";
    const params = (config.revival_template_params ?? [])
      .map((p) => p.replaceAll("{{name}}", name).trim())
      .filter(Boolean);

    const sent = await sendWhatsAppTemplate({
      to: contact.wa_id,
      template,
      language: config.revival_template_lang || "en",
      bodyParams: params.length ? params : undefined,
    });

    if (!sent.ok) {
      await supabase
        .from("wa_revival")
        .update({ status: "failed", sent_at: new Date().toISOString(), error: sent.error })
        .eq("id", claim.id);
      console.error("[wa-revival] send failed:", sent.error);
      return out;
    }

    await supabase
      .from("wa_revival")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        wa_message_id: sent.waMessageId,
        error: null,
      })
      .eq("id", claim.id);

    const bodyText = `[template: ${template}]`;
    await supabase.from("wa_messages").insert({
      contact_id: contact.id,
      wa_message_id: sent.waMessageId,
      direction: "out",
      body: bodyText,
      status: "sent",
      sent_by: "automation",
    });
    await supabase
      .from("wa_contacts")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: bodyText.slice(0, 160),
        last_direction: "out",
      })
      .eq("id", contact.id);

    out.sent = 1;
  } catch (e) {
    console.error("[wa-revival] tick failed:", e);
  }
  return out;
}

/** One eligible aged-out contact, warmest first — or null. */
async function pickCandidate(
  supabase: DB,
  config: WaConfig,
): Promise<
  | {
      id: string;
      wa_id: string;
      display_name: string | null;
      profile_name: string | null;
    }
  | null
> {
  const minAgeMs = (config.revival_min_age_days ?? 30) * 86400_000;
  const cutoff = new Date(Date.now() - minAgeMs).toISOString();

  const { data: candidates } = await supabase
    .from("wa_contacts")
    .select("id, wa_id, display_name, profile_name, lead_id, call_booked_at")
    .eq("agent_enabled", true)
    .eq("do_not_contact", false)
    .eq("needs_attention", false)
    .not("last_inbound_at", "is", null)
    .lte("last_message_at", cutoff)
    .order("last_message_at", { ascending: false })
    .limit(CANDIDATE_POOL);

  for (const c of candidates ?? []) {
    // A call still on the horizon means the timeline is owned already.
    if (c.call_booked_at && new Date(c.call_booked_at).getTime() > Date.now())
      continue;

    // Closed deals stay closed — won needs no revival, lost said no.
    if (c.lead_id) {
      const { data: lead } = await supabase
        .from("leads")
        .select("status")
        .eq("id", c.lead_id)
        .maybeSingle();
      if (lead && lead.status !== "open") continue;
    }

    // The customer named their own moment? The promise engine owns it.
    const { data: promise } = await supabase
      .from("wa_promises")
      .select("id")
      .eq("contact_id", c.id)
      .eq("status", "pending")
      .limit(1);
    if (promise?.length) continue;

    // Once per 90 days, ever — a second knock inside the window is spam.
    const { data: recent } = await supabase
      .from("wa_revival")
      .select("id")
      .eq("contact_id", c.id)
      .gte(
        "created_at",
        new Date(Date.now() - REVIVAL_COOLDOWN_DAYS * 86400_000).toISOString(),
      )
      .limit(1);
    if (recent?.length) continue;

    return c;
  }
  return null;
}

/** Sent rows whose contact wrote back after our send become `replied`. */
async function reconcileReplies(supabase: DB): Promise<number> {
  const { data: open } = await supabase
    .from("wa_revival")
    .select("id, contact_id, sent_at")
    .eq("status", "sent")
    .gte(
      "created_at",
      new Date(Date.now() - REVIVAL_COOLDOWN_DAYS * 86400_000).toISOString(),
    )
    .limit(20);
  if (!open?.length) return 0;

  let flipped = 0;
  for (const row of open) {
    if (!row.sent_at) continue;
    const { data: contact } = await supabase
      .from("wa_contacts")
      .select("last_inbound_at")
      .eq("id", row.contact_id)
      .maybeSingle();
    if (
      contact?.last_inbound_at &&
      Date.parse(contact.last_inbound_at) > Date.parse(row.sent_at)
    ) {
      // Compare-and-set on status so a concurrent tick can't double-flip.
      const { data: updated } = await supabase
        .from("wa_revival")
        .update({ status: "replied", replied_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "sent")
        .select("id");
      if (updated?.length) flipped++;
    }
  }
  return flipped;
}
