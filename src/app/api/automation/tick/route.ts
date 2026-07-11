import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  processDueAutomationRuns,
  scanTimeBasedTriggers,
} from "@/lib/automation";
import { processFinanceReminders } from "@/lib/finance";
import { processDueSmsRuns } from "@/lib/sms-automation";
import { processTodoReminders } from "@/lib/todo-reminders";
import { processMeetingReminders } from "@/lib/meeting-reminders";
import { processPendingResearch } from "@/lib/research";
import {
  processDueProspectSchedules,
  processPendingProspectScans,
} from "@/lib/prospecting";
import { processPendingCarousels } from "@/lib/carousels";
import { processPendingWaShowcases } from "@/lib/wa-showcase";
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
 *   - processes queued CRM prospect-research reports (and retries any
 *     that got stuck when a serverless run timed out mid-report)
 *   - generates carousel designs for upcoming content-calendar posts
 *     (kicks off 3 days ahead, one copy/slide step per tick)
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
    const meetings = await processMeetingReminders(supabase);
    const research = await processPendingResearch(supabase);
    const schedules = await processDueProspectSchedules(supabase);
    const prospecting = await processPendingProspectScans(supabase);
    const carousels = await processPendingCarousels(supabase);
    const showcases = await processPendingWaShowcases(supabase);
    const sms = isSmsConfigured()
      ? await processDueSmsRuns(supabase)
      : { processed: 0, sent: 0, failed: 0 };

    return NextResponse.json({
      ok: true,
      enrolled,
      automation,
      sms,
      finance,
      todos,
      meetings,
      research,
      schedules,
      prospecting,
      carousels,
      showcases,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
