/**
 * One conversation: read it, save it, tombstone it.
 *
 * The client owns the ids (`thread-…`, `m-…`) and they are append-only, which
 * is what lets PUT be a plain upsert of whatever the browser currently holds
 * rather than a diff: re-sending a message that already exists is a no-op on
 * the same primary key, and two devices that both push converge on the union.
 *
 * Three limits are enforced here rather than trusted from the client, because
 * a browser with a corrupted cache should not be able to grow the table
 * without bound: messages per thread, payload bytes per message, and threads
 * per member. All run on the caller's RLS client — a member touches only
 * their own rows.
 */

import { NextResponse } from "next/server";

import {
  MAX_PAYLOAD_BYTES,
  unpackMessage,
  type RemoteThread,
} from "@/lib/assistant-thread-sync";
import { MAX_MESSAGES_PER_THREAD } from "@/lib/assistant-threads";
import { getAssistantProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Server-side ceiling on stored conversations per member. The rail shows far
 * fewer; this is the backstop that keeps a runaway client bounded. */
const MAX_THREADS_PER_USER = 100;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const supabase = await createClient();

  const { data: thread, error } = await supabase
    .from("assistant_threads")
    .select("id, title, kind, created_at, updated_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: messages } = await supabase
    .from("assistant_messages")
    .select("id, role, content, at, payload")
    .eq("thread_id", id)
    .order("at", { ascending: true })
    .limit(MAX_MESSAGES_PER_THREAD);

  const body: RemoteThread = {
    id: thread.id,
    title: thread.title,
    kind: thread.kind,
    createdAt: new Date(thread.created_at).getTime(),
    updatedAt: new Date(thread.updated_at).getTime(),
    messages: (messages ?? []).map(unpackMessage),
  };

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request, { params }: Params) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: {
    title?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    messages?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const supabase = await createClient();

  // A tombstoned thread stays dead. Without this a device that never learned
  // about the delete would push its cache back and undo it.
  const { data: existing } = await supabase
    .from("assistant_threads")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (existing?.deleted_at) {
    return NextResponse.json({ ok: true, ignored: "deleted" });
  }

  const createdAt = Number(body.createdAt);
  const updatedAt = Number(body.updatedAt);
  const { error: threadError } = await supabase.from("assistant_threads").upsert(
    {
      id,
      user_id: profile.id,
      title: String(body.title ?? "New chat").slice(0, 120),
      ...(Number.isFinite(createdAt)
        ? { created_at: new Date(createdAt).toISOString() }
        : {}),
      ...(Number.isFinite(updatedAt)
        ? { updated_at: new Date(updatedAt).toISOString() }
        : {}),
    },
    { onConflict: "id" },
  );
  if (threadError) {
    return NextResponse.json({ error: threadError.message }, { status: 500 });
  }

  // Only the newest window is stored, matching the client's own budget: an
  // old turn that has already fallen out of the cache is not resurrected.
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const rows = incoming
    .slice(-MAX_MESSAGES_PER_THREAD)
    .map((raw) => {
      const m = raw as Record<string, unknown>;
      const at = Number(m.at);
      if (!m.id || !Number.isFinite(at)) return null;
      let payload = (m.payload ?? {}) as Record<string, unknown>;
      try {
        if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) payload = {};
      } catch {
        payload = {};
      }
      return {
        id: String(m.id),
        thread_id: id,
        user_id: profile.id,
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: String(m.content ?? ""),
        at,
        payload,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length) {
    const { error: messageError } = await supabase
      .from("assistant_messages")
      .upsert(rows, { onConflict: "id" });
    if (messageError) {
      return NextResponse.json({ error: messageError.message }, { status: 500 });
    }
  }

  await pruneThreads(supabase, profile.id);

  return NextResponse.json({ ok: true, stored: rows.length });
}

export async function DELETE(_request: Request, { params }: Params) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const supabase = await createClient();

  // Tombstone, never a hard delete: the id has to stay so other devices can
  // learn the thread is gone. The janitor purges these later.
  const { error } = await supabase
    .from("assistant_threads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

/** Keep only the newest {@link MAX_THREADS_PER_USER} live threads. */
async function pruneThreads(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<void> {
  const { data } = await supabase
    .from("assistant_threads")
    .select("id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .range(MAX_THREADS_PER_USER, MAX_THREADS_PER_USER + 50);
  const stale = (data ?? []).map((row) => row.id);
  if (stale.length) {
    // Hard-deleted, not tombstoned: these fell off the end of the member's
    // own history rather than being deleted on purpose, so no other device
    // needs to be told about them.
    await supabase.from("assistant_threads").delete().in("id", stale);
  }
}
