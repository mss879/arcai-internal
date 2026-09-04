"use server";

import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/** One emailed lead, as shown in the analytics popup. */
export type ColdEmailRow = {
  leadId: string;
  company: string;
  /** Addresses the email actually went to. */
  to: string[];
  subject: string;
  sentAt: string | null;
  /** 'sent' unless the address later bounced or was marked as spam. */
  outcome: "sent" | "bounced" | "complained";
  campaign: string | null;
};

export type ColdEmailAnalytics = {
  sent: number;
  sentToday: number;
  bounced: number;
  complained: number;
  /** Drafted, waiting on a human to approve — not yet emailed. */
  awaitingApproval: number;
  /** Still being researched/written. */
  inProgress: number;
  /** No deliverable address found. */
  skipped: number;
  failed: number;
  rows: ColdEmailRow[];
  /**
   * 0117 — opens and clicks come from the Resend webhook now. Still a flag
   * rather than an assumption: tracking has to be switched on for the sending
   * domain in Resend, and until it is, every count is a truthful zero that
   * would read as a lie.
   */
  opensTracked: boolean;
  opened: number;
  clicked: number;
};

const MAX_ROWS = 500;

/**
 * Everything the cold-email analytics popup shows.
 *
 * Deliberately reports only what's actually known: a row is `sent` because
 * Resend accepted it and we stored a sent_at, and `bounced`/`complained`
 * because the Resend webhook told us so and suppressed the address. Opens and
 * clicks (0117) are read from the email log, which the webhook stamps — and
 * are shown only once at least one has actually arrived, because a column of
 * zeros reads as "nobody opened it" rather than "we aren't measuring".
 */
export async function coldEmailAnalytics(): Promise<
  ActionResult<{ analytics: ColdEmailAnalytics }>
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: outreach, error } = await supabase
    .from("lead_outreach")
    .select("lead_id, status, sent_to, subject, sent_at, campaign_id")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(MAX_ROWS);
  if (error) return { ok: false, error: error.message };

  const all = outreach ?? [];
  const emailed = all.filter((r) => r.sent_at && (r.sent_to ?? []).length);

  // Resolve company + campaign names in one round-trip each rather than per
  // row (lead_outreach has no declared FK relationship to join through).
  const leadIds = [...new Set(emailed.map((r) => r.lead_id))];
  const names = new Map<string, string>();
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data } = await supabase
      .from("leads")
      .select("id, company, title")
      .in("id", leadIds.slice(i, i + 200));
    for (const l of data ?? []) {
      names.set(l.id, l.company?.trim() || l.title?.trim() || "Untitled lead");
    }
  }

  const campaignIds = [
    ...new Set(emailed.map((r) => r.campaign_id).filter(Boolean)),
  ] as string[];
  const campaigns = new Map<string, string>();
  if (campaignIds.length) {
    const { data } = await supabase
      .from("outreach_campaigns")
      .select("id, name")
      .in("id", campaignIds);
    for (const c of data ?? []) campaigns.set(c.id, c.name);
  }

  // A send that later bounced or got marked as spam is a failure, not a
  // success — the suppression list is the only record of that, so fold it in.
  const addresses = [
    ...new Set(emailed.flatMap((r) => (r.sent_to ?? []).map((e) => e.toLowerCase()))),
  ];
  const suppressed = new Map<string, string>();
  for (let i = 0; i < addresses.length; i += 200) {
    const chunk = addresses.slice(i, i + 200);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from("outreach_suppressions")
      .select("email, reason")
      .in("email", chunk);
    for (const s of data ?? []) suppressed.set(s.email.toLowerCase(), s.reason);
  }

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const rows: ColdEmailRow[] = emailed.map((r) => {
    const to = r.sent_to ?? [];
    const reasons = to.map((e) => suppressed.get(e.toLowerCase()));
    const outcome: ColdEmailRow["outcome"] = reasons.includes("complaint")
      ? "complained"
      : reasons.includes("bounce")
        ? "bounced"
        : "sent";
    return {
      leadId: r.lead_id,
      company: names.get(r.lead_id) ?? "Untitled lead",
      to,
      subject: r.subject,
      sentAt: r.sent_at,
      outcome,
      campaign: r.campaign_id ? (campaigns.get(r.campaign_id) ?? null) : null,
    };
  });

  const count = (s: string) => all.filter((r) => r.status === s).length;

  // 0117 — engagement, from the email log the webhook stamps.
  let opened = 0;
  let clicked = 0;
  try {
    const { data: engagement } = await supabase
      .from("email_messages")
      .select("opened_at, clicked_at")
      .eq("kind", "outreach")
      .not("opened_at", "is", null)
      .limit(1000);
    opened = (engagement ?? []).length;
    clicked = (engagement ?? []).filter((e) => e.clicked_at).length;
  } catch {
    // 0115 not applied — the rest of the numbers still stand.
  }

  return {
    ok: true,
    analytics: {
      sent: rows.filter((r) => r.outcome === "sent").length,
      sentToday: rows.filter((r) => r.sentAt && new Date(r.sentAt) >= midnight)
        .length,
      bounced: rows.filter((r) => r.outcome === "bounced").length,
      complained: rows.filter((r) => r.outcome === "complained").length,
      awaitingApproval: count("ready"),
      inProgress: count("pending") + count("researching") + count("drafting"),
      skipped: count("skipped"),
      failed: count("failed"),
      rows,
      opened,
      clicked,
      opensTracked: opened > 0 || clicked > 0,
    },
  };
}
