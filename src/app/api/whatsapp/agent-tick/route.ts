import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  processDueWaAgentRuns,
  processDueWaFollowups,
  processDueWaPromises,
} from "@/lib/wa-agent";

/**
 * The WhatsApp agent's own cron endpoint — everything that talks to a live
 * customer, and nothing else.
 *
 * Split out of /api/automation/tick on purpose. That route runs ~15
 * subsystems sequentially in one serverless invocation with no deadline, so
 * "a later stage" effectively means "may not run at all" — the WhatsApp agent
 * sat 13th, behind prospect scans, lead-outreach drafting, carousel
 * generation and a full Lighthouse pass. A warm lead from a Meta ad cannot
 * wait behind an image render.
 *
 * Order here matters too: answering someone who just wrote beats nudging
 * someone who went quiet, and a follow-up the customer asked for themselves
 * ("call me Monday") beats the generic cadence.
 *
 * Netlify runs this every minute via netlify/functions/wa-agent-tick.mts.
 * SMS_CRON_SECRET is required, as `Authorization: Bearer <secret>` only —
 * same guard as the automation tick.
 */
export async function GET(request: Request) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const agentRuns = await processDueWaAgentRuns(supabase);
    const promises = await processDueWaPromises(supabase);
    const followups = await processDueWaFollowups(supabase);

    return NextResponse.json({
      ok: true,
      agentRuns,
      promises,
      followups,
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[wa-agent-tick] failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Tick failed." },
      { status: 500 },
    );
  }
}
