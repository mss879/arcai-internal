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
import { processAutoSendQueue, processDueOutreach } from "@/lib/lead-outreach";
import { processPendingCarousels } from "@/lib/carousels";
import { processPendingWaShowcases } from "@/lib/wa-showcase";
import { processColdDigest, processColdOutreach } from "@/lib/wa-cold-outreach";
import { processWaRevival } from "@/lib/wa-revival";
import { processWaCoaching } from "@/lib/wa-coaching";
import { processWaInsights } from "@/lib/wa-insights";
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
 *   - runs the automatic WhatsApp cold-outreach picker (top of "New Lead",
 *     research first, ≤cap template sends per day, spread apart, one
 *     follow-up nudge for delivered-but-silent leads)
 *   - sends the once-a-day morning outreach digest to the team
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
    // Draft (research + audit + AI email) newly-found leads. Rows drafted by a
    // draft-then-approve campaign stop at 'ready' for a human to approve.
    const outreach = await processDueOutreach(supabase);
    // The no-approval leg: sends drafts belonging to RUNNING auto-send
    // campaigns, bounded by the campaign's daily cap. Pausing stops it here.
    const autoSend = await processAutoSendQueue(supabase);
    const carousels = await processPendingCarousels(supabase);
    const showcases = await processPendingWaShowcases(supabase);
    // NOTE: live WhatsApp replies, promises and the follow-up cadence used to
    // run here, 13th of 18. They now have their own scheduled function
    // (/api/whatsapp/agent-tick) so a customer waiting for an answer can't be
    // starved by a Lighthouse pass or an image render in this one.
    // Cold outreach last — live conversations always beat opening new ones.
    const coldOutreach = await processColdOutreach(supabase);
    const coldDigest = await processColdDigest(supabase);
    // Revival: one capped, template-only re-knock on aged dead threads.
    const revival = await processWaRevival(supabase);
    // Self-gated to once a week (and one attempt a day) — see processWaCoaching.
    const coaching = await processWaCoaching(supabase);
    // Nightly learning loop: enqueue ended conversations once a day, score
    // ≤2 per tick, mine lessons for the approve-first queue once the day's
    // scoring drains. See wa-insights.ts.
    const insights = await processWaInsights(supabase);
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
      outreach,
      autoSend,
      carousels,
      showcases,
      coldOutreach,
      coldDigest,
      revival,
      coaching,
      insights,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
