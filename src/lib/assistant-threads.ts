/**
 * Conversation history for Arc Studio — a localStorage-backed thread store.
 *
 * The assistant used to forget everything the moment you closed the panel.
 * A full-screen workspace with a history rail needs somewhere to keep past
 * conversations, and "somewhere" is deliberately the browser: there is no
 * table, no migration and no server round-trip, because a transcript is a
 * personal scratchpad, not workspace data other people need to see.
 *
 * Framework-free and server-safe on purpose (no React, no "server-only"),
 * exactly like `assistant-cards.ts` and `assistant-artifacts.ts`, so the
 * types can be shared by anything that touches a transcript.
 *
 * Two rules drive the whole file:
 *   1. It must never throw at the caller. Private browsing throws on write,
 *      a half-written value throws on parse, and neither is a reason for the
 *      assistant to stop working — every access is wrapped and degrades to
 *      "no history" instead of a crash.
 *   2. It must never outgrow the quota. Threads carry proposal content and
 *      invoice payloads, so `pruneThreads()` enforces a hard budget before
 *      every write, dropping the oldest material first.
 */

import type { Artifact } from "@/lib/assistant-artifacts";
import type { AssistantCard } from "@/lib/assistant-cards";
import type { AssistantEvent, ToolStep } from "@/lib/assistant-stream";

/** One turn in a conversation. */
export type AssistantMessage = {
  /** Stable React key; survives persistence. */
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Epoch ms. */
  at: number;
  events?: AssistantEvent[];
  cards?: AssistantCard[];
  /** Artifacts produced by this turn, in arrival order. */
  artifacts?: Artifact[];
  /** The turn's tool steps, kept for the collapsed trail on completed turns. */
  steps?: ToolStep[];
  /** Set when this specific turn failed; the bubble renders it in rose. */
  error?: string;
};

/** A saved conversation. */
export type AssistantThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AssistantMessage[];
};

/**
 * Convenience alias. The store speaks `AssistantThread` everywhere; `Thread`
 * exists so call sites that already read as "threads" stay short.
 */
export type Thread = AssistantThread;

/** What the history rail renders — a thread without its payload weight. */
export type ThreadSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  artifactCount: number;
  /** Last message content, trimmed to 90 chars. */
  preview: string;
};

export const THREADS_KEY = "arc-studio-threads";
export const ACTIVE_THREAD_KEY = "arc-studio-thread";

/** Same-tab change notification: `storage` only fires in *other* tabs. */
const THREADS_EVENT = "arc-studio-threads-changed";

/** Nothing older than this many threads is kept. */
export const MAX_THREADS = 40;
/** Per thread; the oldest messages fall off first. */
export const MAX_MESSAGES_PER_THREAD = 60;
/** Serialised budget. localStorage is ~5 MB per origin and we share it. */
export const MAX_BYTES = 1_000_000;
/** Preview text length in the rail. */
const PREVIEW_CHARS = 90;
/** Derived titles stay short enough to fit a 264px rail. */
const TITLE_CHARS = 60;

export const NEW_THREAD_TITLE = "New chat";

// ---- ids -----------------------------------------------------------------

let seq = 0;

/**
 * Cheap monotonic id. `nanoid` is a dependency but overkill for keys that
 * never leave the browser, and this keeps the module dependency-free.
 */
export function assistantId(prefix: string): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${seq.toString(36)}-${Date.now().toString(36)}-${rand}`;
}

// ---- construction --------------------------------------------------------

/** A fresh, empty thread, already timestamped. */
export function newThread(): AssistantThread {
  const now = Date.now();
  return {
    id: assistantId("thread"),
    title: NEW_THREAD_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/**
 * A short human title from the first thing the user said. Collapses
 * whitespace, drops a leading slash-command, and ellipsises past 60 chars.
 */
export function autoTitle(firstUserMessage: string): string {
  const flat = firstUserMessage
    .replace(/^\/\S+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return NEW_THREAD_TITLE;
  if (flat.length <= TITLE_CHARS) return flat;
  // Prefer a word boundary so the title doesn't cut mid-word.
  const cut = flat.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The thread's title, derived from its first user message. */
export function deriveThreadTitle(thread: AssistantThread): string {
  const first = thread.messages.find((m) => m.role === "user");
  return first ? autoTitle(first.content) : NEW_THREAD_TITLE;
}

/** Collapse a thread to what the rail needs. */
export function summarise(thread: AssistantThread): ThreadSummary {
  const ids = new Set<string>();
  for (const message of thread.messages) {
    for (const artifact of message.artifacts ?? []) ids.add(artifact.id);
  }
  const last = thread.messages[thread.messages.length - 1];
  const preview = (last?.content ?? "").replace(/\s+/g, " ").trim();
  return {
    id: thread.id,
    title: thread.title || deriveThreadTitle(thread),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: thread.messages.length,
    artifactCount: ids.size,
    preview:
      preview.length > PREVIEW_CHARS
        ? `${preview.slice(0, PREVIEW_CHARS).trimEnd()}…`
        : preview,
  };
}

/** Case-insensitive match on the title and every message body. */
export function matchesQuery(thread: AssistantThread, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (thread.title.toLowerCase().includes(q)) return true;
  return thread.messages.some((m) => m.content.toLowerCase().includes(q));
}

// ---- pure array helpers --------------------------------------------------

/** Newest first — the order the rail renders. */
export function sortThreads(threads: AssistantThread[]): AssistantThread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Replace a thread by id, or prepend it when it is new. Never mutates. */
export function upsertThread(
  threads: AssistantThread[],
  thread: AssistantThread,
): AssistantThread[] {
  const index = threads.findIndex((t) => t.id === thread.id);
  if (index === -1) return sortThreads([thread, ...threads]);
  const next = threads.slice();
  next[index] = thread;
  return sortThreads(next);
}

/** Rename one thread. Blank titles fall back to the derived one. */
export function renameThread(
  threads: AssistantThread[],
  id: string,
  title: string,
): AssistantThread[] {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 80);
  return threads.map((t) =>
    t.id === id
      ? { ...t, title: clean || deriveThreadTitle(t), updatedAt: t.updatedAt }
      : t,
  );
}

/** Drop one thread. */
export function deleteThread(
  threads: AssistantThread[],
  id: string,
): AssistantThread[] {
  return threads.filter((t) => t.id !== id);
}

/** Append a message and bump `updatedAt` (and the title, on the first turn). */
export function appendMessage(
  thread: AssistantThread,
  message: AssistantMessage,
): AssistantThread {
  const messages = [...thread.messages, message];
  const next: AssistantThread = {
    ...thread,
    messages,
    updatedAt: Math.max(message.at, thread.updatedAt),
  };
  if (!next.title || next.title === NEW_THREAD_TITLE) {
    next.title = deriveThreadTitle(next);
  }
  return next;
}

// ---- budget --------------------------------------------------------------

function sanitiseMessage(message: AssistantMessage): AssistantMessage {
  // A step still "running" belongs to a turn in flight; persisting it would
  // restore a conversation that looks permanently stuck mid-tool.
  const steps = (message.steps ?? []).filter((s) => s.state !== "running");
  const next: AssistantMessage = { ...message };
  if (steps.length) next.steps = steps;
  else delete next.steps;
  return next;
}

function trimThread(thread: AssistantThread): AssistantThread {
  const messages = thread.messages
    .slice(-MAX_MESSAGES_PER_THREAD)
    .map(sanitiseMessage);
  return { ...thread, messages };
}

/** Everything heavy: artifact documents, card payloads, tool steps. */
function stripPayloads(thread: AssistantThread): AssistantThread {
  return {
    ...thread,
    messages: thread.messages.map((message) => {
      const lean: AssistantMessage = { ...message };
      delete lean.artifacts;
      delete lean.cards;
      delete lean.steps;
      return lean;
    }),
  };
}

function hasPayload(thread: AssistantThread): boolean {
  return thread.messages.some(
    (m) => (m.artifacts?.length ?? 0) > 0 || (m.cards?.length ?? 0) > 0 || (m.steps?.length ?? 0) > 0,
  );
}

function serialisedSize(threads: AssistantThread[]): number {
  try {
    return JSON.stringify(threads).length;
  } catch {
    // Circular or otherwise unserialisable — treat as over budget so the
    // caller sheds material rather than throwing on write.
    return MAX_BYTES + 1;
  }
}

/**
 * Enforce the storage budget: at most {@link MAX_THREADS} threads, each with
 * at most {@link MAX_MESSAGES_PER_THREAD} messages and roughly
 * {@link MAX_BYTES} serialised in total. Oldest material is shed first —
 * first the heavy artifact/card payloads of old threads, then whole threads,
 * and only as a last resort the messages of the single surviving thread.
 */
export function pruneThreads(threads: AssistantThread[]): AssistantThread[] {
  let kept = sortThreads(threads).slice(0, MAX_THREADS).map(trimThread);

  // Bounded loop: every iteration strictly removes material.
  const maxPasses = MAX_THREADS * 2 + MAX_MESSAGES_PER_THREAD;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (serialisedSize(kept) <= MAX_BYTES) break;

    // Oldest first (the array is newest-first, so walk it backwards).
    let stripped = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (hasPayload(kept[i])) {
        stripped = i;
        break;
      }
    }
    if (stripped !== -1) {
      kept = kept.map((t, i) => (i === stripped ? stripPayloads(t) : t));
      continue;
    }

    if (kept.length > 1) {
      kept = kept.slice(0, kept.length - 1);
      continue;
    }

    const only = kept[0];
    if (only && only.messages.length > 1) {
      kept = [
        { ...only, messages: only.messages.slice(Math.ceil(only.messages.length / 2)) },
      ];
      continue;
    }

    // A single message larger than the whole budget. Keep it; the write may
    // fail and that failure is already swallowed.
    break;
  }

  return kept;
}

// ---- storage -------------------------------------------------------------

/**
 * The one place that touches `localStorage`. Returns null during SSR, in a
 * sandboxed frame, and in private modes where merely reading throws.
 */
function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const store = window.localStorage;
    // Touch it: Safari's private mode throws here, not on access.
    store.getItem(THREADS_KEY);
    return store;
  } catch {
    return null;
  }
}

function isMessage(value: unknown): value is AssistantMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<AssistantMessage>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string" &&
    typeof m.at === "number"
  );
}

function isThread(value: unknown): value is AssistantThread {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<AssistantThread>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    typeof t.createdAt === "number" &&
    typeof t.updatedAt === "number" &&
    Array.isArray(t.messages) &&
    t.messages.every(isMessage)
  );
}

function notify(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(THREADS_EVENT));
  } catch {
    // CustomEvent is universally available; a failure here is not fatal.
  }
}

/**
 * Every persisted thread, newest first. Corrupt, foreign or half-written
 * values are discarded rather than surfaced — an empty history is a far
 * better outcome than a broken assistant.
 */
export function loadThreads(): AssistantThread[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(THREADS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortThreads(parsed.filter(isThread));
  } catch {
    return [];
  }
}

/**
 * Persist threads, pruned to the budget. Silent on failure (quota, private
 * mode, disabled storage) — the in-memory conversation keeps working.
 */
export function saveThreads(threads: AssistantThread[]): void {
  const store = storage();
  if (!store) return;
  const pruned = pruneThreads(threads);
  try {
    store.setItem(THREADS_KEY, JSON.stringify(pruned));
    notify();
  } catch {
    // Quota, most likely. Try once more with far less material rather than
    // leaving the previous (now stale) value in place.
    try {
      const lean = pruned.slice(0, 5).map(stripPayloads);
      store.setItem(THREADS_KEY, JSON.stringify(lean));
      notify();
    } catch {
      // Give up quietly.
    }
  }
}

/** Summaries of everything on disk, newest first. */
export function listThreads(): ThreadSummary[] {
  return loadThreads().map(summarise);
}

/** Read one thread back by id. */
export function loadThread(id: string): AssistantThread | null {
  return loadThreads().find((t) => t.id === id) ?? null;
}

/** Rename a persisted thread and return the new list. */
export function renameStoredThread(id: string, title: string): AssistantThread[] {
  const next = renameThread(loadThreads(), id, title);
  saveThreads(next);
  return next;
}

/** Delete a persisted thread and return the new list. */
export function deleteStoredThread(id: string): AssistantThread[] {
  const next = deleteThread(loadThreads(), id);
  saveThreads(next);
  return next;
}

/** Wipe all history, including the active-thread pointer. */
export function clearThreads(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(THREADS_KEY);
    store.removeItem(ACTIVE_THREAD_KEY);
    notify();
  } catch {
    // Nothing to do; the caller cannot act on this either.
  }
}

/** The thread the user was last in, if it is still on disk. */
export function loadActiveThreadId(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(ACTIVE_THREAD_KEY);
  } catch {
    return null;
  }
}

/** Remember the active thread across reloads. */
export function saveActiveThreadId(id: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(ACTIVE_THREAD_KEY, id);
  } catch {
    // Silent by design.
  }
}

/**
 * Watch for history changes. Fires for writes from other tabs (the native
 * `storage` event) *and* from this one (a custom event, because `storage`
 * deliberately does not fire in the tab that wrote it) — which is what keeps
 * two mounted surfaces, e.g. the dock and the workspace, in agreement.
 *
 * @returns an unsubscribe function; safe to call during SSR (it is a no-op).
 */
export function subscribeThreads(
  callback: (threads: AssistantThread[]) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    // `key === null` means the whole store was cleared.
    if (event.key !== null && event.key !== THREADS_KEY) return;
    callback(loadThreads());
  };
  const onLocal = () => callback(loadThreads());
  window.addEventListener("storage", onStorage);
  window.addEventListener(THREADS_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(THREADS_EVENT, onLocal);
  };
}
