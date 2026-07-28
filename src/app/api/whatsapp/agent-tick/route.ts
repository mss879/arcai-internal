import { NextResponse } from "next/server";

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
 * If SMS_CRON_SECRET is set, pass it as `Authorization: Bearer <secret>`
 * or `?secret=<secret>` — same guard as the automation tick.
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
