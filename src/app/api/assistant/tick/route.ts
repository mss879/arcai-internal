import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { processAssistantBriefing } from "@/lib/assistant/briefing";
import { processAssistantJanitor } from "@/lib/assistant/janitor";
import { processAssistantMemoryMiner } from "@/lib/assistant/memory-miner";
import { processAssistantMissions } from "@/lib/assistant/missions";
import {
  processAssistantNudges,
  processAssistantPulse,
} from "@/lib/assistant/pulse";

/**
 * Arcus's own heartbeat — everything the assistant does when nobody asked.
 *
 *   - the memory miner: once a day per member, PROPOSE standing rules from
 *     yesterday's conversations (nothing is used until a human approves it)
 *   - the pulse: derive events from what the other watchers already computed
 *   - nudges: spend a small daily budget on the two or three urgent ones,
 *     inside the member's own quiet hours
 *   - the briefing: one curated conversation waiting each morning
 *   - missions: advance every approved multi-step job under a lease
 *   - the janitor: sweep tombstones, old briefings and spent events
 *
 * Split out of `/api/automation/tick` deliberately (the WhatsApp agent's tick
 * set the precedent): a mission step is a model call with tools, and three of
 * those inside the invocation that also runs twenty timers would push the
 * whole thing towards the platform's ceiling. Each pass here is CAS- or
 * lease-gated, so running every minute costs almost nothing when there is
 * nothing to do.
 *
 * Point a scheduler at it every minute: GET /api/assistant/tick
 * If SMS_CRON_SECRET is set, pass it as `Authorization: Bearer <secret>` or
 * `?secret=<secret>` — the same secret the automation tick uses.
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

    // Order matters a little: notice first, so the nudges and the briefing
    // that follow are choosing from a feed that is already up to date.
    const pulse = await processAssistantPulse(supabase);
    const nudges = await processAssistantNudges(supabase);
    const briefing = await processAssistantBriefing(supabase);
    // Missions last of the working passes — they are the expensive one, and
    // whatever budget is left is theirs.
    const missions = await processAssistantMissions(supabase);
    const memory = await processAssistantMemoryMiner(supabase);
    const janitor = await processAssistantJanitor(supabase);

    return NextResponse.json({
      ok: true,
      pulse,
      nudges,
      briefing,
      missions,
      memory,
      janitor,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Assistant tick failed." },
      { status: 500 },
    );
  }
}
