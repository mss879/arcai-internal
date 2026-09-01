import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireCronSecret } from "@/lib/cron-auth";
import type { Database } from "@/lib/database.types";
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
import { processCareers } from "@/lib/careers/sync";

type DB = SupabaseClient<Database>;

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
 *   - pulls job applications from the website's careers page into Careers
 *     (every 15 minutes, self-gated)
 *   - pulls the agency website's analytics and AI-chat transcripts into
 *     Web Analytics (hourly, self-gated; no-op until the website source
 *     credentials are set)
 *   - runs the project duplicate/anomaly guards, the project risk radar and
 *     the scope-creep reader (all three self-gated to about once a day)
 *
 * ## The deadline, and why the passes live in a ring
 *
 * This runs as a synchronous serverless function, which the platform kills
 * at ~10-26s — and a killed invocation is worse than a short one: it reads
 * as a 502, does not commit whatever step it was in, and leaves leases to
 * expire and re-run paid work. So the tick no longer tries to run all the
 * passes come what may. It runs them in order, and once the deadline budget
 * (TICK_BUDGET_MS, default 8s) is spent it stops STARTING new passes,
 * stores where it got to, and returns cleanly. The next tick resumes from
 * that cursor, so a slow pass delays the ones after it by minutes instead
 * of starving them forever — and an idle ring (each pass a couple of cheap
 * queries) still completes in full every tick.
 *
 * Every pass is also individually caught: one subsystem throwing must not
 * take finance reminders down with it.
 *
 * Point a scheduler at it:  GET /api/automation/tick
 * SMS_CRON_SECRET is required, as `Authorization: Bearer <secret>` only —
 * without it the route refuses to run. The automation page also ticks while
 * open (through its own authenticated server action, not this route).
 */

/** Budget for STARTING passes; the last-started pass may run to its own
 *  internal cap on top of this, which together stay inside the platform's
 *  window. */
const START_BUDGET_MS = Number(process.env.TICK_BUDGET_MS) || 8_000;

/** Where the ring buffer remembers its position between invocations. */
const CURSOR_KEY = "automation_tick";

/** Every pass, in priority order. The order only matters relative to the
 *  cursor: a resumed tick keeps walking from wherever the last one stopped. */
const PASSES: ReadonlyArray<readonly [string, (db: DB) => Promise<unknown>]> = [
  ["enrolled", scanTimeBasedTriggers],
  ["automation", processDueAutomationRuns],
  ["finance", processFinanceReminders],
  // 0100 — materialise this month's hosting/retainer/care income so a
  // missed month is visible instead of silent.
  ["recurringIncome", processRecurringIncome],
  ["todos", processTodoReminders],
  ["meetings", processMeetingReminders],
  // Client Delivery (0084): the content chaser (missing-asset WhatsApp
  // nudges, quiet-hours aware, ≤5 sends/tick) + stalled-project alerts.
  // Fast DB work — the heavy AI paths live in the WA agent tick.
  ["delivery", processDeliveryAutomations],
  // Projects (0090-0092): over-budget alerts, retainer months, the balance
  // chase ladder and aftercare task batches. All DB work, all guarded by a
  // stamp so nothing fires twice.
  ["projects", processProjectAutomations],
  // Projects theme 5 (0098). All three self-gated to roughly once a day so
  // the tick doesn't become an API (or database) bill.
  ["anomalies", processProjectAnomalies],
  ["riskRadar", processRiskRadar],
  ["scopeCreep", processScopeScans],
  ["research", processPendingResearch],
  ["schedules", processDueProspectSchedules],
  ["prospecting", processPendingProspectScans],
  // Draft (research + audit + AI email) newly-found leads. Rows drafted by a
  // draft-then-approve campaign stop at 'ready' for a human to approve.
  ["outreach", processDueOutreach],
  // The no-approval leg: sends drafts belonging to RUNNING auto-send
  // campaigns, bounded by the campaign's daily cap. Pausing stops it here.
  ["autoSend", processAutoSendQueue],
  ["carousels", processPendingCarousels],
  ["showcases", processPendingWaShowcases],
  // NOTE: live WhatsApp replies, promises and the follow-up cadence have
  // their own scheduled function (/api/whatsapp/agent-tick) so a customer
  // waiting for an answer can't be starved by a Lighthouse pass or an image
  // render in this one. Cold outreach last — live conversations always beat
  // opening new ones.
  ["coldOutreach", processColdOutreach],
  ["coldDigest", processColdDigest],
  // Revival: one capped, template-only re-knock on aged dead threads.
  ["revival", processWaRevival],
  // Self-gated to once a week (and one attempt a day) — see processWaCoaching.
  ["coaching", processWaCoaching],
  // Nightly learning loop: enqueue ended conversations once a day, score
  // ≤2 per tick, mine lessons for the approve-first queue once the day's
  // scoring drains. See wa-insights.ts.
  ["insights", processWaInsights],
  // One agent-scoreboard push per morning (08:30–11:00 local, CAS-gated).
  ["agentDigest", processAgentDigest],
  // NOTE: Arcus's own passes — the memory miner, the pulse, nudges, the
  // morning briefing, missions and the janitor — live in their own scheduled
  // function (/api/assistant/tick): a mission step is a model call with
  // tools, and three of those would crowd the timers in this one.
  // 0105 — pull www.arcai.agency's analytics and AI-agent transcripts from
  // the website's own Supabase project and roll the touched days up. Data
  // only, self-gated to once an hour, and a no-op when the source is
  // unconfigured; the daily report + chat labelling belong to the 06:15
  // scheduled function.
  ["webAnalytics", processWebAnalytics],
  // 0106 — pull job applications and any website-side vacancy changes.
  // Self-gated to every 15 minutes: an application is somebody waiting for
  // a reply.
  ["careers", processCareers],
  ["sms", (db) => (isSmsConfigured() ? processDueSmsRuns(db) : Promise.resolve({ skipped: true }))],
];

async function readCursor(supabase: DB): Promise<number> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", CURSOR_KEY)
    .maybeSingle();
  const raw = Number((data?.value as { cursor?: unknown } | null)?.cursor);
  return Number.isInteger(raw) && raw >= 0 && raw < PASSES.length ? raw : 0;
}

async function writeCursor(supabase: DB, cursor: number): Promise<void> {
  await supabase.from("app_settings").upsert(
    {
      key: CURSOR_KEY,
      value: { cursor, at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );
}

export async function GET(request: Request) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const cutoff = Date.now() + START_BUDGET_MS;
    const start = await readCursor(supabase);

    const results: Record<string, unknown> = {};
    let done = 0;
    for (; done < PASSES.length && Date.now() < cutoff; done++) {
      const [key, run] = PASSES[(start + done) % PASSES.length];
      results[key] = await run(supabase).catch((e: unknown) => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }

    await writeCursor(supabase, (start + done) % PASSES.length);

    return NextResponse.json({
      ok: true,
      completed: done,
      of: PASSES.length,
      startedAt: start,
      ...results,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
