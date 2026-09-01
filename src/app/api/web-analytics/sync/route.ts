import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { runWebAnalyticsPipeline } from "@/lib/web-analytics/run";

/**
 * Pull www.arcai.agency's analytics and AI-agent transcripts into the CRM.
 *
 *   GET /api/web-analytics/sync
 *     ?report=daily|weekly|monthly   also write a report for that window
 *     &chats=1                       also label new chat conversations
 *
 * SMS_CRON_SECRET is required (the same secret the rest of the app's
 * scheduled work uses), as `Authorization: Bearer <secret>` only.
 * The automation tick calls the pipeline directly and does not come
 * through here; this endpoint exists for the Netlify daily schedule and
 * for pulling on demand while debugging.
 */

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const url = new URL(request.url);

  const reportParam = url.searchParams.get("report");
  const report =
    reportParam === "daily" || reportParam === "weekly" || reportParam === "monthly"
      ? reportParam
      : null;

  const started = Date.now();
  const result = await runWebAnalyticsPipeline(createAdminClient(), {
    report,
    analyseChats: url.searchParams.get("chats") !== "0",
  });

  return NextResponse.json({
    ...result,
    durationMs: Date.now() - started,
  });
}
