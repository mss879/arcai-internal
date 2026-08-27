/**
 * The conversation index — what the rail needs, and what has been deleted.
 *
 * Arc Studio paints from its localStorage cache first and then reconciles
 * against this route, so the answer is deliberately thin: thread metadata,
 * never message bodies (those come one thread at a time from `[id]`).
 *
 * `deleted` matters as much as `threads`. A thread removed on the phone must
 * not be resurrected by the laptop's stale cache, so deletes are tombstones
 * here and the client's merge drops those ids on sight.
 *
 * Everything runs on the caller's own RLS client, so a member can only ever
 * see their own transcripts — no service-role key anywhere near this path.
 */

import { NextResponse } from "next/server";

import type { ThreadsIndex } from "@/lib/assistant-thread-sync";
import { getAssistantProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** How far back tombstones are reported. Older deletes are assumed settled
 * on every device — keeping them forever would grow the index without end. */
const TOMBSTONE_DAYS = 30;

/** Newest threads whose metadata the rail gets in one go. */
const INDEX_LIMIT = 100;

export async function GET() {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const since = new Date(Date.now() - TOMBSTONE_DAYS * 86_400_000).toISOString();

  const [live, dead] = await Promise.all([
    supabase
      .from("assistant_threads")
      .select("id, title, kind, created_at, updated_at")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(INDEX_LIMIT),
    supabase
      .from("assistant_threads")
      .select("id")
      .not("deleted_at", "is", null)
      .gte("deleted_at", since),
  ]);

  if (live.error) {
    return NextResponse.json({ error: live.error.message }, { status: 500 });
  }

  const body: ThreadsIndex = {
    threads: (live.data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    })),
    deleted: (dead.data ?? []).map((row) => row.id),
  };

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
