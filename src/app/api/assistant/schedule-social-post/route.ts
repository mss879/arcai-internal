import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getAssistantProfile } from "@/lib/auth";
import { queueSocialPost } from "@/lib/social/queue";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Put a post the assistant lined up onto the publish queue (0118).
 *
 * Fires only when a person taps Schedule on the confirmation card — the same
 * shape as send-email and send-whatsapp. The model never reaches this route,
 * and a mission on a cron cannot either. queueSocialPost() owns every rule
 * (design chosen, client approved, accounts connected), so this and the
 * Studio's own button can never disagree; the publisher re-checks approval
 * again before anything actually goes out.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { postId?: unknown; accountIds?: unknown; scheduledFor?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const postId = String(body?.postId ?? "").trim();
  const accountIds = (Array.isArray(body?.accountIds) ? body.accountIds : [])
    .map((a) => String(a ?? "").trim())
    .filter(Boolean);
  const scheduledFor = String(body?.scheduledFor ?? "").trim();
  if (!postId || !accountIds.length || !scheduledFor) {
    return NextResponse.json(
      { ok: false, error: "Need the post, at least one account and a time." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const res = await queueSocialPost(supabase, {
    postId,
    accountIds,
    scheduledFor,
    createdBy: profile.id,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  }

  revalidatePath("/content");
  return NextResponse.json({ ok: true, queued: res.queued });
}
