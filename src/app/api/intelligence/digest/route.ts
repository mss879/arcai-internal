import { NextResponse } from "next/server";

import { requireCronSecret } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateWeeklyDigest } from "@/lib/intelligence";
import { sendPushToUser } from "@/lib/push";
import { analyzeWaSalesWeek } from "@/lib/wa-coaching";

/**
 * Weekly digest cron. Schedule for Monday mornings, e.g. 8am Colombo:
 *   GET /api/intelligence/digest
 *
 * Generates (or refreshes) this week's AI digest and notifies every member.
 * Guarded by SMS_CRON_SECRET like the other tick endpoints (required,
 * `Authorization: Bearer <secret>` only).
 */
export async function GET(request: Request) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const { content, stats } = await generateWeeklyDigest(supabase);

    // Self-improving playbook: distil the last fortnight's WhatsApp
    // conversations into coaching the agent applies from its next reply.
    // Never blocks the digest itself.
    const coaching = await analyzeWaSalesWeek(supabase).catch((e) => {
      console.error("[digest] coaching analysis failed:", e);
      return { ok: false as const };
    });

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

    return NextResponse.json({
      ok: true,
      week_start: stats.week_start,
      coaching: coaching.ok,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Digest failed." },
      { status: 500 },
    );
  }
}
