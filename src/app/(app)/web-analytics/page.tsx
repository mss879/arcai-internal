import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isOpenAIConfigured } from "@/lib/ai/openai";
import { isWebsiteSourceConfigured, SITE, SITE_URL } from "@/lib/web-analytics/source";
import {
  getChatSessions,
  getConvertingSessions,
  getDaily,
  getFunnel,
  getJourneys,
  getRecentSessions,
  getReports,
  getSyncStatus,
  getTopPages,
  mergeBreakdown,
  previousRange,
  rangeForDays,
  totalsFrom,
} from "@/lib/web-analytics/queries";

import { WebAnalyticsView } from "./web-analytics-view";

export const metadata = { title: "Web Analytics" };

/**
 * www.arcai.agency, as seen from the CRM.
 *
 * Admin-only, like AI & Intelligence: this is commercial data about the
 * business's own funnel, not something a delivery member needs. The route
 * gates itself server-side rather than relying on the nav hiding the link.
 *
 * Two windows are read on every load — the one on screen and the one
 * before it — because a number with no comparison is not a metric, it is
 * a fact. "412 visits" says nothing; "412 visits, up 23%" is a decision.
 */
export default async function WebAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdmin();
  const supabase = await createClient();

  const params = await searchParams;
  const requested = Number(params.days);
  const days = [7, 14, 30, 90, 180, 365].includes(requested) ? requested : 30;

  const range = rangeForDays(days);
  const prior = previousRange(range);

  const [
    daily,
    priorDaily,
    topPages,
    journeys,
    funnel,
    recentSessions,
    convertingSessions,
    chats,
    reports,
    syncStatus,
  ] = await Promise.all([
    getDaily(supabase, range),
    getDaily(supabase, prior),
    getTopPages(supabase, range, 40),
    getJourneys(supabase),
    getFunnel(supabase, range),
    getRecentSessions(supabase, 80),
    getConvertingSessions(supabase, range, 40),
    getChatSessions(supabase, 60),
    getReports(supabase, 20),
    getSyncStatus(supabase),
  ]);

  return (
    <WebAnalyticsView
      site={SITE}
      siteUrl={SITE_URL}
      days={days}
      range={range}
      daily={daily}
      totals={totalsFrom(daily)}
      previousTotals={totalsFrom(priorDaily)}
      channels={mergeBreakdown(daily, "by_channel")}
      devices={mergeBreakdown(daily, "by_device")}
      countries={mergeBreakdown(daily, "by_country")}
      browsers={mergeBreakdown(daily, "by_browser")}
      sources={mergeBreakdown(daily, "by_source")}
      campaigns={mergeBreakdown(daily, "by_campaign")}
      topPages={topPages}
      transitions={journeys.transitions}
      paths={journeys.paths}
      funnel={funnel}
      recentSessions={recentSessions}
      convertingSessions={convertingSessions}
      chats={chats}
      reports={reports}
      syncStatus={syncStatus}
      sourceReady={isWebsiteSourceConfigured()}
      aiReady={isOpenAIConfigured()}
    />
  );
}
