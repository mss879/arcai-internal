"use server";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/**
 * Everything the WhatsApp Analytics tab shows, fetched lazily when the tab
 * opens (page.tsx already carries the inbox payload — analytics must never
 * tax it). Aggregation happens in the DATABASE via the 0074 SQL functions;
 * the few JS tallies here run over slim, capped selects.
 *
 * The headline is AGENT WINS = booked calls. The agent's whole job is give
 * the info → set up the call; everything after the call is the team's half
 * of the funnel (quotes, signatures, revenue).
 */

export type WaFunnel = {
  contacts: number;
  replied: number;
  inCrm: number;
  agentWins: number;
  agentWinRate: number;
  quoted: number;
  quoteViewed: number;
  signed: number;
  declined: number;
  won: number;
  revenue: number;
  medianFirstReply: number | null;
  p90FirstReply: number | null;
};

export type WaCampaignFunnel = WaFunnel & {
  id: string;
  name: string;
  status: string;
};

export type WaDailyVolume = { day: string; inbound: number; outbound: number };
export type WaToolStat = { tool: string; total: number; ok: number };
export type WaBookedCall = {
  contactId: string;
  name: string;
  phone: string;
  at: string;
};

export type WaInsightAggregates = {
  scored: number;
  outcomes: Record<string, number>;
  topObjections: [string, number][];
  topFaqGaps: [string, number][];
  topQualityFlags: [string, number][];
  /** Where non-winning conversations stalled (stage_reached counts). */
  dropOff: [string, number][];
};

export type WaVariantSplit = {
  contacts: number;
  replied: number;
  wins: number;
};

export type WaAnalytics = {
  range: number;
  funnel: WaFunnel;
  campaigns: WaCampaignFunnel[];
  daily: WaDailyVolume[];
  tools: WaToolStat[];
  upcomingCalls: WaBookedCall[];
  needsAttention: number;
  aiPaused: number;
  ghosted: number;
  languages: [string, number][];
  followupsSent: number;
  followupsRevived: number;
  /** Promise touches delivered in range and how many drew a reply within 48h. */
  promisesSent: number;
  promisesRevived: number;
  /** Revival module counts — null while the module has never run / migration 0076 missing. */
  revival: { sent: number; replied: number } | null;
  /** Active campaign's first-reply A/B — null unless a variant B is live. */
  abTest: { campaignName: string; a: WaVariantSplit; b: WaVariantSplit } | null;
  insights: WaInsightAggregates;
};

const GHOST_AFTER_MS = 48 * 3600_000;

function toFunnel(raw: Record<string, unknown> | null): WaFunnel {
  const n = (k: string) => Number((raw as Record<string, unknown>)?.[k] ?? 0);
  const maybe = (k: string) => {
    const v = (raw as Record<string, unknown>)?.[k];
    return v == null ? null : Number(v);
  };
  return {
    contacts: n("contacts"),
    replied: n("replied"),
    inCrm: n("in_crm"),
    agentWins: n("agent_wins"),
    agentWinRate: n("agent_win_rate"),
    quoted: n("quoted"),
    quoteViewed: n("quote_viewed"),
    signed: n("signed"),
    declined: n("declined"),
    won: n("won"),
    revenue: n("revenue"),
    medianFirstReply: maybe("median_first_reply"),
    p90FirstReply: maybe("p90_first_reply"),
  };
}

function tally(values: (string | null)[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v?.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

export async function waAnalytics(
  range: 7 | 30 | 90,
): Promise<ActionResult<{ analytics: WaAnalytics }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const now = Date.now();
  const since = new Date(now - range * 86400_000).toISOString();

  const [funnelRes, dailyRes, toolsRes] = await Promise.all([
    supabase.rpc("wa_funnel_stats", { p_since: since }),
    supabase.rpc("wa_daily_message_counts", { p_since: since }),
    supabase.rpc("wa_tool_stats", { p_since: since }),
  ]);
  if (funnelRes.error) {
    return {
      ok: false,
      error: `Analytics queries missing — run migration 0074_wa_analytics.sql (${funnelRes.error.message})`,
    };
  }

  // Campaign comparison over each campaign's LIFETIME (a 7-day range would
  // unfairly zero out last month's campaign), ranked by agent win rate.
  const { data: campaignRows } = await supabase
    .from("wa_campaigns")
    .select("id, name, status, created_at")
    .order("created_at", { ascending: false })
    .limit(12);
  const campaigns: WaCampaignFunnel[] = [];
  for (const c of campaignRows ?? []) {
    const { data } = await supabase.rpc("wa_funnel_stats", {
      p_since: c.created_at,
      p_campaign: c.id,
    });
    campaigns.push({
      id: c.id,
      name: c.name,
      status: c.status,
      ...toFunnel((data ?? null) as Record<string, unknown> | null),
    });
  }
  campaigns.sort((a, b) => b.agentWinRate - a.agentWinRate);

  const [
    upcomingRes,
    needsRes,
    pausedRes,
    ghostedRes,
    langRes,
    followupLogsRes,
    inboundRes,
    insightsRes,
  ] = await Promise.all([
    supabase
      .from("wa_contacts")
      .select("id, display_name, profile_name, wa_id, call_booked_at")
      .gt("call_booked_at", new Date(now).toISOString())
      .order("call_booked_at", { ascending: true })
      .limit(20),
    supabase
      .from("wa_contacts")
      .select("id", { count: "exact", head: true })
      .eq("needs_attention", true),
    supabase
      .from("wa_contacts")
      .select("id", { count: "exact", head: true })
      .eq("agent_enabled", false),
    supabase
      .from("wa_contacts")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .eq("last_direction", "out")
      .not("last_inbound_at", "is", null)
      .lte("last_message_at", new Date(now - GHOST_AFTER_MS).toISOString()),
    supabase
      .from("wa_contacts")
      .select("language")
      .gte("created_at", since)
      .limit(2000),
    supabase
      .from("wa_agent_logs")
      .select("contact_id, created_at")
      .eq("tool", "followup")
      .eq("ok", true)
      .like("result", "Touch%/%sent")
      .gte("created_at", since)
      .limit(400),
    supabase
      .from("wa_messages")
      .select("contact_id, created_at")
      .eq("direction", "in")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(4000),
    supabase
      .from("wa_convo_insights")
      .select("outcome, stage_reached, objections, faq_gaps, quality_flags")
      .eq("status", "scored")
      .gte("created_at", since)
      .limit(500),
  ]);

  // Follow-up effectiveness: a touch "revived" the chat if an inbound
  // message landed within 48h of it.
  const inboundByContact = new Map<string, number[]>();
  for (const m of inboundRes.data ?? []) {
    const list = inboundByContact.get(m.contact_id) ?? [];
    list.push(new Date(m.created_at).getTime());
    inboundByContact.set(m.contact_id, list);
  }
  const revivedWithin48h = (contactId: string | null, fromIso: string) => {
    if (!contactId) return false;
    const t = new Date(fromIso).getTime();
    const times = inboundByContact.get(contactId) ?? [];
    return times.some((x) => x > t && x - t <= GHOST_AFTER_MS);
  };
  let revived = 0;
  for (const log of followupLogsRes.data ?? []) {
    if (revivedWithin48h(log.contact_id, log.created_at)) revived++;
  }

  // Promise touches: the customer named the moment — did coming back at it work?
  const { data: promiseRows } = await supabase
    .from("wa_promises")
    .select("contact_id, updated_at")
    .eq("status", "sent")
    .gte("updated_at", since)
    .limit(300);
  let promisesRevived = 0;
  for (const p of promiseRows ?? []) {
    if (revivedWithin48h(p.contact_id, p.updated_at)) promisesRevived++;
  }

  // Revival module — tolerate a missing table (migration 0076 not applied).
  let revival: { sent: number; replied: number } | null = null;
  {
    const { data: revivalRows, error: revivalError } = await supabase
      .from("wa_revival")
      .select("status")
      .gte("created_at", since)
      .limit(500);
    if (!revivalError && revivalRows) {
      const sent = revivalRows.filter((r) =>
        ["sent", "replied"].includes(r.status),
      ).length;
      revival = sent
        ? { sent, replied: revivalRows.filter((r) => r.status === "replied").length }
        : null;
    }
  }

  // First-reply A/B — only when the ACTIVE campaign carries a variant B.
  let abTest: WaAnalytics["abTest"] = null;
  const active = (campaignRows ?? []).find((c) => c.status === "active");
  if (active) {
    const { data: activeFull } = await supabase
      .from("wa_campaigns")
      .select("*")
      .eq("id", active.id)
      .maybeSingle();
    if (activeFull?.first_reply_b?.trim()) {
      const split = async (variant: "a" | "b"): Promise<WaVariantSplit> => {
        const base = () =>
          supabase
            .from("wa_contacts")
            .select("id", { count: "exact", head: true })
            .eq("campaign_id", active.id)
            .eq("first_reply_variant", variant);
        const [c, r, w] = await Promise.all([
          base(),
          base().not("last_inbound_at", "is", null),
          base().not("call_booked_at", "is", null),
        ]);
        return { contacts: c.count ?? 0, replied: r.count ?? 0, wins: w.count ?? 0 };
      };
      const [a, b] = await Promise.all([split("a"), split("b")]);
      if (a.contacts + b.contacts > 0)
        abTest = { campaignName: active.name, a, b };
    }
  }

  const insights = insightsRes.data ?? [];
  const outcomes: Record<string, number> = {};
  for (const i of insights) {
    if (i.outcome) outcomes[i.outcome] = (outcomes[i.outcome] ?? 0) + 1;
  }
  const losers = insights.filter(
    (i) => i.outcome !== "call_booked" && i.outcome !== "won",
  );

  const analytics: WaAnalytics = {
    range,
    funnel: toFunnel((funnelRes.data ?? null) as Record<string, unknown> | null),
    campaigns,
    daily: (dailyRes.data ?? []).map((d) => ({
      day: String(d.day),
      inbound: Number(d.inbound),
      outbound: Number(d.outbound),
    })),
    tools: (toolsRes.data ?? []).map((t) => ({
      tool: t.tool,
      total: Number(t.total),
      ok: Number(t.ok_count),
    })),
    upcomingCalls: (upcomingRes.data ?? []).map((c) => ({
      contactId: c.id,
      name: c.display_name || c.profile_name || c.wa_id,
      phone: c.wa_id,
      at: c.call_booked_at!,
    })),
    needsAttention: needsRes.count ?? 0,
    aiPaused: pausedRes.count ?? 0,
    ghosted: ghostedRes.count ?? 0,
    languages: tally((langRes.data ?? []).map((c) => c.language)),
    followupsSent: (followupLogsRes.data ?? []).length,
    followupsRevived: revived,
    promisesSent: (promiseRows ?? []).length,
    promisesRevived,
    revival,
    abTest,
    insights: {
      scored: insights.length,
      outcomes,
      topObjections: tally(insights.flatMap((i) => i.objections ?? [])),
      topFaqGaps: tally(insights.flatMap((i) => i.faq_gaps ?? [])),
      topQualityFlags: tally(insights.flatMap((i) => i.quality_flags ?? [])),
      dropOff: tally(losers.map((i) => i.stage_reached)),
    },
  };

  return { ok: true, analytics };
}
