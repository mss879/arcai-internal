import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, WaColdOutreachStatus } from "@/lib/database.types";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import { moveLeadToStageByName } from "@/lib/crm";
import { queueLeadResearch } from "@/lib/research";
import { getWaAgentConfig, isQuietHours, notifyEveryone } from "@/lib/wa-agent";
import {
  isWhatsAppConfigured,
  normalizeWaPhone,
  sendWhatsAppTemplate,
} from "@/lib/whatsapp";

type DB = SupabaseClient<Database>;
type WaConfig = Database["public"]["Tables"]["wa_agent_config"]["Row"];
type ColdRow = Database["public"]["Tables"]["wa_cold_outreach"]["Row"];
type LeadRow = Database["public"]["Tables"]["leads"]["Row"];

/**
 * Automatic WhatsApp cold outreach — the agent works the "New Lead" column.
 *
 * Every day it takes the top leads of the cold stage IN BOARD ORDER (top
 * card first — no AI ranking), researches each company first, then opens
 * the conversation with a Meta-approved template. Hard rules that protect
 * the WhatsApp number:
 *
 *   - at most `cold_daily_cap` (default 5) counted sends per Colombo day
 *   - sends spread ≥90 min apart (plus deterministic jitter), and only
 *     outside the agent's quiet hours
 *   - one lead in flight at a time; a number that turns out not to be on
 *     WhatsApp is tagged "no-whatsapp" with a remark on the lead, doesn't
 *     count toward the cap, and the next lead takes its slot the same day
 *
 * State machine per row (unique lead_id AND unique wa_id — a lead/number
 * is only ever attempted once):
 *
 *   researching → ready → sent → delivered → replied
 *                                  ↘ no_whatsapp (slot freed)
 *                       ↘ failed (counts — a broken template burns at most
 *                                 cap slots/day, never the whole lead list)
 *                       ↘ skipped (lead engaged/moved/deleted mid-flight)
 *
 * Meta reality: a business-initiated (cold) message MUST be an approved
 * template — free-form text only works inside the 24h window after they
 * reply. And there is no API to pre-check a number is on WhatsApp; the
 * only signal is the async delivery-status webhook (error 131026 =
 * undeliverable = not on WhatsApp).
 */

const COLD_GAP_MIN_MS = 90 * 60_000;
const COLD_GAP_JITTER_MAX_MS = 30 * 60_000;
/** How long a pick may wait on its research dossier before sending anyway. */
const COLD_RESEARCH_WAIT_MS = 30 * 60_000;
const LOCK_TTL_MS = 45_000;
const CANDIDATE_POOL = 60;
/** Statuses that consume a daily slot. no_whatsapp/skipped free theirs. */
const CAP_COUNTING: WaColdOutreachStatus[] = [
  "sent",
  "delivered",
  "replied",
  "failed",
];
const IN_FLIGHT: WaColdOutreachStatus[] = ["researching", "ready"];

export type ColdOutreachTick = {
  reconciled: number;
  picked: number;
  sent: number;
  noWhatsApp: number;
  skipped: number;
  nudged: number;
};

/**
 * The automation-tick entry point. Never throws. Three phases, each fenced
 * so one failure can't break the others:
 *   A) reconcile delivery statuses (delivered/replied/no-whatsapp/failed)
 *   B) advance the in-flight row (wait for research → send the template)
 *   C) pick the next candidate when a slot is open
 */
export async function processColdOutreach(
  supabase: DB,
): Promise<ColdOutreachTick> {
  const out: ColdOutreachTick = {
    reconciled: 0,
    picked: 0,
    sent: 0,
    noWhatsApp: 0,
    skipped: 0,
    nudged: 0,
  };
  if (!isWhatsAppConfigured()) return out;

  try {
    const config = await getWaAgentConfig(supabase);
    if (!config.cold_outreach_enabled) return out;
    if (!config.cold_template_name?.trim()) return out;

    const stageId = await resolveColdStage(supabase, config);

    try {
      const r = await reconcileColdStatuses(supabase);
      out.reconciled = r.reconciled;
      out.noWhatsApp = r.noWhatsApp;
    } catch (e) {
      console.error("[wa-cold] reconcile failed:", e);
    }

    // The already-picked lead was promised today's slot — advance it first.
    if (stageId) {
      try {
        const b = await advanceInflight(supabase, config, stageId);
        out.sent = b.sent;
        out.skipped = b.skipped;
      } catch (e) {
        console.error("[wa-cold] advance failed:", e);
      }
    }

    // Nudging a delivered lead beats opening a new one — and must keep
    // working even if the pick stage config breaks.
    try {
      out.nudged = (await sendColdFollowups(supabase, config)).nudged;
    } catch (e) {
      console.error("[wa-cold] followups failed:", e);
    }

    if (stageId) {
      try {
        out.picked = await pickNextCandidate(supabase, config, stageId);
      } catch (e) {
        console.error("[wa-cold] pick failed:", e);
      }
    }
  } catch (e) {
    console.error("[wa-cold] tick failed:", e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase A — reconcile delivery statuses
// ---------------------------------------------------------------------------

/**
 * Fold the async webhook signals back into our rows: a reply wins, then
 * delivered/read, then failure — where Meta error 131026 ("message
 * undeliverable") means the number has no WhatsApp account. That lead is
 * tagged and remarked, and its slot re-opens for the next lead today.
 */
async function reconcileColdStatuses(
  supabase: DB,
): Promise<{ reconciled: number; noWhatsApp: number }> {
  // Watch a row for 7 days after its LATEST touch — a nudge re-opens the
  // window so replies to the follow-up still flip the row.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: rows } = await supabase
    .from("wa_cold_outreach")
    .select(
      "id, lead_id, contact_id, wa_message_id, status, sent_at, followup_sent_at, followup_wa_message_id, error",
    )
    .in("status", ["sent", "delivered"])
    .or(`sent_at.gte.${since},followup_sent_at.gte.${since}`)
    .limit(25);

  let reconciled = 0;
  let noWhatsApp = 0;
  for (const row of rows ?? []) {
    // A reply is the strongest signal — the conversation is live and the
    // agent has already taken over.
    if (row.contact_id && row.sent_at) {
      const { data: contact } = await supabase
        .from("wa_contacts")
        .select("last_inbound_at")
        .eq("id", row.contact_id)
        .maybeSingle();
      if (
        contact?.last_inbound_at &&
        Date.parse(contact.last_inbound_at) > Date.parse(row.sent_at)
      ) {
        await supabase
          .from("wa_cold_outreach")
          .update({ status: "replied", replied_at: new Date().toISOString() })
          .eq("id", row.id)
          .eq("status", row.status);
        reconciled++;
        continue;
      }
    }

    // Nudge delivery status (delivered rows that were followed up).
    if (row.status === "delivered" && row.followup_wa_message_id && !row.error) {
      const { data: fuMsg } = await supabase
        .from("wa_messages")
        .select("status, error")
        .eq("wa_message_id", row.followup_wa_message_id)
        .maybeSingle();
      if (fuMsg?.status === "failed") {
        const err = fuMsg.error ?? "Nudge delivery failed.";
        if (/131026|undeliverab/i.test(err)) {
          // Rare: the number left WhatsApp since the first delivery.
          await supabase
            .from("wa_cold_outreach")
            .update({ status: "no_whatsapp", error: err })
            .eq("id", row.id)
            .eq("status", "delivered");
          await setLeadTags(supabase, row.lead_id, ["no-whatsapp"], ["WhatsApp Sent"]);
          await noteOnLead(
            supabase,
            row.lead_id,
            "This number isn't on WhatsApp anymore",
            "The follow-up nudge couldn't be delivered — the number no longer has WhatsApp.",
          );
          noWhatsApp++;
        } else {
          // Record once (the !row.error guard); status stays delivered.
          await supabase
            .from("wa_cold_outreach")
            .update({ error: err })
            .eq("id", row.id)
            .eq("status", "delivered");
          reconciled++;
        }
        continue;
      }
    }

    if (row.status !== "sent" || !row.wa_message_id) continue;
    const { data: msg } = await supabase
      .from("wa_messages")
      .select("status, error")
      .eq("wa_message_id", row.wa_message_id)
      .maybeSingle();
    if (!msg) continue;

    if (msg.status === "delivered" || msg.status === "read") {
      await supabase
        .from("wa_cold_outreach")
        .update({ status: "delivered" })
        .eq("id", row.id)
        .eq("status", "sent");
      reconciled++;
    } else if (msg.status === "failed") {
      const err = msg.error ?? "Delivery failed.";
      if (/131026|undeliverab/i.test(err)) {
        // Not on WhatsApp: skip forever, remark on the lead, free the slot.
        await supabase
          .from("wa_cold_outreach")
          .update({ status: "no_whatsapp", error: err })
          .eq("id", row.id)
          .eq("status", "sent");
        await setLeadTags(supabase, row.lead_id, ["no-whatsapp"], ["WhatsApp Sent"]);
        await noteOnLead(
          supabase,
          row.lead_id,
          "This number isn't on WhatsApp",
          "The cold WhatsApp message couldn't be delivered — the number has no WhatsApp account. Skipped; the next lead took this slot.",
        );
        noWhatsApp++;
      } else {
        // Some other failure (template paused, rate limit…) — counts toward
        // the cap so a broken setup can't churn through the lead list.
        await supabase
          .from("wa_cold_outreach")
          .update({ status: "failed", error: err })
          .eq("id", row.id)
          .eq("status", "sent");
        reconciled++;
      }
    }
  }
  return { reconciled, noWhatsApp };
}

// ---------------------------------------------------------------------------
// Phase B — advance the in-flight row (research wait → template send)
// ---------------------------------------------------------------------------

async function advanceInflight(
  supabase: DB,
  config: WaConfig,
  stageId: string,
): Promise<{ sent: number; skipped: number }> {
  const out = { sent: 0, skipped: 0 };
  const { data: rows } = await supabase
    .from("wa_cold_outreach")
    .select("id")
    .in("status", IN_FLIGHT)
    .order("updated_at", { ascending: true })
    .limit(3);

  for (const r of rows ?? []) {
    // Up to two steps per pass so researching → ready → sent can happen in
    // one tick when the dossier is already on file.
    for (let step = 0; step < 2; step++) {
      const outcome = await advanceColdRow(supabase, config, stageId, r.id);
      if (outcome === "sent") out.sent++;
      if (outcome === "skipped") out.skipped++;
      if (outcome !== "advanced") break;
    }
  }
  return out;
}

type StepOutcome = "advanced" | "sent" | "skipped" | "failed" | "waiting" | "none";

/** Advance ONE step of an in-flight row, lease-fenced like advanceOutreachRow. */
async function advanceColdRow(
  supabase: DB,
  config: WaConfig,
  stageId: string,
  rowId: string,
): Promise<StepOutcome> {
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed } = await supabase
    .from("wa_cold_outreach")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", rowId)
    .in("status", IN_FLIGHT)
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select("*");
  if (!claimed?.length) return "none";
  const row = claimed[0] as ColdRow;
  const token = row.locked_at;
  if (!token) return "none";

  const commit = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from("wa_cold_outreach")
      .update({ ...patch, locked_at: null })
      .eq("id", rowId)
      .eq("locked_at", token);
    if (error) throw new Error(error.message);
  };
  const release = () => commit({});

  try {
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("id", row.lead_id)
      .maybeSingle();
    if (!lead) {
      await commit({ status: "skipped", error: "Lead no longer exists." });
      return "skipped";
    }

    // researching → ready: wait for the dossier, but never forever. The
    // template text is fixed anyway — research is for the CONVERSATION, and
    // the agent can run research_contact when they reply.
    if (row.status === "researching") {
      const state = await researchState(supabase, row.lead_id);
      const startedAt = Date.parse(row.research_started_at ?? row.created_at);
      const timedOut = Date.now() - startedAt > COLD_RESEARCH_WAIT_MS;
      if (state === "in_flight" && !timedOut) {
        await release();
        return "waiting";
      }
      if (state !== "done") {
        await noteOnLead(
          supabase,
          row.lead_id,
          "Cold WhatsApp queued without research",
          "The company research didn't finish in time — the agent will research when they reply.",
        );
      }
      await commit({ status: "ready", error: null });
      return "advanced";
    }

    // ready → sent: only when the day allows it.
    if (isQuietHours(config)) {
      await release();
      return "waiting";
    }
    const usage = await capUsage(supabase, config);
    if (usage.used >= (config.cold_daily_cap ?? 5)) {
      await release();
      return "waiting";
    }
    if (usage.lastSentAt) {
      const gap = COLD_GAP_MIN_MS + jitterFor(usage.lastSentId ?? "");
      if (Date.now() - Date.parse(usage.lastSentAt) < gap) {
        await release();
        return "waiting";
      }
    }

    // The lead may have moved on while we waited — a human conversation or
    // stage change must never be followed by a cold template.
    if (lead.deleted_at || lead.status !== "open" || lead.stage_id !== stageId) {
      await commit({
        status: "skipped",
        error: "Lead was engaged or moved before the send.",
      });
      return "skipped";
    }
    const phone = normalizeWaPhone(lead.contact_phone ?? "");
    if (!phone.ok) {
      await commit({ status: "skipped", error: "Phone no longer valid." });
      return "skipped";
    }
    if (phone.value !== row.wa_id) {
      // Number edited since the pick. Re-anchor; if another row owns the
      // new number the unique index blocks it — skip rather than double-text.
      const { error } = await supabase
        .from("wa_cold_outreach")
        .update({ wa_id: phone.value })
        .eq("id", rowId)
        .eq("locked_at", token);
      if (error) {
        await commit({
          status: "skipped",
          error: "Phone now matches a number already contacted.",
        });
        return "skipped";
      }
    }

    const templateName = config.cold_template_name?.trim() ?? "";
    const templateLang = config.cold_template_lang?.trim() || "en";
    const params = renderColdParams(lead as LeadRow, config.cold_template_params ?? []);
    const sent = await sendWhatsAppTemplate({
      to: phone.value,
      template: templateName,
      language: templateLang,
      bodyParams: params.some(Boolean) ? params : undefined,
    });

    if (!sent.ok) {
      // Counts toward the cap (sent_at anchors the day + gap math) so a
      // broken template burns at most cap slots/day, not the lead list.
      await commit({
        status: "failed",
        error: sent.error,
        attempts: row.attempts + 1,
        sent_at: new Date().toISOString(),
        template_name: templateName,
        template_lang: templateLang,
        template_params: params,
      });
      await noteOnLead(supabase, row.lead_id, "Cold WhatsApp failed", sent.error);
      return "failed";
    }

    // Log into the WhatsApp inbox thread (create the contact if new) so the
    // reply lands in a linked conversation and the agent takes over.
    let { data: contact } = await supabase
      .from("wa_contacts")
      .select("id, lead_id")
      .eq("wa_id", phone.value)
      .maybeSingle();
    if (!contact) {
      const { data: created } = await supabase
        .from("wa_contacts")
        .upsert(
          {
            wa_id: phone.value,
            display_name:
              lead.contact_name?.trim() ||
              lead.company?.trim() ||
              lead.title,
            lead_id: row.lead_id,
            client_id: lead.client_id,
          },
          { onConflict: "wa_id" },
        )
        .select("id, lead_id")
        .single();
      contact = created;
    } else if (!contact.lead_id) {
      await supabase
        .from("wa_contacts")
        .update({ lead_id: row.lead_id })
        .eq("id", contact.id);
    }
    const bodyText = `[template: ${templateName}]`;
    if (contact) {
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
    }

    await commit({
      status: "sent",
      sent_at: new Date().toISOString(),
      wa_message_id: sent.waMessageId ?? null,
      contact_id: contact?.id ?? null,
      template_name: templateName,
      template_lang: templateLang,
      template_params: params,
      error: null,
    });
    await setLeadTags(supabase, row.lead_id, ["WhatsApp Sent"]);
    await noteOnLead(
      supabase,
      row.lead_id,
      "Cold WhatsApp sent",
      `Template "${templateName}" → +${phone.value}`,
    );
    // The board should say so: this lead has now been contacted.
    await moveLeadToStageByName(
      supabase,
      row.lead_id,
      ["contacted"],
      "Cold WhatsApp sent by the agent.",
    );
    return "sent";
  } catch (e) {
    // Release the lease fenced on the token; the row stays claimable.
    await supabase
      .from("wa_cold_outreach")
      .update({ locked_at: null, error: e instanceof Error ? e.message : "Step failed." })
      .eq("id", rowId)
      .eq("locked_at", token);
    return "none";
  }
}

// ---------------------------------------------------------------------------
// Phase D — ONE follow-up nudge for delivered-but-silent leads
// ---------------------------------------------------------------------------

/**
 * A cold message that was DELIVERED but got no reply for
 * `cold_followup_days` earns exactly ONE follow-up template — then the lead
 * is left alone forever. Only rows whose first touch is between `days` and
 * `days+7` old are considered: closed/ineligible leads age out of the window
 * instead of blocking the queue, and configuring the template weeks later
 * can't blast nudges at ancient leads. Nudges obey the same quiet-hours,
 * daily-cap and pacing-gap rules as first touches.
 */
async function sendColdFollowups(
  supabase: DB,
  config: WaConfig,
): Promise<{ nudged: number }> {
  const template = config.cold_followup_template_name?.trim();
  if (!template) return { nudged: 0 };
  if (isQuietHours(config)) return { nudged: 0 };

  const usage = await capUsage(supabase, config);
  if (usage.used >= (config.cold_daily_cap ?? 5)) return { nudged: 0 };
  if (usage.lastSentAt) {
    const gap = COLD_GAP_MIN_MS + jitterFor(usage.lastSentId ?? "");
    if (Date.now() - Date.parse(usage.lastSentAt) < gap) return { nudged: 0 };
  }

  const days = Math.min(14, Math.max(1, config.cold_followup_days ?? 3));
  const dueCutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const staleCutoff = new Date(
    Date.now() - (days + 7) * 86_400_000,
  ).toISOString();
  const { data: candidates } = await supabase
    .from("wa_cold_outreach")
    .select("id")
    .eq("status", "delivered")
    .is("followup_sent_at", null)
    .gte("sent_at", staleCutoff)
    .lt("sent_at", dueCutoff)
    .order("sent_at", { ascending: true })
    .limit(5);

  for (const c of candidates ?? []) {
    // Lease-claim so a concurrent tick can't double-nudge.
    const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
    const { data: claimed } = await supabase
      .from("wa_cold_outreach")
      .update({ locked_at: new Date().toISOString() })
      .eq("id", c.id)
      .eq("status", "delivered")
      .is("followup_sent_at", null)
      .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
      .select("*");
    if (!claimed?.length) continue;
    const row = claimed[0] as ColdRow;
    const token = row.locked_at;
    if (!token) continue;

    const commit = async (patch: Record<string, unknown>) => {
      const { error } = await supabase
        .from("wa_cold_outreach")
        .update({ ...patch, locked_at: null })
        .eq("id", c.id)
        .eq("locked_at", token);
      if (error) throw new Error(error.message);
    };

    try {
      // The lead may have closed since the first touch — never nudge a
      // won/lost/deleted deal. No status flip: the row simply ages out.
      const { data: lead } = await supabase
        .from("leads")
        .select("*")
        .eq("id", row.lead_id)
        .maybeSingle();
      if (!lead || lead.deleted_at || lead.status !== "open") {
        await commit({});
        continue;
      }
      const { data: contact } = row.contact_id
        ? await supabase
            .from("wa_contacts")
            .select("do_not_contact, last_inbound_at")
            .eq("id", row.contact_id)
            .maybeSingle()
        : await supabase
            .from("wa_contacts")
            .select("do_not_contact, last_inbound_at")
            .eq("wa_id", row.wa_id)
            .maybeSingle();
      if (contact?.do_not_contact) {
        await commit({});
        continue;
      }
      if (
        contact?.last_inbound_at &&
        row.sent_at &&
        Date.parse(contact.last_inbound_at) > Date.parse(row.sent_at)
      ) {
        // They replied but the reconcile window missed it — flip honestly.
        await commit({ status: "replied", replied_at: new Date().toISOString() });
        continue;
      }

      const lang = config.cold_followup_template_lang?.trim() || "en";
      const params = renderColdParams(
        lead as LeadRow,
        config.cold_followup_template_params ?? [],
      );
      const sent = await sendWhatsAppTemplate({
        to: row.wa_id,
        template,
        language: lang,
        bodyParams: params.some(Boolean) ? params : undefined,
      });

      if (!sent.ok) {
        // The ATTEMPT consumes the slot (followup_sent_at set) so a broken
        // template can't retry-hammer; status stays delivered.
        await commit({
          followup_sent_at: new Date().toISOString(),
          error: sent.error,
        });
        await noteOnLead(
          supabase,
          row.lead_id,
          "Cold WhatsApp nudge failed",
          sent.error,
        );
        return { nudged: 0 };
      }

      // Log into the inbox thread. Direct insert (NOT sendAndLogWa) so the
      // agent's own follow-up cadence is never armed by a nudge.
      const bodyText = `[template: ${template}]`;
      if (row.contact_id) {
        await supabase.from("wa_messages").insert({
          contact_id: row.contact_id,
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
          .eq("id", row.contact_id);
      }
      await commit({
        followup_sent_at: new Date().toISOString(),
        followup_wa_message_id: sent.waMessageId ?? null,
      });
      await noteOnLead(
        supabase,
        row.lead_id,
        "Cold WhatsApp nudge sent",
        `Template "${template}" → +${row.wa_id} — one follow-up only; if they stay silent this lead is done.`,
      );
      return { nudged: 1 };
    } catch (e) {
      // Release the lease fenced on the token; the row stays claimable.
      await supabase
        .from("wa_cold_outreach")
        .update({ locked_at: null })
        .eq("id", c.id)
        .eq("locked_at", token);
      console.error("[wa-cold] nudge failed:", e);
      return { nudged: 0 };
    }
  }
  return { nudged: 0 };
}

// ---------------------------------------------------------------------------
// Phase C — pick the next candidate (board order, no AI)
// ---------------------------------------------------------------------------

/**
 * When a slot is open, take the FIRST eligible lead of the cold stage in
 * board order — exactly the column the user sees, top card first.
 */
async function pickNextCandidate(
  supabase: DB,
  config: WaConfig,
  stageId: string,
): Promise<number> {
  if (isQuietHours(config)) return 0;

  // One lead in flight at a time.
  const { count: inflight } = await supabase
    .from("wa_cold_outreach")
    .select("*", { count: "exact", head: true })
    .in("status", IN_FLIGHT);
  if ((inflight ?? 0) > 0) return 0;

  const usage = await capUsage(supabase, config);
  if (usage.used >= (config.cold_daily_cap ?? 5)) return 0;
  if (usage.lastSentAt) {
    const gap = COLD_GAP_MIN_MS + jitterFor(usage.lastSentId ?? "");
    if (Date.now() - Date.parse(usage.lastSentAt) < gap) return 0;
  }

  const eligible = await eligibleColdCandidates(supabase, stageId);
  const winner = eligible[0];
  if (!winner) return 0;

  // Research-first: reuse a finished dossier as-is; wait on one already in
  // flight (a re-queue would RESET it); queue fresh otherwise. Leads with
  // no company name have nothing to research on.
  const company = winner.lead.company?.trim() || "";
  const state = company ? await researchState(supabase, winner.lead.id) : "none";
  const needsResearch = Boolean(company) && state !== "done";
  if (needsResearch && (state === "none" || state === "error")) {
    await queueLeadResearch(supabase, { leadId: winner.lead.id, company });
  }

  const { error } = await supabase.from("wa_cold_outreach").insert({
    lead_id: winner.lead.id,
    wa_id: winner.waId,
    status: needsResearch ? "researching" : "ready",
    picked_for: localDateInTimezone(config.timezone || "Asia/Colombo"),
    research_started_at: needsResearch ? new Date().toISOString() : null,
  });
  // Unique violation = a concurrent tick already picked — that's fine.
  if (error) return 0;

  await noteOnLead(
    supabase,
    winner.lead.id,
    "Queued for cold WhatsApp outreach",
    needsResearch
      ? "Running company research first — the message goes out once it's done."
      : "Research already on file — sending in the next open slot.",
  );
  return 1;
}

/**
 * The board-ordered list of leads the picker would take next, after every
 * eligibility filter: valid phone, no duplicate numbers in the batch, never
 * attempted before (by lead OR by number), not tagged no-whatsapp, and
 * genuinely cold (no WhatsApp history, not opted out). `pickNextCandidate`
 * takes `[0]`; the UI's "Up next" preview shows the first few — same code,
 * so the preview can never drift from what actually happens.
 */
async function eligibleColdCandidates(
  supabase: DB,
  stageId: string,
): Promise<{ lead: LeadRow; waId: string }[]> {
  const { data: leads } = await supabase
    .from("leads")
    .select("*")
    .eq("stage_id", stageId)
    .eq("status", "open")
    .is("deleted_at", null)
    .not("contact_phone", "is", null)
    .order("position", { ascending: true })
    .limit(CANDIDATE_POOL);
  if (!leads?.length) return [];

  const seen = new Set<string>();
  const candidates: { lead: LeadRow; waId: string }[] = [];
  for (const lead of leads as LeadRow[]) {
    if ((lead.tags ?? []).includes("no-whatsapp")) continue;
    const phone = normalizeWaPhone(lead.contact_phone ?? "");
    if (!phone.ok) continue;
    if (seen.has(phone.value)) continue;
    seen.add(phone.value);
    candidates.push({ lead, waId: phone.value });
  }
  if (!candidates.length) return [];

  const leadIds = candidates.map((c) => c.lead.id);
  const waIds = candidates.map((c) => c.waId);
  const [{ data: priorByLead }, { data: priorByWa }, { data: contacts }] =
    await Promise.all([
      supabase.from("wa_cold_outreach").select("lead_id").in("lead_id", leadIds),
      supabase.from("wa_cold_outreach").select("wa_id").in("wa_id", waIds),
      supabase
        .from("wa_contacts")
        .select("wa_id, do_not_contact, last_message_at, last_inbound_at")
        .in("wa_id", waIds),
    ]);
  const priorLeads = new Set((priorByLead ?? []).map((r) => r.lead_id));
  const priorWa = new Set((priorByWa ?? []).map((r) => r.wa_id));
  const blockedWa = new Set(
    (contacts ?? [])
      .filter((c) => c.do_not_contact || c.last_message_at || c.last_inbound_at)
      .map((c) => c.wa_id),
  );

  return candidates.filter(
    (c) =>
      !priorLeads.has(c.lead.id) &&
      !priorWa.has(c.waId) &&
      !blockedWa.has(c.waId),
  );
}

export type ColdQueuePreview = {
  leadId: string;
  label: string;
  waId: string;
};

/**
 * The UI's "Up next" list — who the agent will message, in order. Runs the
 * REAL picker's eligibility scan, so what you see is exactly what happens.
 * Works even while the feature is disabled (so the team can preview before
 * switching it on). Never throws.
 */
export async function previewColdQueue(
  supabase: DB,
  limit = 5,
): Promise<ColdQueuePreview[]> {
  try {
    const config = await getWaAgentConfig(supabase);
    const stageId = await resolveColdStage(supabase, config);
    if (!stageId) return [];
    const eligible = await eligibleColdCandidates(supabase, stageId);
    return eligible.slice(0, limit).map((c) => ({
      leadId: c.lead.id,
      label: c.lead.company?.trim() || c.lead.title,
      waId: c.waId,
    }));
  } catch (e) {
    console.error("[wa-cold] queue preview failed:", e);
    return [];
  }
}

/**
 * The stage the picker works: the configured one, else the "New Lead"
 * stage of the first pipeline (matched case-insensitively, first stage
 * as fallback).
 */
async function resolveColdStage(
  supabase: DB,
  config: WaConfig,
): Promise<string | null> {
  if (config.cold_stage_id) return config.cold_stage_id;
  let pipelineId = config.cold_pipeline_id;
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
  if (!pipelineId) return null;
  const { data: stages } = await supabase
    .from("pipeline_stages")
    .select("id, name")
    .eq("pipeline_id", pipelineId)
    .order("position");
  if (!stages?.length) return null;
  const newLead = DEFAULT_PIPELINE_STAGES[0].name.toLowerCase();
  const named = stages.find((s) => s.name.trim().toLowerCase() === newLead);
  return (named ?? stages[0]).id;
}

// ---------------------------------------------------------------------------
// Daily digest — the morning outreach summary
// ---------------------------------------------------------------------------

/**
 * Once a day, between 08:30 and 11:00 Colombo, tell the team how the cold
 * machine did yesterday and what's planned today. In-app + push only (no
 * SMS — it's routine, not urgent). Called from the tick as its own line, NOT
 * a phase of processColdOutreach: it must fire even when the cold template
 * is unset (that itself is worth surfacing). Never throws.
 */
export async function processColdDigest(
  supabase: DB,
): Promise<{ sent: boolean }> {
  try {
    const config = await getWaAgentConfig(supabase);
    if (!config.cold_outreach_enabled) return { sent: false };

    const tz = config.timezone || "Asia/Colombo";
    const mins = localMinutesOfDay(tz);
    if (mins < 8 * 60 + 30 || mins >= 11 * 60) return { sent: false };

    const today = localDateInTimezone(tz);
    if (config.cold_digest_sent_for === today) return { sent: false };

    // Claim-first: concurrent ticks (cron + the automation page) race here —
    // the conditional update lets exactly one win.
    const { data: claimed } = await supabase
      .from("wa_agent_config")
      .update({ cold_digest_sent_for: today })
      .eq("id", 1)
      .or(`cold_digest_sent_for.is.null,cold_digest_sent_for.neq.${today}`)
      .select("id");
    if (!claimed?.length) return { sent: false };

    // Yesterday's numbers, bucketed by Colombo-local date.
    const yesterday = localDateInTimezone(tz, new Date(Date.now() - 86_400_000));
    const since48h = new Date(Date.now() - 48 * 3600_000).toISOString();
    const { data: rows } = await supabase
      .from("wa_cold_outreach")
      .select("status, sent_at, followup_sent_at, replied_at")
      .or(
        `sent_at.gte.${since48h},followup_sent_at.gte.${since48h},replied_at.gte.${since48h}`,
      );
    const onDay = (at: string | null, day: string) =>
      Boolean(at) && localDateInTimezone(tz, new Date(at as string)) === day;

    const sentRows = (rows ?? []).filter((r) => onDay(r.sent_at, yesterday));
    const sentY = sentRows.length;
    const deliveredY = sentRows.filter((r) =>
      ["delivered", "replied"].includes(r.status),
    ).length;
    const noWaY = sentRows.filter((r) => r.status === "no_whatsapp").length;
    const failedY = sentRows.filter((r) => r.status === "failed").length;
    const repliedY = (rows ?? []).filter((r) => onDay(r.replied_at, yesterday)).length;
    const nudgedY = (rows ?? []).filter((r) =>
      onDay(r.followup_sent_at, yesterday),
    ).length;

    // Today's plan.
    const cap = config.cold_daily_cap ?? 5;
    const stageId = await resolveColdStage(supabase, config);
    let eligible = 0;
    if (stageId) {
      const { count } = await supabase
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("stage_id", stageId)
        .eq("status", "open")
        .is("deleted_at", null)
        .not("contact_phone", "is", null);
      eligible = count ?? 0;
    }
    let pendingNudges = 0;
    if (config.cold_followup_template_name?.trim()) {
      const days = Math.min(14, Math.max(1, config.cold_followup_days ?? 3));
      const { count } = await supabase
        .from("wa_cold_outreach")
        .select("*", { count: "exact", head: true })
        .eq("status", "delivered")
        .is("followup_sent_at", null)
        .gte("sent_at", new Date(Date.now() - (days + 7) * 86_400_000).toISOString())
        .lt("sent_at", new Date(Date.now() - days * 86_400_000).toISOString());
      pendingNudges = count ?? 0;
    }

    const body =
      sentY === 0 && nudgedY === 0 && repliedY === 0
        ? `Yesterday: no cold messages went out. Today: cap ${cap}, ${eligible} lead(s) waiting in the cold column — if that's 0, top up the New Lead column with leads that have phone numbers.`
        : `Yesterday: ${sentY} sent · ${deliveredY} delivered · ${repliedY} ${repliedY === 1 ? "reply" : "replies"}` +
          `${noWaY ? ` · ${noWaY} not on WhatsApp` : ""}` +
          `${failedY ? ` · ${failedY} failed` : ""}` +
          `${nudgedY ? ` · ${nudgedY} nudged` : ""}` +
          `. Today: cap ${cap}, ${eligible} lead(s) queued` +
          `${pendingNudges ? `, ${pendingNudges} nudge(s) due` : ""}.`;

    await notifyEveryone(supabase, {
      title: "☀️ WhatsApp outreach digest",
      body,
      link: "/whatsapp",
    });
    return { sent: true };
  } catch (e) {
    console.error("[wa-cold] digest failed:", e);
    return { sent: false };
  }
}

/** Minutes since local midnight in the given timezone. */
function localMinutesOfDay(timezone: string, at = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return h * 60 + (Number.isFinite(m) ? m : 0);
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Daily-cap usage. The day boundary is the WORKSPACE timezone's midnight
 * (Asia/Colombo), not the server's — a send at 11pm Colombo must not count
 * toward tomorrow. Follow-up nudges are business-initiated sends too, so
 * BOTH `sent_at` and `followup_sent_at` consume slots and anchor the pacing
 * gap. `lastSentAt` is the most recent counting send regardless of day;
 * no_whatsapp/skipped rows are invisible here, so a freed slot refills
 * without waiting the full gap.
 */
async function capUsage(
  supabase: DB,
  config: WaConfig,
): Promise<{ used: number; lastSentAt: string | null; lastSentId: string | null }> {
  const tz = config.timezone || "Asia/Colombo";
  const today = localDateInTimezone(tz);
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const { data: rows } = await supabase
    .from("wa_cold_outreach")
    .select("id, sent_at, followup_sent_at")
    .in("status", CAP_COUNTING)
    .or(`sent_at.gte.${since},followup_sent_at.gte.${since}`);

  let used = 0;
  let lastSentAt: string | null = null;
  let lastSentId: string | null = null;
  for (const r of rows ?? []) {
    // The ":fu" suffix gives a nudge its own jitter, distinct from the
    // first touch of the same row.
    const stamps: [string, string][] = [];
    if (r.sent_at) stamps.push([r.sent_at, r.id]);
    if (r.followup_sent_at) stamps.push([r.followup_sent_at, `${r.id}:fu`]);
    for (const [at, id] of stamps) {
      if (localDateInTimezone(tz, new Date(at)) === today) used++;
      if (!lastSentAt || Date.parse(at) > Date.parse(lastSentAt)) {
        lastSentAt = at;
        lastSentId = id;
      }
    }
  }
  return { used, lastSentAt, lastSentId };
}

/** YYYY-MM-DD in the given timezone (en-CA formats ISO-style). */
function localDateInTimezone(timezone: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Deterministic 0–30 min jitter derived from the last sent row's id —
 * stable across ticks (a fresh random each minute would re-roll the send
 * boundary and collapse the jitter to its minimum).
 */
function jitterFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % COLD_GAP_JITTER_MAX_MS;
}

/**
 * Fill the template's {{1}},{{2}}… body params from lead fields. Tokens:
 * {{business}} {{name}} {{first_name}} {{website}} {{city}} — anything
 * else renders empty rather than leaking a literal token to a prospect.
 */
export function renderColdParams(lead: LeadRow, tokens: string[]): string[] {
  const name = lead.contact_name?.trim() ?? "";
  const business = lead.company?.trim() || lead.title.trim();
  const custom = (lead.custom ?? {}) as Record<string, unknown>;
  const vars: Record<string, string> = {
    business,
    name: name || business,
    first_name: name.split(/\s+/)[0] || business,
    website: lead.company_website?.trim() ?? "",
    city: typeof custom.city === "string" ? custom.city : "",
  };
  return tokens.map((t) =>
    t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? ""),
  );
}

type ResearchState = "none" | "in_flight" | "done" | "error";

/** Where the lead's research dossier stands (drives wait-vs-send). */
async function researchState(
  supabase: DB,
  leadId: string,
): Promise<ResearchState> {
  const { data } = await supabase
    .from("lead_research")
    .select("status, report")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (!data) return "none";
  if (data.status === "done") {
    const report = (data.report ?? {}) as Record<string, unknown>;
    return Object.keys(report).length ? "done" : "error";
  }
  if (data.status === "error") return "error";
  return "in_flight";
}

/** Add/remove tags on a lead (Set-merge, idempotent). */
async function setLeadTags(
  supabase: DB,
  leadId: string,
  add: string[] = [],
  remove: string[] = [],
): Promise<void> {
  const { data: lead } = await supabase
    .from("leads")
    .select("tags")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return;
  const tags = new Set(lead.tags ?? []);
  add.forEach((t) => tags.add(t));
  remove.forEach((t) => tags.delete(t));
  await supabase.from("leads").update({ tags: Array.from(tags) }).eq("id", leadId);
}

/** A remark in the lead's activity timeline. */
async function noteOnLead(
  supabase: DB,
  leadId: string,
  title: string,
  body?: string,
): Promise<void> {
  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    kind: "automation",
    title,
    body: body ?? null,
    actor_id: null,
  });
}
