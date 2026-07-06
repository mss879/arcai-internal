import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  processDueAutomationRuns,
  scanTimeBasedTriggers,
} from "@/lib/automation";
import { processFinanceReminders } from "@/lib/finance";
import { processDueSmsRuns } from "@/lib/sms-automation";
import { processTodoReminders } from "@/lib/todo-reminders";
import { isSmsConfigured } from "@/lib/sms";

/**
 * The one cron endpoint that keeps every timer in the app moving:
 *
 *   - scans time-based automation triggers (inactivity, due dates,
 *     unpaid invoices, installments, cheques) and enrolls runs
 *   - advances due automation runs (waits, drips)
 *   - advances due SMS workflow runs (the SMS page's own automations)
 *   - sends built-in finance reminders (installments + cheque alerts)
 *   - sends task deadline reminders 5 hours before a to-do is due
 *
 * Point a scheduler at it every minute:  GET /api/automation/tick
 * If SMS_CRON_SECRET is set, pass it as `Authorization: Bearer <secret>`
 * or `?secret=<secret>`. The automation page also ticks while open.
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

  try {
    const supabase = createAdminClient();
    const enrolled = await scanTimeBasedTriggers(supabase);
    const automation = await processDueAutomationRuns(supabase);
    const finance = await processFinanceReminders(supabase);
    const todos = await processTodoReminders(supabase);
    const sms = isSmsConfigured()
      ? await processDueSmsRuns(supabase)
      : { processed: 0, sent: 0, failed: 0 };

    return NextResponse.json({ ok: true, enrolled, automation, sms, finance, todos });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
