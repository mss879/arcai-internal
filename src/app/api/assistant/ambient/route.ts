import { NextResponse } from "next/server";

import { getAssistantProfile } from "@/lib/auth";
import { collectDigestStats } from "@/lib/intelligence";
import { localDateInTimezone } from "@/lib/wa-coaching";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET → what the idle stage shows (0104): the vital signs, the open events,
 * and today's briefing headline.
 *
 * One route rather than three client queries because two of the three
 * sources are server-only by design — `collectDigestStats` lives behind
 * `server-only` (it is the briefing's own numbers), and the briefing thread
 * id needs the member's configured timezone to derive. Everything reads
 * through the CALLER's session client, so RLS decides what they see.
 *
 * Cheap by construction: the stats are ~a dozen `head:true` counts, the
 * events are one indexed select, the briefing is two primary-key lookups.
 * The client polls every few minutes and leans on realtime for the rest.
 */
export async function GET() {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supabase = await createClient();

  try {
    const [stats, eventsRes, config] = await Promise.all([
      collectDigestStats(supabase),
      supabase
        .from("assistant_events")
        .select("id, kind, title, body, href, importance, created_at")
        .eq("status", "new")
        .neq("source", "pulse-marker")
        .gte("importance", 2)
        .order("importance", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("assistant_config")
        .select("timezone")
        .eq("user_id", profile.id)
        .maybeSingle(),
    ]);

    // Today's briefing, by derived id — no search needed (see briefing.ts:
    // `briefing-<localDate>-<uid8>` with a single `-msg` message).
    const tz = config.data?.timezone || "Asia/Colombo";
    const threadId = `briefing-${localDateInTimezone(tz)}-${profile.id.slice(0, 8)}`;
    const { data: briefingMsg } = await supabase
      .from("assistant_messages")
      .select("content")
      .eq("id", `${threadId}-msg`)
      .maybeSingle();

    return NextResponse.json({
      stats,
      events: eventsRes.data ?? [],
      briefing: briefingMsg
        ? { threadId, headline: briefingMsg.content.slice(0, 280) }
        : null,
    });
  } catch {
    // A half-empty idle screen beats a 500 the client has to special-case.
    return NextResponse.json({ stats: null, events: [], briefing: null });
  }
}
