/**
 * The Approve button behind a mission plan (0103).
 *
 * This route exists so that starting a mission is something a PERSON does.
 * The model can plan any errand it likes with `propose_mission`, but the plan
 * sits at `proposed` until this endpoint is called — and it can only be
 * called from a browser carrying the user's own session cookie. There is no
 * tool that reaches it, exactly as there is no tool that reaches the two send
 * routes.
 *
 * Approving simply arms the lease: `status = approved`, `due_at = now`. The
 * next tick picks it up.
 */

import { NextResponse } from "next/server";

import { getAssistantProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const supabase = await createClient();

  // RLS already restricts this to the caller's own missions; reading first
  // just lets us answer honestly about what happened.
  const { data: mission } = await supabase
    .from("assistant_missions")
    .select("id, title, status")
    .eq("id", id)
    .maybeSingle();
  if (!mission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (mission.status !== "proposed" && mission.status !== "paused") {
    // Double-tap, or approved on another device. Not an error worth showing.
    return NextResponse.json({ ok: true, already: mission.status });
  }

  const { error } = await supabase
    .from("assistant_missions")
    .update({ status: "approved", due_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, title: mission.title });
}
