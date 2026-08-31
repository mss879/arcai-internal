import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  processDueAutomationRuns,
  scanTimeBasedTriggers,
} from "@/lib/automation";
import { processDeliveryAutomations } from "@/lib/delivery";
import { processProjectAutomations } from "@/lib/project-automation";
import { processProjectAnomalies } from "@/lib/project-anomalies";
import { processRiskRadar } from "@/lib/ai/risk-radar";
import { processScopeScans } from "@/lib/ai/scope-creep";
import { processFinanceReminders } from "@/lib/finance";
import { processRecurringIncome } from "@/lib/recurring-income";
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
import { processAgentDigest, processWaInsights } from "@/lib/wa-insights";
import { isSmsConfigured } from "@/lib/sms";
import { processWebAnalytics } from "@/lib/web-analytics/run";

/**
 * The one cron endpoint that keeps every timer in the app moving:
 *
 *   - scans time-based automation triggers (inactivity, due dates,
 *     unpaid invoices, installments, cheques) and enrolls runs
 *   - advances due automation runs (waits, drips)
 *   - advances due SMS workflow runs (the SMS page's own automations)
 *   - sends built-in finance reminders (installments + cheque alerts)
 *   - generates this month's recurring income entries (hosting, retainers,
 *     care plans) so a month that never arrived is visible
 *   - sends task deadline reminders 5 hours before a to-do is due
 *   - processes queued CRM prospect-research reports (and retries any
 *     that got stuck when a serverless run timed out mid-report)
 *   - generates carousel designs for upcoming content-calendar posts
 *     (kicks off 3 days ahead, one copy/slide step per tick)
 *   - runs the automatic WhatsApp cold-outreach picker (top of "New Lead",
 *     research first, ≤cap template sends per day, spread apart, one
 *     follow-up nudge for delivered-but-silent leads)
 *   - sends the once-a-day morning outreach digest to the team
 *   - pulls the agency website's analytics and AI-chat transcripts into
 *     Web Analytics (hourly, self-gated; no-op until the website source
 *     credentials are set)
 *   - runs the project duplicate/anomaly guards (rule-based, every tick),
 *     the nightly project risk radar and the scope-creep reader (both
 *     self-gated to once a day)
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
    // 0100 — materialise this month's hosting/retainer/care income so a
    // missed month is visible instead of silent.
    const recurringIncome = await processRecurringIncome(supabase);
    const todos = await processTodoReminders(supabase);
    const meetings = await processMeetingReminders(supabase);
    // Client Delivery (0084): the content chaser (missing-asset WhatsApp
    // nudges, quiet-hours aware, ≤5 sends/tick) + stalled-project alerts.
    // Fast DB work — the heavy AI paths live in the WA agent tick.
    const delivery = await processDeliveryAutomations(supabase);
    // Projects (0090-0092): over-budget alerts, retainer months, the balance
    // chase ladder and aftercare task batches. All DB work, all guarded by a
    // stamp so nothing fires twice.
    const projects = await processProjectAutomations(supabase);
    // Projects theme 5 (0098). Cheap arithmetic first, then the two AI passes
    // — both self-gated to roughly once a day so a tick every minute doesn't
    // become an API bill.
    const anomalies = await processProjectAnomalies(supabase);
    const riskRadar = await processRiskRadar(supabase);
    const scopeCreep = await processScopeScans(supabase);
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
    // One agent-scoreboard push per morning (08:30–11:00 local, CAS-gated).
    const agentDigest = await processAgentDigest(supabase);
    // NOTE: Arcus's own passes — the memory miner, the pulse, nudges, the
    // morning briefing, missions and the janitor — used to run here. They now
    // have their own scheduled function (/api/assistant/tick) for the same
    // reason the WhatsApp agent does: a mission step is a model call with
    // tools, and three of those would crowd the twenty timers in this one.
    // 0105 — pull www.arcai.agency's analytics and AI-agent transcripts
    // from the website's own Supabase project, roll the touched days up
    // and label new conversations. Self-gated to once an hour and to a
    // no-op when the source is unconfigured, so it is safe here in the
    // every-minute tick. Never allowed to fail the tick: an unreachable
    // website must not stop finance reminders going out.
    const webAnalytics = await processWebAnalytics(supabase).catch((e) => ({
      ok: false,
      errors: [e instanceof Error ? e.message : String(e)],
    }));

    const sms = isSmsConfigured()
      ? await processDueSmsRuns(supabase)
      : { processed: 0, sent: 0, failed: 0 };

    return NextResponse.json({
      ok: true,
      enrolled,
      automation,
      sms,
      finance,
      recurringIncome,
      todos,
      meetings,
      delivery,
      projects,
      anomalies,
      riskRadar,
      scopeCreep,
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
      agentDigest,
      webAnalytics,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
