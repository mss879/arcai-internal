import { createClient } from "@/lib/supabase/server";
import { isEmailOutreachConfigured, sentToday } from "@/lib/lead-outreach";
import { campaignStats, type CampaignStats } from "@/lib/outreach-campaign";
import type { OutreachCampaign } from "@/lib/types";

import { OutreachView, type CampaignWithStats } from "./outreach-view";

export const metadata = { title: "Email campaigns" };

/** Launching enqueues rows and kicks the first drafts in `after()` — give it room. */
export const maxDuration = 60;

export default async function OutreachCampaignsPage() {
  const supabase = await createClient();

  const { data } = await supabase
    .from("outreach_campaigns")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);
  const campaigns = (data ?? []) as OutreachCampaign[];

  const stats = await Promise.all(
    campaigns.map(
      async (c): Promise<CampaignWithStats> => ({
        campaign: c,
        stats: (await campaignStats(supabase, c.id)) as CampaignStats,
      }),
    ),
  );

  // Every send counts against the cap, whatever queued it — so the header's
  // "N sent today" has to be global, not per-campaign.
  const today = await sentToday(supabase);

  return (
    <OutreachView
      campaigns={stats}
      sentToday={today}
      configured={isEmailOutreachConfigured()}
    />
  );
}
