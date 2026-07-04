import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { generateWeeklyDigest } from "@/lib/intelligence";
import { sendPushToUser } from "@/lib/push";

/**
 * Weekly digest cron. Schedule for Monday mornings, e.g. 8am Colombo:
 *   GET /api/intelligence/digest
 *
 * Generates (or refreshes) this week's AI digest and notifies every member.
 * Guarded by SMS_CRON_SECRET like the other tick endpoints.
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
    const { content, stats } = await generateWeeklyDigest(supabase);

    const firstLine = content.split("\n").find((l) => l.trim()) ?? "Your weekly digest is ready.";
    const { data: profiles } = await supabase.from("profiles").select("id");
    for (const p of profiles ?? []) {
      await supabase.from("notifications").insert({
        user_id: p.id,
        type: "system",
        title: "📊 Your weekly business digest is ready",
        body: firstLine,
        link: "/intelligence",
      });
      await sendPushToUser({
        userId: p.id,
        title: "Weekly business digest",
        body: firstLine,
        link: "/intelligence",
      });
    }

    return NextResponse.json({ ok: true, week_start: stats.week_start });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Digest failed." },
      { status: 500 },
    );
  }
}
