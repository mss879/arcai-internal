import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isOpenAIConfigured } from "@/lib/ai/openai";
import { isSmsConfigured } from "@/lib/sms";
import type {
  AdEntry,
  AiDigest,
  ChurnAlert,
  Competitor,
  CompetitorEntry,
  VisitorEvent,
} from "@/lib/types";

import { IntelligenceView } from "./intelligence-view";

export const metadata = { title: "AI & Intelligence" };

export default async function IntelligencePage() {
  // Admin-only: members don't see this menu item, and typing the URL
  // bounces them back to the dashboard.
  await requireAdmin();
  const supabase = await createClient();
  const monthAgoDate = new Date();
  monthAgoDate.setDate(monthAgoDate.getDate() - 30);
  const monthAgo = monthAgoDate.toISOString();

  const [
    digestsRes,
    churnRes,
    adsRes,
    visitorsRes,
    competitorsRes,
    entriesRes,
    scoreRes,
  ] = await Promise.all([
    supabase
      .from("ai_digests")
      .select("*")
      .order("week_start", { ascending: false })
      .limit(6),
    supabase
      .from("churn_alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("ad_entries").select("*").order("period_start", { ascending: false }),
    supabase
      .from("visitor_events")
      .select("*")
      .gte("created_at", monthAgo)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase.from("competitors").select("*").order("created_at", { ascending: false }),
    supabase
      .from("competitor_entries")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300),
    supabase
      .from("leads")
      .select("score")
      .eq("status", "open")
      .is("deleted_at", null),
  ]);

  const scores = { hot: 0, warm: 0, cold: 0, unscored: 0 };
  for (const row of scoreRes.data ?? []) {
    if (row.score === "hot") scores.hot++;
    else if (row.score === "warm") scores.warm++;
    else if (row.score === "cold") scores.cold++;
    else scores.unscored++;
  }

  return (
    <IntelligenceView
      digests={(digestsRes.data ?? []) as AiDigest[]}
      churnAlerts={(churnRes.data ?? []) as ChurnAlert[]}
      ads={(adsRes.data ?? []) as AdEntry[]}
      visitorEvents={(visitorsRes.data ?? []) as VisitorEvent[]}
      competitors={(competitorsRes.data ?? []) as Competitor[]}
      competitorEntries={(entriesRes.data ?? []) as CompetitorEntry[]}
      scores={scores}
      aiReady={isOpenAIConfigured()}
      smsReady={isSmsConfigured()}
    />
  );
}
