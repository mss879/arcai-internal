"use server";

import { revalidatePath } from "next/cache";

import { STORAGE_BUCKETS } from "@/lib/constants";
import { createClient } from "@/lib/supabase/server";
import type {
  ActionResult,
  WaCampaignStatus,
  WaMatchType,
  WaVoiceReplies,
} from "@/lib/types";
import {
  cancelPendingWaPromises,
  linkWaContactToCrm,
  sendAndLogWa,
} from "@/lib/wa-agent";
import { WA_TOOL_CATALOG } from "@/lib/wa-tools-catalog";
import { isWhatsAppConfigured } from "@/lib/whatsapp";

/**
 * Server actions for the /whatsapp page. All run through the signed-in
 * member's own Supabase client, so RLS applies exactly as in the UI.
 */

export async function sendWaMessageAction(
  contactId: string,
  body: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!isWhatsAppConfigured()) {
    return {
      ok: false,
      error: "WhatsApp isn't configured — add the WHATSAPP_* keys to .env.local.",
    };
  }

  const { data: contact } = await supabase
    .from("wa_contacts")
    .select("id, wa_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return { ok: false, error: "Contact not found." };

  const sent = await sendAndLogWa(supabase, {
    contact,
    body,
    sentBy: "team",
    authorId: user.id,
  });
  if (!sent.ok) return { ok: false, error: sent.error ?? "Send failed." };

  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function markContactReadAction(contactId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("wa_contacts")
    .update({ unread: 0, needs_attention: false })
    .eq("id", contactId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function toggleContactAgentAction(
  contactId: string,
  enabled: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("wa_contacts")
    .update({ agent_enabled: enabled })
    .eq("id", contactId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

/** Lift (or set) the do-not-contact flag from the inbox thread header. */
export async function setContactOptOutAction(
  contactId: string,
  optedOut: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("wa_contacts")
    .update({
      do_not_contact: optedOut,
      ...(optedOut ? { followup_stage: 0, next_followup_at: null } : {}),
    })
    .eq("id", contactId);
  if (error) return { ok: false, error: error.message };
  if (optedOut) {
    await cancelPendingWaPromises(supabase, contactId, "contact opted out");
  }
  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function linkContactToCrmAction(
  contactId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const linked = await linkWaContactToCrm(supabase, contactId);
  if (!linked.ok) return { ok: false, error: linked.error ?? "Could not link." };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export type WaConfigInput = {
  enabled: boolean;
  agent_name: string;
  greeting: string;
  persona: string;
  knowledge: string;
  ask_name: boolean;
  auto_create_lead: boolean;
  pipeline_id: string | null;
  stage_id: string | null;
  lead_source: string;
  allowed_tools: string[];
  voice_replies?: WaVoiceReplies;
  followups_enabled?: boolean;
  followup_template_name?: string;
  followup_template_lang?: string;
  max_autonomous_discount_pct?: number;
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  timezone?: string;
  language_matching?: boolean;
};

/** Cold-outreach settings — saved from their own tab, separate from the
 * agent config form so each tab only writes what it owns. */
export type ColdConfigInput = {
  cold_outreach_enabled: boolean;
  cold_daily_cap: number;
  cold_template_name: string;
  cold_template_lang: string;
  cold_template_params: string[];
  cold_pipeline_id: string | null;
  cold_stage_id: string | null;
  cold_followup_template_name: string;
  cold_followup_template_lang: string;
  cold_followup_template_params: string[];
  cold_followup_days: number;
};

export async function saveColdConfigAction(
  input: ColdConfigInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const cleanParams = (params: string[]) =>
    params.map((p) => p.trim()).filter(Boolean).slice(0, 10);

  const { error } = await supabase.from("wa_agent_config").upsert(
    {
      id: 1,
      cold_outreach_enabled: Boolean(input.cold_outreach_enabled),
      cold_daily_cap: Math.min(
        20,
        Math.max(1, Math.round(Number(input.cold_daily_cap) || 5)),
      ),
      cold_template_name: input.cold_template_name.trim() || null,
      cold_template_lang: input.cold_template_lang.trim() || "en",
      cold_template_params: cleanParams(input.cold_template_params),
      cold_pipeline_id: input.cold_pipeline_id || null,
      cold_stage_id: input.cold_stage_id || null,
      cold_followup_template_name:
        input.cold_followup_template_name.trim() || null,
      cold_followup_template_lang:
        input.cold_followup_template_lang.trim() || "en",
      cold_followup_template_params: cleanParams(
        input.cold_followup_template_params,
      ),
      cold_followup_days: Math.min(
        14,
        Math.max(1, Math.round(Number(input.cold_followup_days) || 3)),
      ),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function saveWaConfigAction(
  input: WaConfigInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const validKeys = new Set(WA_TOOL_CATALOG.map((t) => t.key));
  const allowed = (input.allowed_tools ?? []).filter((k) => validKeys.has(k));

  const { error } = await supabase
    .from("wa_agent_config")
    .upsert(
      {
        id: 1,
        enabled: Boolean(input.enabled),
        agent_name: input.agent_name.trim() || "Arc",
        greeting: input.greeting.trim(),
        persona: input.persona.trim(),
        knowledge: input.knowledge.trim(),
        ask_name: Boolean(input.ask_name),
        auto_create_lead: Boolean(input.auto_create_lead),
        pipeline_id: input.pipeline_id || null,
        stage_id: input.stage_id || null,
        lead_source: input.lead_source.trim() || "whatsapp",
        allowed_tools: allowed,
        ...(input.voice_replies === "off" || input.voice_replies === "match"
          ? { voice_replies: input.voice_replies }
          : {}),
        ...(input.followups_enabled != null
          ? { followups_enabled: Boolean(input.followups_enabled) }
          : {}),
        ...(input.followup_template_name != null
          ? { followup_template_name: input.followup_template_name.trim() || null }
          : {}),
        ...(input.followup_template_lang != null
          ? { followup_template_lang: input.followup_template_lang.trim() || "en" }
          : {}),
        ...(input.max_autonomous_discount_pct != null
          ? {
              max_autonomous_discount_pct: Math.min(
                50,
                Math.max(0, Math.round(Number(input.max_autonomous_discount_pct) || 0)),
              ),
            }
          : {}),
        ...(input.quiet_hours_enabled != null
          ? { quiet_hours_enabled: Boolean(input.quiet_hours_enabled) }
          : {}),
        ...(input.quiet_hours_start != null
          ? {
              quiet_hours_start: Math.min(
                23,
                Math.max(0, Math.round(Number(input.quiet_hours_start) || 0)),
              ),
            }
          : {}),
        ...(input.quiet_hours_end != null
          ? {
              quiet_hours_end: Math.min(
                23,
                Math.max(0, Math.round(Number(input.quiet_hours_end) || 0)),
              ),
            }
          : {}),
        ...(input.timezone != null
          ? { timezone: input.timezone.trim() || "Asia/Colombo" }
          : {}),
        ...(input.language_matching != null
          ? { language_matching: Boolean(input.language_matching) }
          : {}),
      },
      { onConflict: "id" },
    );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export type WaRuleInput = {
  id?: string;
  keyword: string;
  match_type: WaMatchType;
  reply: string;
  add_tag: string;
  notify_team: boolean;
  handoff: boolean;
  automation_id: string | null;
  is_active: boolean;
};

export async function saveKeywordRuleAction(
  input: WaRuleInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const keyword = input.keyword.trim();
  if (!keyword) return { ok: false, error: "Keyword is required." };

  const row = {
    keyword,
    match_type: input.match_type,
    reply: input.reply.trim() || null,
    add_tag: input.add_tag.trim() || null,
    notify_team: Boolean(input.notify_team),
    handoff: Boolean(input.handoff),
    automation_id: input.automation_id || null,
    is_active: Boolean(input.is_active),
  };

  const { error } = input.id
    ? await supabase.from("wa_keyword_rules").update(row).eq("id", input.id)
    : await supabase.from("wa_keyword_rules").insert(row);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function deleteKeywordRuleAction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("wa_keyword_rules").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function toggleCoachingAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("wa_coaching")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Campaign mode — the Meta ad the agent is currently selling
// ---------------------------------------------------------------------------

/** Master on/off, saved from the Campaign tab's own toggle. */
export async function saveCampaignModeAction(
  enabled: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("wa_agent_config")
    .upsert({ id: 1, campaign_mode_enabled: Boolean(enabled) }, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export type CampaignInput = {
  name: string;
  details: string;
  first_reply: string;
  image_url: string | null;
  image_path: string | null;
};

export async function createCampaignAction(
  input: CampaignInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the campaign a name." };

  const details = input.details.trim();
  const { error } = await supabase.from("wa_campaigns").insert({
    name,
    details,
    // Left blank? Draft it, so the instant line works out of the box.
    first_reply: input.first_reply.trim() || (await draftFirstReply(details)),
    image_url: input.image_url || null,
    image_path: input.image_path || null,
    image_summary: input.image_url ? await readAdImage(input.image_url) : null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function updateCampaignAction(
  id: string,
  input: CampaignInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the campaign a name." };

  const { data: existing } = await supabase
    .from("wa_campaigns")
    .select("image_url, image_path, image_summary")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Campaign not found." };

  // Only pay for the vision read when the creative actually changed.
  const swapped = (input.image_url || null) !== existing.image_url;
  const summary = !input.image_url
    ? null
    : swapped
      ? await readAdImage(input.image_url)
      : existing.image_summary;

  const details = input.details.trim();
  const { error } = await supabase
    .from("wa_campaigns")
    .update({
      name,
      details,
      first_reply: input.first_reply.trim() || (await draftFirstReply(details)),
      image_url: input.image_url || null,
      image_path: input.image_path || null,
      image_summary: summary,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // The old creative is now orphaned.
  if (swapped && existing.image_path) {
    await supabase.storage
      .from(STORAGE_BUCKETS.waCampaigns)
      .remove([existing.image_path]);
  }
  revalidatePath("/whatsapp");
  return { ok: true };
}

/** Activate / pause / end a campaign. Exactly one row may be "active"
 * (partial unique index in 0065), so promoting one retires the incumbent
 * first — otherwise the insert trips the index. */
export async function setCampaignStatusAction(
  id: string,
  status: WaCampaignStatus,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (status === "active") {
    const { error: demote } = await supabase
      .from("wa_campaigns")
      .update({ status: "paused" })
      .eq("status", "active")
      .neq("id", id);
    if (demote) return { ok: false, error: demote.message };
  }

  const { error } = await supabase
    .from("wa_campaigns")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/whatsapp");
  return { ok: true };
}

export async function deleteCampaignAction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: existing } = await supabase
    .from("wa_campaigns")
    .select("image_path")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase.from("wa_campaigns").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (existing?.image_path) {
    await supabase.storage
      .from(STORAGE_BUCKETS.waCampaigns)
      .remove([existing.image_path]);
  }
  revalidatePath("/whatsapp");
  return { ok: true };
}

/**
 * Draft the instant opening line from the campaign brief.
 *
 * This goes out ~300ms after a new lead writes, straight from the webhook,
 * before the agent has thought about anything — so it has to be pre-written
 * rather than generated per message. Short, human, and it must not promise
 * anything the agent might contradict a minute later.
 *
 * Null on failure: the campaign simply has no instant line and the lead waits
 * for the real reply, exactly as before.
 */
async function draftFirstReply(details: string): Promise<string | null> {
  if (!details.trim()) return null;
  try {
    const { isOpenAIConfigured, openaiChatJSON } = await import("@/lib/ai/openai");
    if (!isOpenAIConfigured()) return null;

    const raw = await openaiChatJSON(
      [
        {
          role: "user",
          content: `A Sri Lankan digital agency is running this WhatsApp ad campaign:

${details.slice(0, 2000)}

Someone just tapped the ad and messaged. Write the ONE short line that fires back instantly, before a salesperson has read anything they said.

Rules:
- 1-2 sentences, max ~140 characters. Warm, human WhatsApp voice, contractions, at most one emoji.
- Acknowledge the campaign so they know they reached the right place.
- Signal a real reply is seconds away.
- Do NOT ask a question, quote a price, or promise anything specific — a salesperson answers properly right after and must not be contradicted.
- No markdown, no links.

Reply ONLY with JSON: {"line":"..."}`,
        },
      ],
      { timeoutMs: 20_000, temperature: 0.7 },
    );
    const line = String((JSON.parse(raw) as { line?: string }).line ?? "").trim();
    return line ? line.slice(0, 300) : null;
  } catch (e) {
    console.error("[whatsapp] first-reply draft failed:", e);
    return null;
  }
}

/**
 * Read the ad creative once, at upload time, into plain text.
 *
 * The agent loop is text-only, so this is the only way it can "see" the
 * image the customer just tapped — and doing it here means we pay for one
 * vision call per campaign instead of one per message. Null on any failure:
 * the campaign still works fine from the team's details box alone.
 */
async function readAdImage(imageUrl: string): Promise<string | null> {
  try {
    const { isOpenAIConfigured, openaiVisionJSON } = await import("@/lib/ai/openai");
    if (!isOpenAIConfigured()) return null;

    const raw = await openaiVisionJSON(
      imageUrl,
      `This is a Meta (Facebook/Instagram) ad creative for a Sri Lankan digital agency. Reply ONLY with JSON:
{"headline":"the main headline text, verbatim","offer":"any price, discount or offer visible — verbatim, or null","cta":"the call to action, or null","visual":"one short sentence describing what the image shows"}`,
      { timeoutMs: 20_000 },
    );
    const parsed = JSON.parse(raw) as {
      headline?: string | null;
      offer?: string | null;
      cta?: string | null;
      visual?: string | null;
    };
    const summary = [
      parsed.headline && `Headline: "${parsed.headline}"`,
      parsed.offer && `Offer shown on the ad: ${parsed.offer}`,
      parsed.cta && `Call to action: ${parsed.cta}`,
      parsed.visual && `Visual: ${parsed.visual}`,
    ]
      .filter(Boolean)
      .join("\n");
    return summary.slice(0, 600) || null;
  } catch (e) {
    console.error("[whatsapp] campaign image read failed:", e);
    return null;
  }
}
