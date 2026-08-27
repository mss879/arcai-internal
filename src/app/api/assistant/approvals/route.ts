/**
 * The approvals tray's data (0103).
 *
 * Everything a mission prepared and nobody has decided on yet: the exact
 * confirm cards the tools produced, parked rather than dropped into a stream
 * that had no one watching it.
 *
 * The tray renders these with the same `AssistantCardView` the transcript
 * uses, and its Send button calls the same two send routes a card in the
 * conversation would. That is the point — persisting an approval changes
 * WHERE the card waits, never HOW it is sent.
 *
 * PATCH records the outcome after the browser has done the sending.
 */

import { NextResponse } from "next/server";

import { getAssistantProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("assistant_approvals")
    .select("id, kind, card, mission_id, created_at, expires_at")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { approvals: data ?? [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { id?: unknown; status?: unknown; error?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const id = String(body.id ?? "");
  const status = String(body.status ?? "");
  if (!id || !["sent", "declined", "failed"].includes(status)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("assistant_approvals")
    .update({
      status: status as "sent" | "declined" | "failed",
      error: body.error ? String(body.error).slice(0, 300) : null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
