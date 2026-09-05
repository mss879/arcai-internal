import { NextResponse } from "next/server";

import { buildIcs, icsFilename } from "@/lib/ics";
import { INVOICE_COMPANY } from "@/lib/invoice";
import { clientIp, enforceRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * The client's own "add to calendar" link, from their project portal.
 *
 * Scoped by the project's share token and a meeting id: the token proves which
 * project the caller can see, and the meeting must belong to that project's
 * client — so a valid token for one project cannot enumerate another client's
 * meetings. Columns are hand-picked, like every other public read.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const meetingId = new URL(request.url).searchParams.get("meeting");
  if (!token || !meetingId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const supabase = createAdminClient();

  // 0116 — a calendar file is cheap, but a token guess is not something to
  // offer unlimited tries at.
  const limited = await enforceRateLimit(supabase, `meeting-ics:${clientIp(request.headers)}`, {
    limit: 30,
    windowSec: 600,
  });
  if (!limited.ok) return tooManyRequests(limited.retryAfter);

  const { data: project } = await supabase
    .from("projects")
    .select("id, client_id, portal_revoked_at, deleted_at")
    .eq("share_token", token)
    .maybeSingle();
  if (!project || project.deleted_at || project.portal_revoked_at || !project.client_id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: meeting } = await supabase
    .from("meetings")
    .select(
      "id, title, description, meeting_at, duration_minutes, location, meeting_url, sequence",
    )
    .eq("id", meetingId)
    // The tenancy guard: this meeting must be with THIS project's client.
    .eq("client_id", project.client_id)
    .maybeSingle();
  if (!meeting) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ics = buildIcs({
    uid: `meeting-${meeting.id}@arcai`,
    sequence: meeting.sequence ?? 0,
    method: "REQUEST",
    title: meeting.title,
    description: meeting.description,
    location: meeting.meeting_url || meeting.location,
    url: meeting.meeting_url,
    startsAt: meeting.meeting_at,
    durationMinutes: meeting.duration_minutes,
    organizer: { name: INVOICE_COMPANY.name, email: INVOICE_COMPANY.email },
    stampedAt: new Date().toISOString(),
  });

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${icsFilename(meeting.title)}"`,
      "Cache-Control": "no-store",
    },
  });
}
