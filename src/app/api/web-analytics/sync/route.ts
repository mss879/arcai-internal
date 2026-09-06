import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReportKind } from "@/lib/web-analytics/job-core";
import { FULL_STEP_MS, runWebAnalyticsStep } from "@/lib/web-analytics/run";

/**
 * Pull www.arcai.agency's analytics and AI-agent transcripts into the CRM.
 *
 *   GET /api/web-analytics/sync
 *     ?report=daily|weekly|monthly   also write a report for that window
 *     &chats=1                       also label new chat conversations
 *     &budget=18000                  ms of work to do in this call (2s–20s)
 *
 * One call is one bounded STEP of the job, not the whole job: this runs
 * inside a serverless function the platform kills at ~26 seconds, and the
 * job — five streams, the rollups, the chat labelling, the report — can
 * need far longer than that after a quiet night, let alone after a rebuild.
 * The call starts a job if none is running, does as much as its budget
 * allows, records where it got to, and answers with `done`. Whatever is
 * left is finished by the automation tick, a step every five minutes; a
 * caller in a hurry can also just call again until `done` is true.
 *
 * SMS_CRON_SECRET is required (the same secret the rest of the app's
 * scheduled work uses), as `Authorization: Bearer <secret>` only.
 */

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const url = new URL(request.url);

  const reportParam = url.searchParams.get("report");
  const report: ReportKind | null =
    reportParam === "daily" || reportParam === "weekly" || reportParam === "monthly"
      ? reportParam
      : null;

  const requestedBudget = Number(url.searchParams.get("budget"));
  const budgetMs = Number.isFinite(requestedBudget) && requestedBudget > 0
    ? Math.min(20_000, Math.max(2_000, requestedBudget))
    : FULL_STEP_MS;

  const started = Date.now();
  const result = await runWebAnalyticsStep(createAdminClient(), {
    budgetMs,
    request: {
      start: true,
      report,
      analyse_chats: url.searchParams.get("chats") === "1",
    },
  });

  return NextResponse.json({
    ...result,
    // Kept for the scheduled function's log line.
    totalRows: result.step?.rows ?? 0,
    errors: result.step?.errors ?? [],
    durationMs: Date.now() - started,
  });
}
