import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/cron-auth";
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
 * SMS_CRON_SECRET is required, as `Authorization: Bearer <secret>` only.
 */
export async function GET(request: Request) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  // Unconfigured SMS is a normal state, not an error — a scheduler retrying
  // a 503 (or an error-rate graph counting it) helps nobody.
  if (!isSmsConfigured()) {
    return NextResponse.json({ ok: true, skipped: "sms_unconfigured" });
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
