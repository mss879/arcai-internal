import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getAssistantProfile } from "@/lib/auth";
import { sendPortalLink } from "@/lib/portal-send";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Send a client their project link, on the assistant's behalf (0119).
 *
 * Fires only when a person taps Send on the confirmation card. Goes through
 * sendPortalLink() with actor 'assistant', so it walks the same ladder as the
 * project page — WhatsApp while their chat is open, the approved template
 * after, SMS last, a task when nothing can send — and writes the same
 * `portal_sent` History line, with the actor recorded. The model never
 * reaches this route; neither does a mission on a cron.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { projectId?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const projectId = String(body?.projectId ?? "").trim();
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Which project?" }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : null;

  const supabase = await createClient();
  const res = await sendPortalLink(supabase, projectId, {
    actor: "assistant",
    actorId: profile.id,
    note,
  });

  revalidatePath(`/projects/${projectId}`);

  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: res.taskCreated
          ? `${res.error} A task was raised for the team to send it by hand.`
          : res.error,
      },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, channel: res.channel, to: res.to });
}
