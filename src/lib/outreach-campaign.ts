import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Hard ceiling on one launch. Not a product limit — a blast-radius limit. If a
 * campaign would exceed it, the owner is told rather than silently truncated.
 */
export const MAX_CAMPAIGN_LEADS = 2000;

export type CampaignFilters = {
  /**
   * FALSE = only leads that already have an email on file (the safe default).
   * TRUE  = also queue leads with no email but a website, and let the research
   *         step dig one out. Those can end up `skipped` if nothing is found.
   */
  includeFindable: boolean;
  /** Restrict to one tag. Empty = any tag. */
  tag?: string;
};

export type EligibleLead = {
  id: string;
  company: string;
  emails: string[];
  website: string;
  /** No address on file — depends on the pipeline finding one. */
  findable: boolean;
};

export type Eligibility = {
  leads: EligibleLead[];
  /** Why leads were left out — shown in the launch dialog so it's never a black box. */
  excluded: {
    alreadyQueued: number;
    noContact: number;
    suppressed: number;
  };
  truncated: boolean;
};

/**
 * Who a bulk run would actually email.
 *
 * The targeting rule is "cold prospects only", chosen deliberately:
 *   - status = open      → never re-pitch a won or lost deal
 *   - client_id is null  → never cold-pitch "you need a website" to a company
 *                          that is already a paying client
 *   - no outreach row    → never email the same lead twice, and never stomp a
 *                          draft that's already waiting for manual approval
 *   - not suppressed     → unsubscribes and hard bounces are permanent
 */
export async function eligibleLeads(
  supabase: DB,
  filters: CampaignFilters,
): Promise<Eligibility> {
  const excluded = { alreadyQueued: 0, noContact: 0, suppressed: 0 };

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, company, title, contact_email, company_website, custom, tags")
    .is("deleted_at", null)
    .is("client_id", null)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(MAX_CAMPAIGN_LEADS + 1);
  if (error || !leads) {
    return { leads: [], excluded, truncated: false };
  }
  const truncated = leads.length > MAX_CAMPAIGN_LEADS;
  const pool = leads.slice(0, MAX_CAMPAIGN_LEADS);

  // Any lead that already has an outreach row is off-limits, whatever its
  // state: sent (don't double-email), ready (a human owns that draft),
  // in-flight (already working), skipped/failed (re-run it from the lead).
  const { data: existing } = await supabase
    .from("lead_outreach")
    .select("lead_id");
  const queued = new Set((existing ?? []).map((r) => r.lead_id));

  const tag = filters.tag?.trim();
  const candidates: EligibleLead[] = [];
  for (const lead of pool) {
    if (tag && !(lead.tags ?? []).includes(tag)) continue;
    if (queued.has(lead.id)) {
      excluded.alreadyQueued += 1;
      continue;
    }

    const emails = leadEmails(lead);
    const website = lead.company_website?.trim() ?? "";
    if (!emails.length && !(filters.includeFindable && website)) {
      excluded.noContact += 1;
      continue;
    }
    candidates.push({
      id: lead.id,
      company: lead.company?.trim() || lead.title?.trim() || "Untitled lead",
      emails,
      website,
      findable: !emails.length,
    });
  }

  // Drop leads whose every known address has opted out or hard-bounced.
  const all = [...new Set(candidates.flatMap((c) => c.emails))];
  const blocked = await suppressedSet(supabase, all);
  const kept: EligibleLead[] = [];
  for (const c of candidates) {
    if (!c.emails.length) {
      kept.push(c);
      continue;
    }
    const live = c.emails.filter((e) => !blocked.has(e.toLowerCase()));
    if (!live.length) {
      excluded.suppressed += 1;
      continue;
    }
    kept.push({ ...c, emails: live });
  }

  return { leads: kept, excluded, truncated };
}

/** contact_email + whatever Find Leads scraped into custom.prospect_emails. */
export function leadEmails(lead: {
  contact_email: string | null;
  custom: Record<string, unknown> | null;
}): string[] {
  const custom = (lead.custom ?? {}) as Record<string, unknown>;
  const scraped = Array.isArray(custom.prospect_emails)
    ? (custom.prospect_emails as unknown[]).map((e) => String(e))
    : [];
  const all = [...scraped, ...(lead.contact_email ? [lead.contact_email] : [])];
  const seen = new Set<string>();
  return all
    .map((e) => e.trim())
    .filter((e) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return false;
      const key = e.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Suppression lookup, chunked — `in()` on a few thousand values blows the URL. */
async function suppressedSet(supabase: DB, emails: string[]): Promise<Set<string>> {
  const blocked = new Set<string>();
  const lowered = emails.map((e) => e.toLowerCase());
  for (let i = 0; i < lowered.length; i += 200) {
    const chunk = lowered.slice(i, i + 200);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from("outreach_suppressions")
      .select("email")
      .in("email", chunk);
    (data ?? []).forEach((r) => blocked.add(r.email.toLowerCase()));
  }
  return blocked;
}

/**
 * Create a campaign and enqueue a draft row per eligible lead.
 *
 * The campaign row is created FIRST and left `running`; the pipeline can start
 * drafting the moment rows land. `auto_send` is stamped on every row so the
 * send leg never has to re-derive intent from a join — and so flipping a
 * campaign later can't retroactively arm drafts the owner never approved.
 */
export async function launchCampaign(
  supabase: DB,
  opts: {
    name: string;
    autoSend: boolean;
    dailyCap: number;
    filters: CampaignFilters;
    actorId?: string | null;
  },
): Promise<{ ok: boolean; id?: string; queued?: number; error?: string }> {
  const { leads } = await eligibleLeads(supabase, opts.filters);
  if (!leads.length) {
    return { ok: false, error: "No eligible leads match those filters." };
  }

  const { data: campaign, error: cErr } = await supabase
    .from("outreach_campaigns")
    .insert({
      name: opts.name.trim().slice(0, 120) || "Untitled campaign",
      status: "running",
      auto_send: opts.autoSend,
      daily_cap: Math.max(1, Math.min(500, Math.round(opts.dailyCap))),
      filters: { ...opts.filters, targeting: "cold_prospects" },
      queued: 0,
      ...(opts.actorId ? { created_by: opts.actorId } : {}),
    })
    .select("id")
    .single();
  if (cErr || !campaign) {
    return { ok: false, error: cErr?.message ?? "Could not create the campaign." };
  }

  // `ignoreDuplicates` + unique(lead_id) makes this idempotent: a lead that
  // got queued by another path between the count and here is skipped, not
  // hijacked into this campaign.
  let queued = 0;
  for (let i = 0; i < leads.length; i += 200) {
    const chunk = leads.slice(i, i + 200);
    const { data, error } = await supabase
      .from("lead_outreach")
      .upsert(
        chunk.map((l) => ({
          lead_id: l.id,
          status: "pending" as const,
          // Empty for findable-only leads: sendLeadOutreach falls back to
          // buildRecipients (which scrapes) at send time, so the launch click
          // never fans out hundreds of live scrapes.
          recipients: l.emails,
          source: "campaign" as const,
          auto_send: opts.autoSend,
          campaign_id: campaign.id,
          ...(opts.actorId ? { requested_by: opts.actorId } : {}),
        })),
        { onConflict: "lead_id", ignoreDuplicates: true },
      )
      .select("id");
    if (error) {
      console.error("[campaign] enqueue chunk failed:", error.message);
      continue;
    }
    queued += data?.length ?? 0;
  }

  await supabase
    .from("outreach_campaigns")
    .update({ queued })
    .eq("id", campaign.id);

  if (!queued) {
    await supabase
      .from("outreach_campaigns")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", campaign.id);
    return { ok: false, error: "Every matching lead was already queued." };
  }
  return { ok: true, id: campaign.id, queued };
}

/**
 * Turn the leads a Find Leads scan just imported into an outreach campaign.
 *
 * The import path ALREADY queues a draft per lead (prospecting.ts, gated on the
 * global outreach toggle) with `auto_send` false — i.e. heading for the
 * approval queue. So this ADOPTS those rows rather than inserting: the unique
 * (lead_id) would reject a duplicate anyway, and an upsert that overwrote them
 * would throw away drafts already researched and written. Existing rows keep
 * their status and body; they only gain the campaign link and the send mode.
 *
 * Leads already sent are never re-armed.
 */
export async function launchScanCampaign(
  supabase: DB,
  opts: {
    scanId: string;
    scanLabel: string;
    autoSend: boolean;
    dailyCap: number;
    actorId?: string | null;
  },
): Promise<{ ok: boolean; id?: string; queued?: number; error?: string }> {
  const { data: candidates } = await supabase
    .from("prospect_candidates")
    .select("lead_id")
    .eq("scan_id", opts.scanId)
    .not("lead_id", "is", null);
  const leadIds = [
    ...new Set((candidates ?? []).map((c) => c.lead_id).filter(Boolean)),
  ] as string[];
  if (!leadIds.length) {
    return { ok: false, error: "This scan didn't import any leads." };
  }

  const { data: existing } = await supabase
    .from("lead_outreach")
    .select("id, lead_id, status")
    .in("lead_id", leadIds);

  // Only adopt rows that will actually flow. Explicitly NOT adopted:
  //   sent/sending — mail already gone; can't be un-sent or re-armed.
  //   skipped      — no deliverable address; re-arming changes nothing and
  //                  would inflate `queued` with leads that can't be emailed.
  //   discarded    — someone deliberately binned that draft; don't resurrect it.
  //   failed       — processAutoSendQueue only picks up `ready`, so a failed row
  //                  would silently never send. Re-draft it from the lead instead.
  const ADOPTABLE = new Set(["pending", "researching", "drafting", "ready"]);
  const adoptable = (existing ?? []).filter((r) => ADOPTABLE.has(r.status));
  const haveRow = new Set((existing ?? []).map((r) => r.lead_id));
  // Leads with no row at all — e.g. the global outreach toggle was off when
  // the scan imported them.
  const missing = leadIds.filter((id) => !haveRow.has(id));

  if (!adoptable.length && !missing.length) {
    return {
      ok: false,
      error:
        "No lead from this scan can be emailed — they've each already been emailed, have no deliverable address, or their draft was discarded.",
    };
  }

  const { data: campaign, error: cErr } = await supabase
    .from("outreach_campaigns")
    .insert({
      name: opts.scanLabel.slice(0, 120) || "Find Leads campaign",
      status: "running",
      auto_send: opts.autoSend,
      daily_cap: Math.max(1, Math.min(500, Math.round(opts.dailyCap))),
      filters: { targeting: "scan", scan_id: opts.scanId },
      queued: 0,
      ...(opts.actorId ? { created_by: opts.actorId } : {}),
    })
    .select("id")
    .single();
  if (cErr || !campaign) {
    return { ok: false, error: cErr?.message ?? "Could not create the campaign." };
  }

  let queued = 0;

  // Adopt the drafts the import already queued.
  for (let i = 0; i < adoptable.length; i += 200) {
    const chunk = adoptable.slice(i, i + 200);
    const { data, error } = await supabase
      .from("lead_outreach")
      .update({
        auto_send: opts.autoSend,
        campaign_id: campaign.id,
        source: "campaign",
      })
      .in(
        "id",
        chunk.map((r) => r.id),
      )
      .select("id");
    if (error) {
      console.error("[campaign] adopt chunk failed:", error.message);
      continue;
    }
    queued += data?.length ?? 0;
  }

  // Queue anything that never got a draft row.
  if (missing.length) {
    const { data: leads } = await supabase
      .from("leads")
      .select("id, contact_email, custom")
      .in("id", missing);
    const rows = (leads ?? []).map((l) => ({
      lead_id: l.id,
      status: "pending" as const,
      recipients: leadEmails(l),
      source: "campaign" as const,
      auto_send: opts.autoSend,
      campaign_id: campaign.id,
      ...(opts.actorId ? { requested_by: opts.actorId } : {}),
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { data, error } = await supabase
        .from("lead_outreach")
        .upsert(rows.slice(i, i + 200), {
          onConflict: "lead_id",
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) {
        console.error("[campaign] scan enqueue failed:", error.message);
        continue;
      }
      queued += data?.length ?? 0;
    }
  }

  await supabase
    .from("outreach_campaigns")
    .update({ queued })
    .eq("id", campaign.id);

  if (!queued) {
    await supabase
      .from("outreach_campaigns")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", campaign.id);
    return { ok: false, error: "Nothing from this scan could be queued." };
  }
  return { ok: true, id: campaign.id, queued };
}

export type CampaignStats = {
  total: number;
  pending: number;
  researching: number;
  drafting: number;
  ready: number;
  sent: number;
  failed: number;
  skipped: number;
};

/** Live progress for a campaign's rows, by pipeline state. */
export async function campaignStats(
  supabase: DB,
  campaignId: string,
): Promise<CampaignStats> {
  const stats: CampaignStats = {
    total: 0,
    pending: 0,
    researching: 0,
    drafting: 0,
    ready: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };
  const { data } = await supabase
    .from("lead_outreach")
    .select("status")
    .eq("campaign_id", campaignId);
  for (const row of data ?? []) {
    stats.total += 1;
    switch (row.status) {
      case "pending":
        stats.pending += 1;
        break;
      case "researching":
        stats.researching += 1;
        break;
      case "drafting":
        stats.drafting += 1;
        break;
      case "ready":
        stats.ready += 1;
        break;
      case "sending":
      case "sent":
        stats.sent += 1;
        break;
      case "failed":
        stats.failed += 1;
        break;
      case "skipped":
      case "discarded":
        stats.skipped += 1;
        break;
    }
  }
  return stats;
}

/**
 * Stop a campaign. `paused` is reversible and halts both drafting and sending
 * within a tick; `cancelled` is terminal. Neither unsends anything — mail
 * already delivered is gone, which is exactly why the cap exists.
 */
export async function setCampaignStatus(
  supabase: DB,
  campaignId: string,
  status: "running" | "paused" | "cancelled",
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from("outreach_campaigns")
    .update({
      status,
      ...(status === "cancelled"
        ? { finished_at: new Date().toISOString() }
        : { finished_at: null }),
    })
    .eq("id", campaignId)
    .in("status", ["running", "paused"]);
  if (error) return { ok: false, error: error.message };

  // Cancelling drops the un-sent drafts so they can't be picked up later and
  // so those leads are eligible for a future, better-targeted run.
  if (status === "cancelled") {
    await supabase
      .from("lead_outreach")
      .update({ status: "discarded", locked_at: null })
      .eq("campaign_id", campaignId)
      .in("status", ["pending", "researching", "drafting", "ready"]);
  }
  return { ok: true };
}
