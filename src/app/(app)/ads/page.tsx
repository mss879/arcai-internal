import { requireAdmin } from "@/lib/auth";
import { loadAdsPage } from "@/lib/meta-ads/queries";
import { createClient } from "@/lib/supabase/server";

import { AdsView } from "./ads-view";

export const metadata = { title: "Ads" };

/**
 * Meta ads, judged by what they produced here (0132).
 *
 * Admin-only, like Web Analytics: spend is commercial data about the
 * business, and the route gates itself rather than trusting the nav to hide
 * the link. The meta_ad_* tables are admin-read under RLS as well.
 *
 * Nothing on this page talks to Meta. The ad numbers are whatever Claude
 * last synced (scripts/ads-sync.mjs); the chats, leads and bookings are read
 * live, so the funnel's CRM half is always current. Before 0132 is applied
 * the loader returns a setup state rather than throwing.
 */
export default async function AdsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string; window?: string }>;
}) {
  await requireAdmin();
  const supabase = await createClient();
  const params = await searchParams;

  const data = await loadAdsPage(supabase, {
    campaign: typeof params.campaign === "string" ? params.campaign : undefined,
    window: typeof params.window === "string" ? params.window : undefined,
  });

  return <AdsView data={data} />;
}
