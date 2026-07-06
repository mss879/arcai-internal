import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { processDueSmsRuns } from "@/lib/sms-automation";
import { processTodoReminders } from "@/lib/todo-reminders";
import { isSmsConfigured } from "@/lib/sms";

/**
 * Cron endpoint that advances due SMS automation timers.
 *
 * The SMS page already ticks while someone has it open; point a scheduler
 * (Vercel Cron, cron-job.org, …) at this route so workflows keep firing
 * when nobody is in the app, e.g. every minute:
 *   GET /api/sms/automation/tick
 *
 * If SMS_CRON_SECRET is set in the environment, the request must carry it
 * as `Authorization: Bearer <secret>` or `?secret=<secret>`.
 */
export async function GET(request: Request) {
  const secret = process.env.SMS_CRON_SECRET?.trim();
  if (secret) {
    const url = new URL(request.url);
    const provided =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("secret") ??
      "";
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!isSmsConfigured()) {
    return NextResponse.json(
      { error: "Notify.lk is not configured (NOTIFYLK_USER_ID / NOTIFYLK_API_KEY)." },
      { status: 503 },
    );
  }

  try {
    const supabase = createAdminClient();
    const result = await processDueSmsRuns(supabase);
    // Task deadline reminders are idempotent (reminder_sent_at), so it's
    // safe to run them here too — whichever tick endpoint the scheduler
    // hits, reminders keep flowing.
    const todos = await processTodoReminders(supabase);
    return NextResponse.json({ ok: true, ...result, todos });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
