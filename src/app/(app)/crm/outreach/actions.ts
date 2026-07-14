"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import {
  campaignStats,
  eligibleLeads,
  launchCampaign,
  setCampaignStatus,
  type CampaignFilters,
  type CampaignStats,
} from "@/lib/outreach-campaign";
import {
  drainOutreachRow,
  isEmailOutreachConfigured,
  processAutoSendQueue,
  processDueOutreach,
  sentToday,
} from "@/lib/lead-outreach";

export type EligibilityPreview = {
  count: number;
  findable: number;
  excluded: { alreadyQueued: number; noContact: number; suppressed: number };
  truncated: boolean;
  sample: string[];
};

/**
 * What a launch would actually do, for the confirm dialog. The owner sees the
 * real number and who's being left out BEFORE anything is queued — this is the
 * only chance to catch a mis-targeted blast.
 */
export async function previewCampaign(
  filters: CampaignFilters,
): Promise<ActionResult<{ preview: EligibilityPreview }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { leads, excluded, truncated } = await eligibleLeads(supabase, filters);
  return {
    ok: true,
    preview: {
      count: leads.length,
      findable: leads.filter((l) => l.findable).length,
      excluded,
      truncated,
      sample: leads.slice(0, 8).map((l) => l.company),
    },
  };
}

export async function startCampaign(opts: {
  name: string;
  autoSend: boolean;
  dailyCap: number;
  filters: CampaignFilters;
}): Promise<ActionResult<{ id: string; queued: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!isEmailOutreachConfigured()) {
    return {
      ok: false,
      error:
        "Outreach isn't configured — RESEND_API_KEY plus the research keys are required.",
    };
  }

  const res = await launchCampaign(supabase, {
    ...opts,
    actorId: user.id,
  });
  if (!res.ok || !res.id) {
    return { ok: false, error: res.error ?? "Could not start the campaign." };
  }

  // Get the first drafts moving without making the click wait on them.
  after(async () => {
    await processDueOutreach(supabase);
  });
  revalidatePath("/crm/outreach");
  return { ok: true, id: res.id, queued: res.queued ?? 0 };
}

export async function pauseCampaign(id: string): Promise<ActionResult> {
  return flip(id, "paused");
}

export async function resumeCampaign(id: string): Promise<ActionResult> {
  return flip(id, "running");
}

export async function cancelCampaign(id: string): Promise<ActionResult> {
  return flip(id, "cancelled");
}

async function flip(
  id: string,
  status: "running" | "paused" | "cancelled",
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const res = await setCampaignStatus(supabase, id, status);
  if (!res.ok) return { ok: false, error: res.error ?? "Could not update." };
  revalidatePath("/crm/outreach");
  return { ok: true };
}

/** Live counters for the progress card. */
export async function campaignProgress(
  id: string,
): Promise<ActionResult<{ stats: CampaignStats; sentToday: number }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  return {
    ok: true,
    stats: await campaignStats(supabase, id),
    sentToday: await sentToday(supabase),
  };
}

/**
 * Page-open driver. Local dev has no cron at all, and in prod this just makes
 * an open page feel live between minute-ticks. Mirrors the research/prospecting
 * "tick while open" pattern.
 *
 * `leadId` targets ONE row — the lead-detail card passes it so a manually
 * requested draft can't starve behind a few hundred campaign rows queued ahead
 * of it (the shared queue is ordered by updated_at, not by who's watching).
 * Without it, drives the global queue and the auto-send leg.
 */
export async function driveOutreach(leadId?: string): Promise<ActionResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Not authenticated." };

    if (leadId) {
      const { data } = await supabase
        .from("lead_outreach")
        .select("id")
        .eq("lead_id", leadId)
        .maybeSingle();
      if (data) await drainOutreachRow(supabase, data.id);
      return { ok: true };
    }

    await processDueOutreach(supabase);
    await processAutoSendQueue(supabase);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Tick failed.",
    };
  }
}
