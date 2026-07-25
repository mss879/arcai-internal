"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult, WaMatchType, WaVoiceReplies } from "@/lib/types";
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
