import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { isOpenAIConfigured, openaiChat } from "@/lib/ai/openai";

type DB = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Weekly business digest
// ---------------------------------------------------------------------------

export type DigestStats = {
  week_start: string;
  new_leads: number;
  going_cold: number;
  open_deal_value: number;
  won_this_week: number;
  won_value: number;
  unpaid_invoices: number;
  unpaid_value: number;
  quotes_awaiting: number;
  quotes_accepted_week: number;
  revenue_month: number;
  expenses_month: number;
  overdue_tasks: number;
  best_ad: string | null;
  pending_installments: number;
  pending_installment_value: number;
  cheques_due_week: number;
};

/** Monday of the current week (ISO date). */
export function currentWeekStart(): string {
  const now = new Date();
  const day = now.getDay(); // 0 Sun … 6 Sat
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  return monday.toISOString().slice(0, 10);
}

export async function collectDigestStats(supabase: DB): Promise<DigestStats> {
  const weekStart = currentWeekStart();
  const weekStartIso = `${weekStart}T00:00:00Z`;
  const now = new Date();
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const coldCutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  const weekAhead = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  const [
    newLeads,
    coldLeads,
    openLeads,
    wonWeek,
    invoices,
    quotes,
    payments,
    installmentsPaid,
    installmentsPending,
    expenses,
    tasks,
    ads,
    chequesDue,
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", weekStartIso)
      .is("deleted_at", null),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .is("deleted_at", null)
      .lt("last_activity_at", coldCutoff),
    supabase.from("leads").select("value").eq("status", "open").is("deleted_at", null),
    supabase
      .from("leads")
      .select("value")
      .eq("status", "won")
      .gte("won_at", weekStartIso),
    supabase.from("invoices").select("grand_total, stamp, sent_at"),
    supabase.from("quotes").select("status, accepted_at"),
    supabase
      .from("payments")
      .select("amount, paid_at, created_at")
      .eq("status", "paid"),
    supabase.from("payment_installments").select("amount, paid_at").eq("status", "paid"),
    supabase.from("payment_installments").select("amount").eq("status", "pending"),
    supabase.from("expenses").select("amount, expense_date").gte("expense_date", monthStart),
    supabase
      .from("crm_tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .lt("due_at", new Date().toISOString()),
    supabase.from("ad_entries").select("*").order("period_start", { ascending: false }).limit(20),
    supabase
      .from("cheques")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lte("due_date", weekAhead),
  ]);

  const unpaid = (invoices.data ?? []).filter((i) => !i.stamp && i.sent_at);
  const revenueMonth =
    (payments.data ?? [])
      .filter((p) => (p.paid_at ?? p.created_at) >= `${monthStart}T00:00:00`)
      .reduce((s, p) => s + Number(p.amount), 0) +
    (installmentsPaid.data ?? [])
      .filter((i) => (i.paid_at ?? "") >= `${monthStart}T00:00:00`)
      .reduce((s, i) => s + Number(i.amount), 0);

  // Best ad = highest leads per rupee among recent entries with spend.
  let bestAd: string | null = null;
  let bestRatio = -1;
  for (const ad of ads.data ?? []) {
    if (Number(ad.spend) <= 0) continue;
    const ratio = (Number(ad.leads ?? 0) || Number(ad.revenue ?? 0) / 1000) / Number(ad.spend);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestAd = `${ad.campaign} (${ad.platform})`;
    }
  }

  return {
    week_start: weekStart,
    new_leads: newLeads.count ?? 0,
    going_cold: coldLeads.count ?? 0,
    open_deal_value: (openLeads.data ?? []).reduce((s, l) => s + Number(l.value ?? 0), 0),
    won_this_week: (wonWeek.data ?? []).length,
    won_value: (wonWeek.data ?? []).reduce((s, l) => s + Number(l.value ?? 0), 0),
    unpaid_invoices: unpaid.length,
    unpaid_value: unpaid.reduce((s, i) => s + Number(i.grand_total), 0),
    quotes_awaiting: (quotes.data ?? []).filter((q) => ["sent", "viewed"].includes(q.status))
      .length,
    quotes_accepted_week: (quotes.data ?? []).filter(
      (q) => q.accepted_at && q.accepted_at >= weekStartIso,
    ).length,
    revenue_month: revenueMonth,
    expenses_month: (expenses.data ?? []).reduce((s, e) => s + Number(e.amount), 0),
    overdue_tasks: tasks.count ?? 0,
    best_ad: bestAd,
    pending_installments: (installmentsPending.data ?? []).length,
    pending_installment_value: (installmentsPending.data ?? []).reduce(
      (s, i) => s + Number(i.amount),
      0,
    ),
    cheques_due_week: chequesDue.count ?? 0,
  };
}

const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString("en-US")}`;

/** Deterministic digest used when OpenAI isn't configured (and as AI context). */
function digestFallback(s: DigestStats): string {
  const lines = [
    `📊 Week of ${s.week_start}`,
    ``,
    `• ${s.new_leads} new lead${s.new_leads === 1 ? "" : "s"} came in, ${s.going_cold} going cold.`,
    `• Open pipeline worth ${rs(s.open_deal_value)}; ${s.won_this_week} deal${s.won_this_week === 1 ? "" : "s"} won this week (${rs(s.won_value)}).`,
    `• ${rs(s.unpaid_value)} pending across ${s.unpaid_invoices} unpaid invoice${s.unpaid_invoices === 1 ? "" : "s"}.`,
    `• ${s.quotes_awaiting} quote${s.quotes_awaiting === 1 ? "" : "s"} awaiting a response; ${s.quotes_accepted_week} accepted this week.`,
    `• Revenue this month ${rs(s.revenue_month)} vs expenses ${rs(s.expenses_month)} → ${rs(s.revenue_month - s.expenses_month)} profit.`,
    s.best_ad ? `• Best ad: ${s.best_ad}.` : null,
    s.cheques_due_week ? `• ${s.cheques_due_week} cheque(s) hit their date within 7 days.` : null,
    ``,
    `🎯 Your 3 actions this week:`,
    s.going_cold > 0
      ? `1. Call the ${s.going_cold} cooling lead${s.going_cold === 1 ? "" : "s"} before they slip away.`
      : `1. Keep the pipeline moving — follow up every open deal once.`,
    s.unpaid_invoices > 0
      ? `2. Chase the ${s.unpaid_invoices} unpaid invoice${s.unpaid_invoices === 1 ? "" : "s"} (${rs(s.unpaid_value)}).`
      : `2. Send quotes for your hottest leads while they're warm.`,
    s.overdue_tasks > 0
      ? `3. Clear the ${s.overdue_tasks} overdue follow-up task${s.overdue_tasks === 1 ? "" : "s"}.`
      : `3. Log this week's expenses so the profit snapshot stays honest.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/** Generate (or regenerate) this week's digest and store it. */
export async function generateWeeklyDigest(
  supabase: DB,
): Promise<{ content: string; stats: DigestStats }> {
  const stats = await collectDigestStats(supabase);

  let content = digestFallback(stats);
  if (isOpenAIConfigured()) {
    try {
      const reply = await openaiChat([
        {
          role: "system",
          content:
            "You are the AI business analyst for ARC AI, a Sri Lankan digital agency. Write a punchy Monday-morning digest for the owner in plain text (no markdown symbols like # or *). Use short lines, a few emoji, amounts in Rs. End with exactly three numbered actions for the week, chosen from the data. Keep it under 180 words.",
        },
        {
          role: "user",
          content: `This week's numbers as JSON:\n${JSON.stringify(stats)}\n\nDraft the digest.`,
        },
      ]);
      if (reply.content?.trim()) content = reply.content.trim();
    } catch {
      // fall back to the deterministic digest
    }
  }

  await supabase
    .from("ai_digests")
    .upsert(
      {
        week_start: stats.week_start,
        content,
        stats: stats as unknown as Record<string, unknown>,
      },
      { onConflict: "week_start" },
    );

  return { content, stats };
}

// ---------------------------------------------------------------------------
// Churn / cold-customer alerts
// ---------------------------------------------------------------------------

/**
 * Flag clients whose activity dropped: no paid payment, project, meeting or
 * SMS in the last 60 days. One open alert per client at a time.
 */
export async function scanChurn(supabase: DB): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString();

  const [{ data: clients }, { data: payments }, { data: existing }, { data: smsLog }] =
    await Promise.all([
      supabase.from("clients").select("*").eq("status", "active"),
      supabase.from("payments").select("project_id, amount, paid_at, created_at, status"),
      supabase.from("churn_alerts").select("client_id").eq("status", "open"),
      supabase
        .from("sms_messages")
        .select("client_id, created_at")
        .gte("created_at", cutoff),
    ]);

  const { data: projects } = await supabase
    .from("projects")
    .select("id, client_id, created_at")
    .is("deleted_at", null);

  const alerted = new Set((existing ?? []).map((a) => a.client_id));
  const recentSms = new Set(
    (smsLog ?? []).filter((m) => m.client_id).map((m) => m.client_id as string),
  );

  const lastPaymentByClient = new Map<string, string>();
  const projectClient = new Map((projects ?? []).map((p) => [p.id, p.client_id]));
  for (const p of payments ?? []) {
    if (p.status !== "paid") continue;
    const clientId = projectClient.get(p.project_id);
    if (!clientId) continue;
    const at = p.paid_at ?? p.created_at;
    const prev = lastPaymentByClient.get(clientId);
    if (!prev || at > prev) lastPaymentByClient.set(clientId, at);
  }

  let created = 0;
  for (const client of clients ?? []) {
    if (alerted.has(client.id)) continue;
    if (recentSms.has(client.id)) continue;

    const lastPayment = lastPaymentByClient.get(client.id);
    const recentProject = (projects ?? []).some(
      (p) => p.client_id === client.id && p.created_at >= cutoff,
    );
    if (recentProject) continue;
    if (lastPayment && lastPayment >= cutoff) continue;

    const daysSince = lastPayment
      ? Math.floor((Date.now() - new Date(lastPayment).getTime()) / 86400_000)
      : null;
    const severity = daysSince == null || daysSince > 120 ? "cold" : daysSince > 90 ? "warm" : "cooling";
    const reason = lastPayment
      ? `No payment in ${daysSince} days and no recent project activity.`
      : "No payments on record and no recent project activity.";

    const firstName = client.name.split(/\s+/)[0] || "there";
    let draft = `Hi ${firstName}, it's ARC AI — it's been a while! We've added new services (AI automations, marketing packages) that could help ${client.company || "your business"} grow. Can we show you what's new? Reply here or call +94 77 185 2522.`;
    if (isOpenAIConfigured()) {
      try {
        const reply = await openaiChat([
          {
            role: "system",
            content:
              "Write a warm, short win-back SMS (max 300 chars, plain text) from ARC AI, a Sri Lankan digital agency, to a client who has gone quiet. Friendly, no guilt-tripping, one clear call to action.",
          },
          {
            role: "user",
            content: `Client: ${client.name}${client.company ? `, company: ${client.company}` : ""}. ${reason}`,
          },
        ]);
        if (reply.content?.trim()) draft = reply.content.trim();
      } catch {
        // keep template
      }
    }

    await supabase.from("churn_alerts").insert({
      client_id: client.id,
      client_name: client.name,
      severity,
      reason,
      draft_message: draft,
    });
    created++;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Lead scoring
// ---------------------------------------------------------------------------

/** Heuristic score used without AI (and as tie-breaker context). */
function heuristicScore(lead: {
  value: number | null;
  last_activity_at: string;
  created_at: string;
  source: string;
  contact_phone: string | null;
  contact_email: string | null;
}): { score: "hot" | "warm" | "cold"; reason: string } {
  let points = 0;
  const daysSinceActivity = (Date.now() - new Date(lead.last_activity_at).getTime()) / 86400_000;
  const ageDays = (Date.now() - new Date(lead.created_at).getTime()) / 86400_000;

  if (daysSinceActivity < 2) points += 3;
  else if (daysSinceActivity < 7) points += 1;
  else if (daysSinceActivity > 14) points -= 2;
  if (Number(lead.value ?? 0) > 100_000) points += 2;
  else if (Number(lead.value ?? 0) > 0) points += 1;
  if (["form", "webhook", "api"].includes(lead.source)) points += 1; // inbound intent
  if (lead.contact_phone) points += 1;
  if (ageDays < 3) points += 1;

  const score = points >= 4 ? "hot" : points >= 1 ? "warm" : "cold";
  return {
    score,
    reason: `Heuristic: ${Math.round(daysSinceActivity)}d since activity, value ${rs(Number(lead.value ?? 0))}, source ${lead.source}.`,
  };
}

/** Score every open, unscored lead (or all open leads when rescoreAll). */
export async function scoreLeads(
  supabase: DB,
  opts: { rescoreAll?: boolean } = {},
): Promise<number> {
  let q = supabase
    .from("leads")
    .select("*")
    .eq("status", "open")
    .is("deleted_at", null)
    .limit(100);
  if (!opts.rescoreAll) q = q.is("score", null);
  const { data: leads } = await q;
  if (!leads?.length) return 0;

  const useAi = isOpenAIConfigured();
  let aiScores: Map<string, { score: string; reason: string }> | null = null;

  if (useAi) {
    try {
      const compact = leads.map((l) => ({
        id: l.id,
        title: l.title,
        value: l.value,
        source: l.source,
        days_inactive: Math.round(
          (Date.now() - new Date(l.last_activity_at).getTime()) / 86400_000,
        ),
        age_days: Math.round((Date.now() - new Date(l.created_at).getTime()) / 86400_000),
        has_phone: Boolean(l.contact_phone),
        tags: l.tags,
        notes: (l.notes ?? "").slice(0, 200),
      }));
      const reply = await openaiChat([
        {
          role: "system",
          content:
            'Score CRM leads hot/warm/cold for a Sri Lankan digital agency. Hot = likely to buy soon, call first. Reply ONLY with JSON: {"scores":[{"id":"…","score":"hot|warm|cold","reason":"…max 12 words"}]}',
        },
        { role: "user", content: JSON.stringify(compact) },
      ]);
      const parsed = JSON.parse(reply.content ?? "{}") as {
        scores?: { id: string; score: string; reason: string }[];
      };
      if (parsed.scores?.length) {
        aiScores = new Map(parsed.scores.map((s) => [s.id, s]));
      }
    } catch {
      aiScores = null;
    }
  }

  let updated = 0;
  for (const lead of leads) {
    const ai = aiScores?.get(lead.id);
    const result =
      ai && ["hot", "warm", "cold"].includes(ai.score)
        ? { score: ai.score as "hot", reason: ai.reason }
        : heuristicScore(lead);
    const { error } = await supabase
      .from("leads")
      .update({ score: result.score, score_reason: result.reason })
      .eq("id", lead.id);
    if (!error) updated++;
  }
  return updated;
}
