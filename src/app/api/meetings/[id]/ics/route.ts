import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { buildIcs, icsFilename } from "@/lib/ics";
import { INVOICE_COMPANY } from "@/lib/invoice";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Download one meeting as a calendar file — the "Add to calendar" link on the
 * dashboard and the meetings list. Same bytes the client is emailed, so a
 * teammate's calendar entry and the client's are the same entry.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = await createClient();
  const { data: meeting } = await supabase
    .from("meetings")
    .select(
      "id, title, description, meeting_at, duration_minutes, location, meeting_url, sequence",
    )
    .eq("id", id)
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
