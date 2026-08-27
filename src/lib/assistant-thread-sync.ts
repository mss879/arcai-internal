/**
 * Server sync for Arc Studio's conversations (0101).
 *
 * `assistant-threads.ts` keeps the localStorage cache; this module keeps that
 * cache honest against the `assistant_threads` / `assistant_messages` tables.
 * The division of labour is deliberate:
 *
 *   - The SERVER copy is authoritative. localStorage remains the instant
 *     first paint and the offline fallback — pruning the cache no longer
 *     loses anything, because the server holds the full copy.
 *   - Message ids are client-minted and append-only, so merging is a
 *     LOSSLESS UNION: take every message id either side knows, sorted by
 *     `at`. No clocks are compared for messages, only for thread titles.
 *   - Deletes are tombstones. A thread deleted on one device must not be
 *     resurrected by another device's stale cache, so the server keeps the
 *     id with `deleted_at` set and the merge drops it everywhere.
 *
 * Every network helper here fails SILENTLY (returning null/false) — offline
 * is cache mode, not an error state, mirroring the never-throw rule of the
 * localStorage store.
 *
 * Framework-free on purpose, like `assistant-threads.ts`: the routes import
 * the pack/unpack halves, the browser hook imports the fetch/push halves.
 */

import {
  sanitiseMessage,
  type AssistantMessage,
  type AssistantThread,
} from "@/lib/assistant-threads";

/** One thread row as the API speaks it. */
export type RemoteThreadMeta = {
  id: string;
  title: string;
  kind: "chat" | "briefing" | "mission";
  /** Epoch ms, converted from the row's timestamptz. */
  createdAt: number;
  updatedAt: number;
};

export type RemoteThread = RemoteThreadMeta & { messages: AssistantMessage[] };

/** What GET /api/assistant/threads returns. */
export type ThreadsIndex = {
  threads: RemoteThreadMeta[];
  /** Ids tombstoned in the last 30 days — the merge removes them locally. */
  deleted: string[];
};

// ---- pack / unpack (shared by routes and hook) ---------------------------

/** The message's UI payload, as stored in the `payload` jsonb column. */
type MessagePayload = Pick<
  AssistantMessage,
  "events" | "cards" | "artifacts" | "steps" | "error"
>;

/** Row shape for `assistant_messages` inserts — kept structural so the
 * framework-free module needs no supabase import. */
export type PackedMessage = {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  at: number;
  payload: Record<string, unknown>;
};

/** A message's serialised payload may not exceed this (64 KB). Payloads are
 * conveniences (cards, artifacts, the trail) — the words always survive. */
export const MAX_PAYLOAD_BYTES = 64_000;

export function packMessage(threadId: string, message: AssistantMessage): PackedMessage {
  const clean = sanitiseMessage(message);
  const payload: MessagePayload = {};
  if (clean.events?.length) payload.events = clean.events;
  if (clean.cards?.length) payload.cards = clean.cards;
  if (clean.artifacts?.length) payload.artifacts = clean.artifacts;
  if (clean.steps?.length) payload.steps = clean.steps;
  if (clean.error) payload.error = clean.error;

  let stored: Record<string, unknown> = payload as Record<string, unknown>;
  try {
    if (JSON.stringify(stored).length > MAX_PAYLOAD_BYTES) {
      // Shed the heavy halves, keep the error note — same order the
      // localStorage pruner sheds them.
      stored = clean.error ? { error: clean.error } : {};
    }
  } catch {
    stored = {};
  }

  return {
    id: clean.id,
    thread_id: threadId,
    role: clean.role,
    content: clean.content,
    at: clean.at,
    payload: stored,
  };
}

export function unpackMessage(row: {
  id: string;
  role: string;
  content: string;
  at: number;
  payload: unknown;
}): AssistantMessage {
  const payload = (row.payload ?? {}) as MessagePayload;
  const message: AssistantMessage = {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    content: row.content,
    at: Number(row.at) || 0,
  };
  if (payload.events?.length) message.events = payload.events;
  if (payload.cards?.length) message.cards = payload.cards;
  if (payload.artifacts?.length) message.artifacts = payload.artifacts;
  if (payload.steps?.length) message.steps = payload.steps;
  if (payload.error) message.error = payload.error;
  return message;
}

// ---- merge (pure) --------------------------------------------------------

/**
 * Merge the local cache with the server's copy.
 *
 * Per thread: messages are a union by id sorted by `at` (append-only ids
 * make this lossless), the newer `updatedAt` names the thread, and anything
 * in `deleted` is dropped whatever either side thinks. Threads only one
 * side knows survive as they are — a brand-new local thread has simply not
 * been pushed yet, and a server thread missing locally was pruned from the
 * cache or written by another device.
 */
export function mergeThreads(
  local: AssistantThread[],
  remote: RemoteThread[],
  deleted: string[],
): AssistantThread[] {
  const dead = new Set(deleted);
  const byId = new Map<string, AssistantThread>();

  for (const thread of local) {
    if (!dead.has(thread.id)) byId.set(thread.id, thread);
  }

  for (const incoming of remote) {
    if (dead.has(incoming.id)) continue;
    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, {
        id: incoming.id,
        title: incoming.title,
        createdAt: incoming.createdAt,
        updatedAt: incoming.updatedAt,
        messages: incoming.messages,
      });
      continue;
    }

    const seen = new Map<string, AssistantMessage>();
    for (const m of existing.messages) seen.set(m.id, m);
    for (const m of incoming.messages) {
      const local = seen.get(m.id);
      // Same id, richer copy wins: a cache stripped of payloads must not
      // overwrite the server's full message, and vice versa.
      if (!local || weight(m) >= weight(local)) seen.set(m.id, m);
    }
    const messages = [...seen.values()].sort((a, b) => a.at - b.at);

    const newerMeta =
      incoming.updatedAt >= existing.updatedAt ? incoming : existing;
    byId.set(incoming.id, {
      id: incoming.id,
      title: newerMeta.title || existing.title,
      createdAt: Math.min(existing.createdAt, incoming.createdAt),
      updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
      messages,
    });
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Roughly how much of the message survived pruning — richer wins the merge. */
function weight(message: AssistantMessage): number {
  return (
    (message.artifacts?.length ?? 0) * 4 +
    (message.cards?.length ?? 0) * 4 +
    (message.steps?.length ?? 0) +
    (message.events?.length ?? 0) +
    (message.content ? 1 : 0)
  );
}

// ---- network (browser side; silent failure) ------------------------------

async function silently<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null; // Offline, signed out, or the routes not deployed yet.
  }
}

export async function fetchThreadsIndex(): Promise<ThreadsIndex | null> {
  return silently(async () => {
    const res = await fetch("/api/assistant/threads", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as ThreadsIndex;
  });
}

export async function fetchRemoteThread(id: string): Promise<RemoteThread | null> {
  return silently(async () => {
    const res = await fetch(`/api/assistant/threads/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as RemoteThread;
  });
}

export async function pushThread(thread: AssistantThread): Promise<boolean> {
  const ok = await silently(async () => {
    const res = await fetch(`/api/assistant/threads/${encodeURIComponent(thread.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messages: thread.messages.map((m) => packMessage(thread.id, m)),
      }),
    });
    return res.ok;
  });
  return ok === true;
}

export async function deleteThreadRemote(id: string): Promise<boolean> {
  const ok = await silently(async () => {
    const res = await fetch(`/api/assistant/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return res.ok;
  });
  return ok === true;
}
