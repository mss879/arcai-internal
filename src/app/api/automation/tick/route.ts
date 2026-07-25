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
import {
  processDueWaAgentRuns,
  processDueWaFollowups,
  processDueWaPromises,
} from "@/lib/wa-agent";
import { processColdDigest, processColdOutreach } from "@/lib/wa-cold-outreach";
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
 *   - drains queued WhatsApp agent replies (the webhook only arms a
 *     debounced timer, so bursts get one reply and long runs never race
 *     the webhook's budget) and the agent's follow-up cadence
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
    // Queued inbound replies first — answering a live customer beats nudging
    // a quiet one. Promised follow-ups ("call me Monday") beat the generic
    // cadence — the customer named that moment themselves.
    const agentRuns = await processDueWaAgentRuns(supabase);
    const promises = await processDueWaPromises(supabase);
    const followups = await processDueWaFollowups(supabase);
    // Cold outreach last — live conversations always beat opening new ones.
    const coldOutreach = await processColdOutreach(supabase);
    const coldDigest = await processColdDigest(supabase);
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
      agentRuns,
      promises,
      followups,
      coldOutreach,
      coldDigest,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
