import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { loadGoProjects } from "@/lib/go-projects";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * The on-the-go list as JSON (0119).
 *
 * The service worker fetches this network-first and keeps the last good copy,
 * so /projects/go can still show the list with no signal. Same builder as the
 * page, so the offline copy is the list the page would have rendered.
 */
export async function GET() {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supabase = await createClient();
  const projects = await loadGoProjects(supabase);
  return NextResponse.json(
    { ok: true, at: new Date().toISOString(), userId: profile.id, projects },
    { headers: { "Cache-Control": "no-store" } },
  );
}
