import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ConversationChannel, Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Every conversation with a client, in one list.
 *
 * A client writes on WhatsApp, gets texted about their invoice, leaves a
 * comment on their portal and is emailed a quote — and until now those four
 * lived on four screens, none of which knew about the others. Nobody could
 * answer "what is going on with this client" without opening all four, and
 * nobody owned any of it, so a hand-off woke the whole team.
 *
 * This module normalises the four into one shape. It does NOT own any of the
 * underlying data: WhatsApp is still wa_contacts/wa_messages, SMS is still
 * the sms_messages log, the portal is still project_comments and
 * project_change_requests, and email is the 0115 email_messages log. What is
 * new is `conversation_meta` (0115), which carries the things a thread needs
 * that no channel provides: who owns it, its tags, notes and snooze.
 *
 * One asymmetry worth knowing before reading further: **only WhatsApp is a
 * two-way conversation.** SMS has no inbound webhook and no direction column,
 * so an SMS "thread" is the outbound log to one number. Email is outbound-only
 * today too, though email_messages was shaped so an inbound row can land in it
 * without a migration.
 */

/** How many WhatsApp threads the list considers. Matches /whatsapp. */
const WA_LIMIT = 200;
/** How far back the SMS log is grouped into threads. */
const SMS_DAYS = 30;
/** Threads per channel from the portal and email sides. */
const THREAD_LIMIT = 120;

export type InboxFilter = "all" | "mine" | "unassigned" | "attention" | "snoozed";

export type InboxThread = {
  /** `<channel>:<refId>` — stable, and what the URL carries. */
  key: string;
  channel: ConversationChannel;
  refId: string;
  title: string;
  /** The line under the title: a phone number, a project, an address. */
  subtitle: string | null;
  preview: string;
  lastAt: string | null;
  unread: number;
  /** Someone is waiting on us. */
  needsAttention: boolean;
  clientId: string | null;
  leadId: string | null;
  projectId: string | null;
  /** Where this conversation's record lives in the CRM. */
  href: string | null;
  assignedTo: string | null;
  tags: string[];
  notes: string | null;
  snoozedUntil: string | null;
  /** WhatsApp only: the agent is off for this thread. */
  aiPaused: boolean;
  /** WhatsApp only: they asked us to stop. */
  optedOut: boolean;
};

export type InboxMessage = {
  id: string;
  at: string;
  direction: "in" | "out";
  author: string;
  body: string;
  /** A change request renders as a card, not a bubble. */
  kind: "message" | "change_request";
  status: string | null;
  error: string | null;
  meta: Record<string, unknown> | null;
};

export type InboxThreadDetail = {
  thread: InboxThread;
  messages: InboxMessage[];
  /** False when the channel has no reply path (email is composed, not replied). */
  canReply: boolean;
  /** Shown above the composer, e.g. the 24h WhatsApp warning. */
  replyHint: string | null;
};

export function threadKey(channel: ConversationChannel, refId: string): string {
  return `${channel}:${refId}`;
}

/** Split a key back apart. Returns null for anything malformed. */
export function parseThreadKey(
  key: string,
): { channel: ConversationChannel; refId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const channel = key.slice(0, at);
  const refId = key.slice(at + 1);
  if (!refId) return null;
  if (
    channel !== "whatsapp" &&
    channel !== "sms" &&
    channel !== "portal" &&
    channel !== "email"
  ) {
    return null;
  }
  return { channel, refId };
}

type Meta = Database["public"]["Tables"]["conversation_meta"]["Row"];

/** conversation_meta for every thread on screen, keyed by `<channel>:<ref_id>`. */
async function loadMeta(db: DB): Promise<Map<string, Meta>> {
  const map = new Map<string, Meta>();
  try {
    const { data } = await db.from("conversation_meta").select("*");
    for (const row of data ?? []) map.set(threadKey(row.channel, row.ref_id), row);
  } catch {
    // 0115 not applied yet — every thread simply reads as unassigned.
  }
  return map;
}

/** Everything a channel knows about a thread. The rest comes from the meta row. */
type BaseThread = Omit<
  InboxThread,
  "assignedTo" | "tags" | "notes" | "snoozedUntil"
>;

/** Fold a thread's conversation_meta row into it. No row = unassigned. */
function withMeta(thread: BaseThread, meta: Meta | undefined): InboxThread {
  return {
    ...thread,
    assignedTo: meta?.assigned_to ?? null,
    tags: meta?.tags ?? [],
    notes: meta?.notes ?? null,
    snoozedUntil: meta?.snoozed_until ?? null,
  };
}

const iso = (d: Date) => d.toISOString();

/** A WhatsApp contact's display name, the same way /whatsapp picks it. */
function waName(c: {
  display_name: string | null;
  profile_name: string | null;
  wa_id: string;
}): string {
  return c.display_name || c.profile_name || c.wa_id;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export async function listInboxThreads(
  db: DB,
  opts: {
    filter?: InboxFilter;
    channel?: ConversationChannel | "all";
    /** Whose "mine" this is. */
    userId?: string | null;
    now?: Date;
  } = {},
): Promise<InboxThread[]> {
  const filter = opts.filter ?? "all";
  const channel = opts.channel ?? "all";
  const now = opts.now ?? new Date();
  const wants = (c: ConversationChannel) => channel === "all" || channel === c;

  const meta = await loadMeta(db);
  const threads: InboxThread[] = [];

  // --- WhatsApp: the only real two-way thread ---------------------------
  if (wants("whatsapp")) {
    const { data } = await db
      .from("wa_contacts")
      .select(
        "id, wa_id, display_name, profile_name, client_id, lead_id, unread, needs_attention, last_message_at, last_message_preview, last_direction, do_not_contact, agent_enabled",
      )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(WA_LIMIT);

    for (const c of data ?? []) {
      const key = threadKey("whatsapp", c.id);
      threads.push(
        withMeta(
          {
            key,
            channel: "whatsapp",
            refId: c.id,
            title: waName(c),
            subtitle: c.wa_id,
            preview: c.last_message_preview ?? "",
            lastAt: c.last_message_at,
            unread: c.unread ?? 0,
            needsAttention: (c.unread ?? 0) > 0 || Boolean(c.needs_attention),
            clientId: c.client_id,
            leadId: c.lead_id,
            projectId: null,
            href: c.client_id ? `/clients/${c.client_id}` : c.lead_id ? `/crm/lead/${c.lead_id}` : null,
            aiPaused: !c.agent_enabled,
            optedOut: Boolean(c.do_not_contact),
          },
          meta.get(key),
        ),
      );
    }
  }

  // --- SMS: an outbound log, grouped by number --------------------------
  if (wants("sms")) {
    const since = iso(new Date(now.getTime() - SMS_DAYS * 24 * 3600_000));
    const { data } = await db
      .from("sms_messages")
      .select(
        "id, to_number, message, client_id, client_name, kind, status, lead_id, project_id, created_at",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    const seen = new Set<string>();
    for (const m of data ?? []) {
      if (seen.has(m.to_number)) continue;
      seen.add(m.to_number);
      const key = threadKey("sms", m.to_number);
      threads.push(
        withMeta(
          {
            key,
            channel: "sms",
            refId: m.to_number,
            title: m.client_name?.trim() || m.to_number,
            subtitle: m.to_number,
            preview: m.message,
            lastAt: m.created_at,
            unread: 0,
            // Nothing arrives on SMS, so the only thing to act on is a text
            // that never made it.
            needsAttention: m.status === "failed",
            clientId: m.client_id,
            leadId: m.lead_id,
            projectId: m.project_id,
            href: m.client_id ? `/clients/${m.client_id}` : null,
            aiPaused: false,
            optedOut: false,
          },
          meta.get(key),
        ),
      );
      if (seen.size >= THREAD_LIMIT) break;
    }
  }

  // --- Portal: comments and change requests, per project ----------------
  if (wants("portal")) {
    const [comments, changes] = await Promise.all([
      db
        .from("project_comments")
        .select("id, project_id, author_type, author_name, body, created_at")
        .order("created_at", { ascending: false })
        .limit(400),
      db
        .from("project_change_requests")
        .select("id, project_id, body, status, client_name, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    type Acc = {
      projectId: string;
      lastAt: string;
      preview: string;
      fromClient: boolean;
      openChanges: number;
      clientName: string | null;
    };
    const byProject = new Map<string, Acc>();

    for (const c of comments.data ?? []) {
      const at = byProject.get(c.project_id);
      if (!at) {
        byProject.set(c.project_id, {
          projectId: c.project_id,
          lastAt: c.created_at,
          preview: c.body,
          fromClient: c.author_type === "client",
          openChanges: 0,
          clientName: c.author_type === "client" ? c.author_name : null,
        });
      }
    }
    for (const r of changes.data ?? []) {
      // "waiting on you" for a change request, the same predicate the project
      // page's ClientDeskCard uses.
      const open = r.status === "new" || r.status === "quoted";
      const at = byProject.get(r.project_id);
      if (!at) {
        byProject.set(r.project_id, {
          projectId: r.project_id,
          lastAt: r.created_at,
          preview: r.body,
          fromClient: true,
          openChanges: open ? 1 : 0,
          clientName: r.client_name,
        });
      } else {
        if (open) at.openChanges += 1;
        if (r.created_at > at.lastAt) {
          at.lastAt = r.created_at;
          at.preview = r.body;
          at.fromClient = true;
        }
      }
    }

    const ids = [...byProject.keys()];
    if (ids.length) {
      const { data: projects } = await db
        .from("projects")
        .select("id, name, client_id")
        .in("id", ids);
      const names = new Map(
        (projects ?? []).map((p) => [p.id, { name: p.name, clientId: p.client_id }]),
      );

      for (const acc of byProject.values()) {
        const project = names.get(acc.projectId);
        if (!project) continue; // deleted project — no thread to show
        const key = threadKey("portal", acc.projectId);
        threads.push(
          withMeta(
            {
              key,
              channel: "portal",
              refId: acc.projectId,
              title: acc.clientName?.trim() || project.name,
              subtitle: project.name,
              preview: acc.preview,
              lastAt: acc.lastAt,
              unread: 0,
              needsAttention: acc.openChanges > 0 || acc.fromClient,
              clientId: project.clientId,
              leadId: null,
              projectId: acc.projectId,
              href: `/projects/${acc.projectId}`,
              aiPaused: false,
              optedOut: false,
            },
            meta.get(key),
          ),
        );
      }
    }
  }

  // --- Email: the 0115 log, grouped by thread key -----------------------
  if (wants("email")) {
    try {
      const { data } = await db
        .from("email_messages")
        .select(
          "id, thread_key, subject, body_text, to_emails, status, kind, client_id, lead_id, project_id, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(400);

      const seen = new Set<string>();
      for (const m of data ?? []) {
        // A send with nothing to group on is its own thread.
        const ref = m.thread_key ?? `message:${m.id}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        const key = threadKey("email", ref);
        threads.push(
          withMeta(
            {
              key,
              channel: "email",
              refId: ref,
              title: m.to_emails[0] ?? "(no recipient)",
              subtitle: m.subject || null,
              preview: m.body_text ?? m.subject ?? "",
              lastAt: m.created_at,
              unread: 0,
              needsAttention:
                m.status === "failed" ||
                m.status === "bounced" ||
                m.status === "complained",
              clientId: m.client_id,
              leadId: m.lead_id,
              projectId: m.project_id,
              href: m.client_id
                ? `/clients/${m.client_id}`
                : m.lead_id
                  ? `/crm/lead/${m.lead_id}`
                  : null,
              aiPaused: false,
              optedOut: false,
            },
            meta.get(key),
          ),
        );
        if (seen.size >= THREAD_LIMIT) break;
      }
    } catch {
      // 0115 not applied yet — the other three channels still list.
    }
  }

  const nowIso = iso(now);
  const visible = threads.filter((t) => {
    // A snoozed thread is hidden everywhere except its own filter.
    const snoozed = Boolean(t.snoozedUntil && t.snoozedUntil > nowIso);
    if (filter === "snoozed") return snoozed;
    if (snoozed) return false;
    if (filter === "mine") return Boolean(opts.userId) && t.assignedTo === opts.userId;
    if (filter === "unassigned") return !t.assignedTo;
    if (filter === "attention") return t.needsAttention;
    return true;
  });

  return visible.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

// ---------------------------------------------------------------------------
// One thread
// ---------------------------------------------------------------------------

export async function loadInboxThread(
  db: DB,
  key: string,
): Promise<InboxThreadDetail | null> {
  const parsed = parseThreadKey(key);
  if (!parsed) return null;

  // The list is the one place a thread's shape is built, so the detail pane
  // reads it back rather than growing a second, drifting copy.
  const all = await listInboxThreads(db, { channel: parsed.channel, filter: "all" });
  const thread =
    all.find((t) => t.key === key) ??
    // A snoozed thread is still openable by link.
    (await listInboxThreads(db, { channel: parsed.channel, filter: "snoozed" })).find(
      (t) => t.key === key,
    );
  if (!thread) return null;

  const messages: InboxMessage[] = [];
  let canReply = false;
  let replyHint: string | null = null;

  if (parsed.channel === "whatsapp") {
    const { data } = await db
      .from("wa_messages")
      .select("id, direction, body, status, error, sent_by, message_type, meta, created_at")
      .eq("contact_id", parsed.refId)
      .order("created_at", { ascending: false })
      .limit(200);
    for (const m of (data ?? []).reverse()) {
      messages.push({
        id: m.id,
        at: m.created_at,
        direction: m.direction === "in" ? "in" : "out",
        author: m.direction === "in" ? thread.title : (m.sent_by ?? "team"),
        body: m.body,
        kind: "message",
        status: m.status,
        error: m.error,
        meta: m.meta,
      });
    }
    canReply = true;
    const { data: contact } = await db
      .from("wa_contacts")
      .select("last_inbound_at")
      .eq("id", parsed.refId)
      .maybeSingle();
    // Same rule as /whatsapp: no inbound in 24h and free text may be rejected.
    const last = contact?.last_inbound_at;
    if (!last || Date.now() - new Date(last).getTime() > 24 * 3600_000) {
      replyHint =
        "No reply from them in 24h — WhatsApp may reject free text. A template send still works.";
    }
    if (thread.optedOut) {
      canReply = false;
      replyHint = "They have opted out of WhatsApp messages.";
    }
  } else if (parsed.channel === "sms") {
    const { data } = await db
      .from("sms_messages")
      .select("id, message, status, error, kind, created_at")
      .eq("to_number", parsed.refId)
      .order("created_at", { ascending: false })
      .limit(200);
    for (const m of (data ?? []).reverse()) {
      messages.push({
        id: m.id,
        at: m.created_at,
        direction: "out",
        author: m.kind,
        body: m.message,
        kind: "message",
        status: m.status,
        error: m.error,
        meta: null,
      });
    }
    canReply = true;
    replyHint = "Texts are one-way — replies arrive on WhatsApp or by phone.";
  } else if (parsed.channel === "portal") {
    const [comments, changes] = await Promise.all([
      db
        .from("project_comments")
        .select("id, author_type, author_name, body, created_at")
        .eq("project_id", parsed.refId)
        .order("created_at", { ascending: true })
        .limit(200),
      db
        .from("project_change_requests")
        .select("id, body, status, client_name, quoted_amount, created_at")
        .eq("project_id", parsed.refId)
        .order("created_at", { ascending: true })
        .limit(50),
    ]);
    for (const c of comments.data ?? []) {
      messages.push({
        id: c.id,
        at: c.created_at,
        direction: c.author_type === "client" ? "in" : "out",
        author: c.author_name,
        body: c.body,
        kind: "message",
        status: null,
        error: null,
        meta: null,
      });
    }
    for (const r of changes.data ?? []) {
      messages.push({
        id: r.id,
        at: r.created_at,
        direction: "in",
        author: r.client_name ?? "Client",
        body: r.body,
        kind: "change_request",
        status: r.status,
        error: null,
        meta: { quoted_amount: r.quoted_amount },
      });
    }
    messages.sort((a, b) => a.at.localeCompare(b.at));
    canReply = true;
  } else {
    // Email. Every send that shares this thread key, oldest first.
    try {
      const isSingle = parsed.refId.startsWith("message:");
      const query = db
        .from("email_messages")
        .select(
          "id, subject, body_text, to_emails, status, error, actor, created_at, sent_at",
        )
        .order("created_at", { ascending: true })
        .limit(100);
      const { data } = isSingle
        ? await query.eq("id", parsed.refId.slice("message:".length))
        : await query.eq("thread_key", parsed.refId);
      for (const m of data ?? []) {
        messages.push({
          id: m.id,
          at: m.sent_at ?? m.created_at,
          direction: "out",
          author: m.actor,
          body: m.body_text ?? "",
          kind: "message",
          status: m.status,
          error: m.error,
          meta: { subject: m.subject, to: m.to_emails },
        });
      }
    } catch {
      // 0115 not applied yet.
    }
    canReply = false;
    replyHint = "Email replies land in the mailbox, not here — use Compose to write back.";
  }

  return { thread, messages, canReply, replyHint };
}
