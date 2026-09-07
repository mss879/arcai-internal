"use server";

import { revalidatePath } from "next/cache";

import { validateAgentSettings, type AgentSettingsInput } from "@/lib/ai-projects/chat-core";
import { selectableModels } from "@/lib/ai-projects/pricing-core";
import { invalidateProjectMemo } from "@/lib/ai-projects/projects";
import { colomboDay } from "@/lib/ai-projects/time-core";
import { loadPriceCatalog } from "@/lib/ai-projects/usage";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/** The Agent tab's actions (0126): who the agent is, how it looks, what it may do. */

export type AgentLimitsInput = {
  rateLimitPerMinute: number;
  dailyMessageCap: number;
};

export async function saveAgentSettings(
  id: string,
  input: AgentSettingsInput,
  limits: AgentLimitsInput,
): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { data: project } = await supabase.from("ai_projects").select("id, public_key").eq("id", id).maybeSingle();
  if (!project) return { ok: false, error: "That project no longer exists." };

  const catalog = await loadPriceCatalog(supabase);
  const allowed = selectableModels(catalog, colomboDay()).map((m) => m.model);
  const checked = validateAgentSettings(input, allowed);
  if (!checked.ok) return checked;
  const v = checked.value;

  const perMinute = Math.floor(Number(limits.rateLimitPerMinute));
  if (!Number.isFinite(perMinute) || perMinute < 1 || perMinute > 60) {
    return { ok: false, error: "Messages per minute per visitor must be between 1 and 60." };
  }
  const cap = Math.floor(Number(limits.dailyMessageCap));
  if (!Number.isFinite(cap) || cap < 10 || cap > 100_000) {
    return { ok: false, error: "The daily message cap must be between 10 and 100,000." };
  }

  const { error } = await supabase
    .from("ai_projects")
    .update({
      agent_name: v.agentName,
      system_prompt: v.systemPrompt,
      model: v.model,
      temperature: v.temperature,
      reasoning_effort: v.reasoningEffort as "minimal" | "low" | "medium" | "high" | "xhigh",
      welcome_message: v.welcomeMessage || null,
      suggested_questions: v.suggestedQuestions,
      primary_color: v.primaryColor,
      user_bubble_color: v.userBubbleColor || null,
      agent_bubble_color: v.agentBubbleColor || null,
      widget_position: v.widgetPosition as "left" | "right",
      show_branding: v.showBranding,
      booking_url: v.bookingUrl || null,
      notification_email: v.notificationEmail || null,
      lead_capture_enabled: v.leadCaptureEnabled,
      booking_enabled: v.bookingEnabled,
      handoff_enabled: v.handoffEnabled,
      rate_limit_per_minute: perMinute,
      daily_message_cap: cap,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  invalidateProjectMemo(project.public_key);
  revalidatePath(`/ai-projects/${id}`);
  revalidatePath("/ai-projects");
  return { ok: true };
}

/** The avatar is uploaded from the browser to the public `avatars` bucket;
 * this records the URL, and only a URL from that bucket. */
export async function setAvatarUrl(id: string, url: string | null): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { data: project } = await supabase.from("ai_projects").select("id, public_key").eq("id", id).maybeSingle();
  if (!project) return { ok: false, error: "That project no longer exists." };

  let clean: string | null = null;
  if (url) {
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
    if (!base || !url.startsWith(`${base}/storage/v1/object/public/avatars/`)) {
      return { ok: false, error: "The avatar must be uploaded through this page." };
    }
    clean = url;
  }
  const { error } = await supabase.from("ai_projects").update({ avatar_url: clean }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  invalidateProjectMemo(project.public_key);
  revalidatePath(`/ai-projects/${id}`);
  return { ok: true };
}
