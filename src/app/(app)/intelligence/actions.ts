"use server";

import { revalidatePath } from "next/cache";

import { isOpenAIConfigured, openaiChat } from "@/lib/ai/openai";
import { generateWeeklyDigest, scanChurn, scoreLeads } from "@/lib/intelligence";
import { isSmsConfigured, sendSms } from "@/lib/sms";
import { countSmsSegments, normalizePhone } from "@/lib/sms-utils";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import type { AdPlatform, CompetitorEntryKind } from "@/lib/database.types";

// --- Digest -----------------------------------------------------

export async function runDigest(): Promise<ActionResult<{ content: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  try {
    const { content } = await generateWeeklyDigest(supabase);
    revalidatePath("/intelligence");
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Digest failed." };
  }
}

// --- Churn ------------------------------------------------------

export async function runChurnScan(): Promise<ActionResult<{ created: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  try {
    const created = await scanChurn(supabase);
    revalidatePath("/intelligence");
    return { ok: true, created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Scan failed." };
  }
}

export async function setChurnAlertStatus(
  id: string,
  status: "open" | "actioned" | "dismissed",
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("churn_alerts").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/intelligence");
  return { ok: true };
}

/** Send the (edited) win-back message via SMS and mark the alert actioned. */
export async function sendWinback(
  alertId: string,
  message: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!isSmsConfigured()) return { ok: false, error: "Notify.lk isn't configured." };

  const { data: alert } = await supabase
    .from("churn_alerts")
    .select("*, client:clients(id, name, phone)")
    .eq("id", alertId)
    .single();
  if (!alert) return { ok: false, error: "Alert not found." };
  const client = (alert as unknown as { client: { id: string; name: string; phone: string | null } | null })
    .client;
  const phone = normalizePhone(client?.phone ?? "");
  if (!phone.ok) return { ok: false, error: "The client has no valid phone number." };

  const text = message.trim();
  if (!text) return { ok: false, error: "Message is empty." };

  const sent = await sendSms({ to: phone.value, message: text, contactName: client?.name });
  await supabase.from("sms_messages").insert({
    to_number: phone.value,
    message: text,
    client_id: client?.id ?? null,
    client_name: client?.name ?? alert.client_name,
    kind: "custom",
    status: sent.ok ? "sent" : "failed",
    error: sent.ok ? null : sent.error,
    segments: countSmsSegments(text),
  });
  if (!sent.ok) return { ok: false, error: sent.error };

  await supabase.from("churn_alerts").update({ status: "actioned" }).eq("id", alertId);
  revalidatePath("/intelligence");
  return { ok: true };
}

// --- Lead scoring -------------------------------------------------

export async function runLeadScoring(
  rescoreAll: boolean,
): Promise<ActionResult<{ scored: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  try {
    const scored = await scoreLeads(supabase, { rescoreAll });
    revalidatePath("/intelligence");
    revalidatePath("/crm");
    return { ok: true, scored };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Scoring failed." };
  }
}

// --- Ads ------------------------------------------------------------

export type AdInput = {
  id?: string;
  platform: AdPlatform;
  campaign: string;
  period_start: string;
  period_end: string;
  spend: number;
  impressions?: number | null;
  clicks?: number | null;
  leads?: number | null;
  revenue?: number | null;
  notes?: string | null;
};

export async function saveAdEntry(input: AdInput): Promise<ActionResult> {
  const supabase = await createClient();
  if (!input.campaign.trim()) return { ok: false, error: "Name the campaign." };
  if (!input.period_start || !input.period_end)
    return { ok: false, error: "Set the period." };

  const base = {
    platform: input.platform,
    campaign: input.campaign.trim(),
    period_start: input.period_start,
    period_end: input.period_end,
    spend: input.spend || 0,
    impressions: input.impressions ?? null,
    clicks: input.clicks ?? null,
    leads: input.leads ?? null,
    revenue: input.revenue ?? null,
    notes: input.notes?.trim() || null,
  };
  const { error } = input.id
    ? await supabase.from("ad_entries").update(base).eq("id", input.id)
    : await supabase.from("ad_entries").insert(base);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/intelligence");
  return { ok: true };
}

export async function deleteAdEntry(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("ad_entries").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/intelligence");
  return { ok: true };
}

// --- Competitors -----------------------------------------------------

export async function saveCompetitor(input: {
  id?: string;
  name: string;
  website?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  notes?: string | null;
}): Promise<ActionResult> {
  const supabase = await createClient();
  if (!input.name.trim()) return { ok: false, error: "Name the competitor." };
  const base = {
    name: input.name.trim(),
    website: input.website?.trim() || null,
    facebook: input.facebook?.trim() || null,
    instagram: input.instagram?.trim() || null,
    notes: input.notes?.trim() || null,
  };
  const { error } = input.id
    ? await supabase.from("competitors").update(base).eq("id", input.id)
    : await supabase.from("competitors").insert(base);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/intelligence");
  return { ok: true };
}

export async function deleteCompetitor(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("competitors").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/intelligence");
  return { ok: true };
}

export async function addCompetitorEntry(input: {
  competitor_id: string;
  kind: CompetitorEntryKind;
  content: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  if (!input.content.trim()) return { ok: false, error: "Write the observation." };
  const { error } = await supabase.from("competitor_entries").insert({
    competitor_id: input.competitor_id,
    kind: input.kind,
    content: input.content.trim(),
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/intelligence");
  return { ok: true };
}

export async function deleteCompetitorEntry(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("competitor_entries").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/intelligence");
  return { ok: true };
}

export async function summarizeCompetitor(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!isOpenAIConfigured())
    return { ok: false, error: "Add OPENAI_API_KEY to enable AI summaries." };

  const [{ data: competitor }, { data: entries }] = await Promise.all([
    supabase.from("competitors").select("*").eq("id", id).single(),
    supabase
      .from("competitor_entries")
      .select("*")
      .eq("competitor_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (!competitor) return { ok: false, error: "Competitor not found." };
  if (!entries?.length)
    return { ok: false, error: "Log a few observations first (prices, posts, ads)." };

  try {
    const reply = await openaiChat([
      {
        role: "system",
        content:
          "You analyze competitors for ARC AI, a Sri Lankan digital agency. From the logged observations, write a short plain-text brief: what they're pushing, pricing moves, and 2 concrete counter-moves for ARC AI. Max 120 words.",
      },
      {
        role: "user",
        content: `Competitor: ${competitor.name}\nObservations:\n${entries
          .map((e) => `${e.created_at.slice(0, 10)} [${e.kind}] ${e.content}`)
          .join("\n")}`,
      },
    ]);
    const text = reply.content?.trim();
    if (!text) return { ok: false, error: "AI returned nothing." };
    await supabase
      .from("competitors")
      .update({ ai_summary: text, ai_summary_at: new Date().toISOString() })
      .eq("id", id);
    revalidatePath("/intelligence");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Summary failed." };
  }
}

// --- Google Business Profile helper -----------------------------------

export async function draftReviewReply(input: {
  review: string;
  rating: number;
  reviewer?: string;
}): Promise<ActionResult<{ reply: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!input.review.trim()) return { ok: false, error: "Paste the review first." };

  if (!isOpenAIConfigured()) {
    const name = input.reviewer?.trim();
    const reply =
      input.rating >= 4
        ? `Thank you so much${name ? `, ${name}` : ""}! It was a pleasure working with you — reviews like this keep our team going. See you on the next project! — Team ARC AI`
        : `Thank you for the honest feedback${name ? `, ${name}` : ""}. This isn't the experience we aim for — please reach us at support@arcai.agency or +94 77 185 2522 so we can make it right. — Team ARC AI`;
    return { ok: true, reply };
  }

  try {
    const ai = await openaiChat([
      {
        role: "system",
        content:
          "Draft a Google review reply for ARC AI, a Sri Lankan digital agency. Warm, professional, max 80 words, plain text, sign off as 'Team ARC AI'. For negative reviews: apologize once, offer to fix it via support@arcai.agency, never argue.",
      },
      {
        role: "user",
        content: `Rating: ${input.rating}/5${input.reviewer ? `\nReviewer: ${input.reviewer}` : ""}\nReview: ${input.review}`,
      },
    ]);
    const reply = ai.content?.trim();
    if (!reply) return { ok: false, error: "AI returned nothing." };
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Draft failed." };
  }
}
