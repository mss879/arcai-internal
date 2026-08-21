"use server";

import { revalidatePath } from "next/cache";

import { logDeliveryEvent, setProjectDeliveryStage, waContactForClient, withinWaWindow, renderDeliveryMessage, getDeliverySettings } from "@/lib/delivery";
import { appLink } from "@/lib/app-url";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, DeliveryStage } from "@/lib/types";
import { DELIVERY_STAGES } from "@/lib/constants";
import { sendAndLogWa } from "@/lib/wa-agent";
import { fireAssetSubmitted, seedProjectChecklist, startWaOnboarding } from "@/lib/wa-onboarding";

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

async function actorName(
  supabase: Awaited<ReturnType<typeof authed>>["supabase"],
  userId: string,
): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("full_name, username")
    .eq("id", userId)
    .maybeSingle();
  return data?.full_name || data?.username || "team";
}

export async function saveDeliveryStage(
  projectId: string,
  stage: DeliveryStage,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!(DELIVERY_STAGES as readonly string[]).includes(stage))
    return { ok: false, error: "Invalid stage." };

  const res = await setProjectDeliveryStage(supabase, projectId, stage, {
    actor: await actorName(supabase, user.id),
  });
  if (!res.ok) return { ok: false, error: res.detail };
  revalidatePath("/delivery");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function startOnboardingManual(
  projectId: string,
): Promise<ActionResult<{ detail?: string }>> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const res = await startWaOnboarding(supabase, projectId);
  if (!res.ok) return { ok: false, error: res.detail };
  revalidatePath("/delivery");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, detail: res.detail };
}

export async function seedChecklistAction(
  projectId: string,
): Promise<ActionResult<{ seeded?: number }>> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const seeded = await seedProjectChecklist(supabase, projectId);
  if (!seeded)
    return { ok: false, error: "The project already has a checklist (or seeding failed)." };
  revalidatePath("/delivery");
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, seeded };
}

export type DeliverySettingsInput = {
  chaser_enabled: boolean;
  chaser_interval_days: number;
  chaser_max_touches: number;
  chaser_message: string;
  chaser_template_name: string | null;
  chaser_template_lang: string;
  stalled_days: number;
  stalled_alerts_enabled: boolean;
  onboarding_template_name: string | null;
  onboarding_template_lang: string;
  welcome_message: string;
  milestone_notify_enabled: boolean;
  milestone_messages: Record<string, string>;
  google_review_url: string | null;
};

export async function saveDeliverySettings(
  input: DeliverySettingsInput,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const milestones: Record<string, string> = {};
  for (const [stage, text] of Object.entries(input.milestone_messages ?? {})) {
    if ((DELIVERY_STAGES as readonly string[]).includes(stage) && text.trim())
      milestones[stage] = text.trim();
  }

  const { error } = await supabase
    .from("delivery_settings")
    .update({
      chaser_enabled: !!input.chaser_enabled,
      chaser_interval_days: Math.min(30, Math.max(1, Number(input.chaser_interval_days) || 3)),
      chaser_max_touches: Math.min(10, Math.max(1, Number(input.chaser_max_touches) || 3)),
      chaser_message: input.chaser_message.trim() || undefined,
      chaser_template_name: input.chaser_template_name?.trim() || null,
      chaser_template_lang: input.chaser_template_lang.trim() || "en",
      stalled_days: Math.min(60, Math.max(1, Number(input.stalled_days) || 5)),
      stalled_alerts_enabled: !!input.stalled_alerts_enabled,
      onboarding_template_name: input.onboarding_template_name?.trim() || null,
      onboarding_template_lang: input.onboarding_template_lang.trim() || "en",
      welcome_message: input.welcome_message.trim() || undefined,
      milestone_notify_enabled: !!input.milestone_notify_enabled,
      milestone_messages: milestones,
      google_review_url: input.google_review_url?.trim() || null,
    })
    .eq("id", 1);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/delivery");
  return { ok: true };
}

/** Manual "chase now" — ignores the cadence timer (the human decided), but
 * still respects opt-outs and the 24h window. */
export async function chaseAssetNow(projectId: string): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_id, share_token")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const { data: pending } = await supabase
    .from("project_document_requests")
    .select("id, title, chase_count")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .eq("required", true);
  if (!pending?.length)
    return { ok: false, error: "Nothing is pending — every required item is in." };

  const contact = await waContactForClient(supabase, project.client_id);
  if (!contact)
    return {
      ok: false,
      error: "No WhatsApp thread for this client (or they opted out).",
    };
  if (!withinWaWindow(contact.last_inbound_at))
    return {
      ok: false,
      error:
        "Their 24h WhatsApp window is closed — message them from the inbox instead (or set a chaser template in Settings for the automatic nudges).",
    };

  const { data: client } = project.client_id
    ? await supabase.from("clients").select("name").eq("id", project.client_id).maybeSingle()
    : { data: null };
  const settings = await getDeliverySettings(supabase);
  const body = renderDeliveryMessage(settings.chaser_message, {
    name: (client?.name ?? "").trim().split(/\s+/)[0] || "there",
    project_name: project.name,
    missing_items: pending.map((i) => i.title).join(", "),
    portal_link: project.share_token
      ? appLink(`/public/project/${project.share_token}`)
      : null,
  });
  const sent = await sendAndLogWa(supabase, { contact, body, sentBy: "automation" });
  if (!sent.ok) return { ok: false, error: sent.error ?? "Send failed." };

  const now = new Date().toISOString();
  for (const item of pending) {
    await supabase
      .from("project_document_requests")
      .update({ chase_count: item.chase_count + 1, last_chased_at: now })
      .eq("id", item.id);
  }
  await logDeliveryEvent(
    supabase,
    projectId,
    "chase_sent",
    `Manual nudge for: ${pending.map((i) => i.title).join(", ")}`,
    await actorName(supabase, user.id),
  );
  revalidatePath("/delivery");
  return { ok: true };
}

export async function setAssetStatus(
  requestId: string,
  status: "pending" | "na",
  reason?: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: item, error } = await supabase
    .from("project_document_requests")
    .update({
      status,
      ...(status === "pending" ? { submitted_at: null } : {}),
    })
    .eq("id", requestId)
    .select("id, project_id, title")
    .single();
  if (error || !item) return { ok: false, error: error?.message ?? "Not found." };

  if (status === "na") {
    await logDeliveryEvent(
      supabase,
      item.project_id,
      "asset_na",
      `"${item.title}" marked n/a${reason ? ` — ${reason}` : ""}`,
      await actorName(supabase, user.id),
    );
    // Might have been the last blocker.
    const { checkAssetsComplete } = await import("@/lib/wa-onboarding");
    await checkAssetsComplete(supabase, item.project_id);
  }
  revalidatePath("/delivery");
  revalidatePath(`/projects/${item.project_id}`);
  return { ok: true };
}

export async function updateAssetMeta(
  requestId: string,
  input: { category?: string | null; required?: boolean },
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const validCategories = ["brand", "content", "photos", "access"] as const;
  const category = validCategories.includes(
    (input.category ?? "") as (typeof validCategories)[number],
  )
    ? (input.category as (typeof validCategories)[number])
    : null;
  const { error } = await supabase
    .from("project_document_requests")
    .update({
      ...(input.category !== undefined ? { category } : {}),
      ...(input.required !== undefined ? { required: input.required } : {}),
    })
    .eq("id", requestId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/delivery");
  return { ok: true };
}

/** File a WhatsApp-received photo/document under a checklist item by hand —
 * the inbox equivalent of the agent's file_asset tool. */
export async function fileWaMediaToAsset(
  requestId: string,
  waMessageId: string,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: media } = await supabase
    .from("wa_messages")
    .select("id, message_type, meta, created_at")
    .eq("id", waMessageId)
    .maybeSingle();
  if (!media) return { ok: false, error: "WhatsApp message not found." };
  const meta = (media.meta ?? {}) as Record<string, unknown>;
  const fileUrl = String(meta.image_url ?? meta.document_url ?? "");
  if (!fileUrl)
    return { ok: false, error: "That message has no stored file (too large or download failed)." };

  const { data: item, error } = await supabase
    .from("project_document_requests")
    .update({
      status: "submitted",
      file_url: fileUrl,
      file_name:
        String(meta.filename ?? "").trim() ||
        `${media.message_type}-${media.created_at.slice(0, 10)}`,
      file_size: typeof meta.size === "number" ? meta.size : null,
      file_type: String(meta.mime ?? "").trim() || null,
      wa_message_id: media.id,
      source: "whatsapp",
      submitted_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .select("id, project_id, title")
    .single();
  if (error || !item) return { ok: false, error: error?.message ?? "Item not found." };

  await logDeliveryEvent(
    supabase,
    item.project_id,
    "asset_filed",
    `"${item.title}" filed from WhatsApp by hand`,
    await actorName(supabase, user.id),
    { request_id: item.id, wa_message_id: media.id },
  );
  await fireAssetSubmitted(supabase, item, "whatsapp");
  revalidatePath("/delivery");
  revalidatePath(`/projects/${item.project_id}`);
  return { ok: true };
}

export async function toggleChaserPaused(
  projectId: string,
  paused: boolean,
): Promise<ActionResult> {
  const { supabase, user } = await authed();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase
    .from("projects")
    .update({ chaser_paused: paused })
    .eq("id", projectId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/delivery");
  return { ok: true };
}
