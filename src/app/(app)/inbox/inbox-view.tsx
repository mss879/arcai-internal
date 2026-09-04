"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  BotOff,
  Clock,
  Inbox as InboxIcon,
  Mail,
  MessageCircle,
  MessageSquareText,
  MonitorSmartphone,
  Send,
  Tag,
  User,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import type { ConversationChannel } from "@/lib/database.types";
import type { InboxFilter, InboxThread, InboxThreadDetail } from "@/lib/inbox";
import { cn } from "@/lib/utils";

import {
  assignThread,
  markThreadRead,
  replyToThread,
  setThreadNotes,
  setThreadTags,
  snoozeThread,
} from "./actions";
import { toggleContactAgentAction } from "@/app/(app)/whatsapp/actions";

type TeamMember = { id: string; full_name: string | null; avatar_url: string | null };

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
  { key: "attention", label: "Needs a reply" },
  { key: "snoozed", label: "Snoozed" },
];

const CHANNEL_META: Record<
  ConversationChannel,
  { label: string; icon: typeof MessageCircle; tone: string }
> = {
  whatsapp: { label: "WhatsApp", icon: MessageCircle, tone: "text-emerald-600" },
  sms: { label: "SMS", icon: MessageSquareText, tone: "text-sky-600" },
  portal: { label: "Portal", icon: MonitorSmartphone, tone: "text-violet-600" },
  email: { label: "Email", icon: Mail, tone: "text-amber-600" },
};

/** now / 5m / 3h / 2d / a date, the same ladder the WhatsApp screen uses. */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(iso).toLocaleDateString();
}

function memberName(team: TeamMember[], id: string | null): string | null {
  if (!id) return null;
  return team.find((m) => m.id === id)?.full_name ?? "Someone";
}

export function InboxView({
  threads,
  detail,
  filter,
  channel,
  team,
  me,
}: {
  threads: InboxThread[];
  detail: InboxThreadDetail | null;
  filter: InboxFilter;
  channel: ConversationChannel | "all";
  team: TeamMember[];
  me: string;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  useRealtimeSyncTables([
    "wa_contacts",
    "wa_messages",
    "sms_messages",
    "project_comments",
    "project_change_requests",
    "email_messages",
    "conversation_meta",
  ]);

  const selected = detail?.thread ?? null;

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) =>
      [t.title, t.subtitle, t.preview].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [threads, query]);

  /** Filters and the open thread live in the URL, so a link opens the thread. */
  const go = React.useCallback(
    (next: { filter?: InboxFilter; channel?: string; thread?: string }) => {
      const params = new URLSearchParams();
      const f = next.filter ?? filter;
      const c = next.channel ?? channel;
      if (f !== "all") params.set("filter", f);
      if (c !== "all") params.set("channel", c);
      const thread = next.thread ?? selected?.key;
      if (thread) params.set("thread", thread);
      const qs = params.toString();
      router.push(qs ? `/inbox?${qs}` : "/inbox");
    },
    [router, filter, channel, selected?.key],
  );

  // Opening a thread marks it read — including WhatsApp's own unread counter,
  // so /whatsapp and /inbox never disagree about what has been seen.
  React.useEffect(() => {
    if (selected && (selected.unread > 0 || selected.needsAttention)) {
      void markThreadRead(selected.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [detail?.messages.length, selected?.key]);

  async function handleSend() {
    if (!selected || !draft.trim() || sending) return;
    const text = draft.trim();
    setSending(true);
    setDraft("");
    // A team WhatsApp reply pauses the agent for that thread; say so once
    // rather than letting the toggle silently flip under them.
    const willPauseAi = selected.channel === "whatsapp" && !selected.aiPaused;
    const res = await replyToThread(selected.key, text);
    setSending(false);
    if (res.ok) {
      if (willPauseAi) toast.success("Sent — AI paused, you're handling this one.");
      router.refresh();
    } else {
      setDraft(text);
      toast.error(res.error);
    }
  }

  const unassignedCount = threads.filter((t) => !t.assignedTo).length;
  const attentionCount = threads.filter((t) => t.needsAttention).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inbox"
        description="Every conversation with a client — WhatsApp, texts, portal messages and email — in one place."
        actions={
          <div className="flex items-center gap-2">
            {attentionCount > 0 && (
              <Badge className="bg-amber-50 text-amber-700 ring-amber-200" dot="bg-amber-500">
                {attentionCount} waiting
              </Badge>
            )}
            {unassignedCount > 0 && (
              <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
                {unassignedCount} unassigned
              </Badge>
            )}
          </div>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => go({ filter: f.key, thread: "" })}
            className={cn(
              "rounded-xl px-3 py-1.5 text-sm font-medium transition",
              filter === f.key
                ? "bg-primary-600 text-white shadow-sm"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />
        <button
          onClick={() => go({ channel: "all", thread: "" })}
          className={cn(
            "rounded-xl px-3 py-1.5 text-sm font-medium transition",
            channel === "all"
              ? "bg-slate-900 text-white"
              : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
          )}
        >
          Every channel
        </button>
        {(Object.keys(CHANNEL_META) as ConversationChannel[]).map((c) => {
          const Icon = CHANNEL_META[c].icon;
          return (
            <button
              key={c}
              onClick={() => go({ channel: c, thread: "" })}
              className={cn(
                "flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium transition",
                channel === c
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {CHANNEL_META[c].label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr] xl:grid-cols-[300px_1fr_280px]">
        {/* --- The list ------------------------------------------------ */}
        <div className="flex h-[72vh] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                Nothing here.
              </p>
            ) : (
              visible.map((t) => {
                const Icon = CHANNEL_META[t.channel].icon;
                const owner = memberName(team, t.assignedTo);
                return (
                  <button
                    key={t.key}
                    onClick={() => go({ thread: t.key })}
                    className={cn(
                      "flex w-full items-start gap-3 border-b border-slate-50 px-3 py-3 text-left transition hover:bg-slate-50",
                      selected?.key === t.key && "bg-primary-50/60",
                    )}
                  >
                    <Icon
                      className={cn("mt-0.5 h-4 w-4 shrink-0", CHANNEL_META[t.channel].tone)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-900">
                          {t.title}
                        </span>
                        {t.unread > 0 && (
                          <span className="grid h-4.5 min-w-4.5 place-items-center rounded-full bg-primary-600 px-1 text-[10px] font-semibold text-white">
                            {t.unread}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                          {timeAgo(t.lastAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-1 block text-xs text-slate-500">
                        {t.preview || "—"}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        {owner ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                            <User className="h-2.5 w-2.5" />
                            {owner}
                          </span>
                        ) : (
                          <span className="text-[10px] text-amber-600">Unassigned</span>
                        )}
                        {t.aiPaused && t.channel === "whatsapp" && (
                          <BotOff className="h-3 w-3 text-slate-400" />
                        )}
                        {t.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* --- The conversation ---------------------------------------- */}
        {detail && selected ? (
          <div className="flex h-[72vh] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">
                  {selected.title}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {CHANNEL_META[selected.channel].label}
                  {selected.subtitle ? ` · ${selected.subtitle}` : ""}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {selected.channel === "whatsapp" && (
                  <Button
                    size="sm"
                    variant={selected.aiPaused ? "outline" : "secondary"}
                    onClick={async () => {
                      const res = await toggleContactAgentAction(
                        selected.refId,
                        selected.aiPaused,
                      );
                      if (res.ok) router.refresh();
                      else toast.error(res.error);
                    }}
                  >
                    {selected.aiPaused ? (
                      <>
                        <BotOff className="h-3.5 w-3.5" /> AI off
                      </>
                    ) : (
                      <>
                        <Bot className="h-3.5 w-3.5" /> AI on
                      </>
                    )}
                  </Button>
                )}
                {selected.href && (
                  <Link href={selected.href}>
                    <Button size="sm" variant="outline">
                      Open record <ArrowUpRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                )}
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50/60 p-4">
              {detail.messages.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">
                  Nothing said yet.
                </p>
              ) : (
                detail.messages.map((m) => (
                  <div
                    key={`${m.kind}-${m.id}`}
                    className={cn(
                      "max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm",
                      m.kind === "change_request"
                        ? "border border-amber-200 bg-amber-50 text-amber-900"
                        : m.direction === "in"
                          ? "bg-white text-slate-800"
                          : "ml-auto bg-primary-600 text-white",
                    )}
                  >
                    {m.kind === "change_request" && (
                      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
                        <AlertTriangle className="h-3 w-3" /> Change request · {m.status}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <p
                      className={cn(
                        "mt-1 text-[10px]",
                        m.direction === "out" && m.kind === "message"
                          ? "text-white/70"
                          : "text-slate-400",
                      )}
                    >
                      {m.author} · {timeAgo(m.at)}
                      {m.error ? ` · ${m.error}` : ""}
                    </p>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-slate-100 p-3">
              {detail.replyHint && (
                <p className="mb-2 flex items-center gap-1.5 text-[11px] text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {detail.replyHint}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={
                    detail.canReply ? "Write a reply…" : "Replies aren't sent from here"
                  }
                  disabled={!detail.canReply || sending}
                />
                <Button
                  onClick={handleSend}
                  disabled={!detail.canReply || sending || !draft.trim()}
                  loading={sending}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<InboxIcon className="h-6 w-6" />}
            title="Select a conversation"
            description="Everything a client has said to us, whichever way they said it."
            className="h-[72vh]"
          />
        )}

        {/* --- The rail ------------------------------------------------- */}
        {selected && (
          <ThreadRail key={selected.key} thread={selected} team={team} me={me} />
        )}
      </div>
    </div>
  );
}

/**
 * Ownership, tags, a note and a snooze. Everything here writes to
 * conversation_meta — never to the channel's own tables, which belong to the
 * channel.
 */
function ThreadRail({
  thread,
  team,
  me,
}: {
  thread: InboxThread;
  team: TeamMember[];
  me: string;
}) {
  const router = useRouter();
  const [notes, setNotes] = React.useState(thread.notes ?? "");
  const [tag, setTag] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.ok) router.refresh();
    else toast.error(res.error ?? "That didn't work.");
  }

  const snoozeFor = (hours: number) =>
    run(() =>
      snoozeThread(thread.key, new Date(Date.now() + hours * 3600_000).toISOString()),
    );

  return (
    <div className="hidden h-[72vh] flex-col gap-4 overflow-y-auto rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm xl:flex">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Owner
        </p>
        <div className="space-y-1">
          <button
            onClick={() => run(() => assignThread(thread.key, me))}
            disabled={busy}
            className="w-full rounded-lg bg-primary-50 px-3 py-1.5 text-left text-sm font-medium text-primary-700 hover:bg-primary-100"
          >
            Take it
          </button>
          <select
            value={thread.assignedTo ?? ""}
            disabled={busy}
            onChange={(e) => run(() => assignThread(thread.key, e.target.value || null))}
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-700"
          >
            <option value="">Unassigned</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name ?? "Someone"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Tag className="h-3 w-3" /> Tags
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {thread.tags.length === 0 && (
            <span className="text-xs text-slate-400">None yet</span>
          )}
          {thread.tags.map((t) => (
            <button
              key={t}
              disabled={busy}
              onClick={() =>
                run(() =>
                  setThreadTags(
                    thread.key,
                    thread.tags.filter((x) => x !== t),
                  ),
                )
              }
              className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-100"
              title="Remove"
            >
              {t} ×
            </button>
          ))}
        </div>
        <Input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tag.trim()) {
              e.preventDefault();
              const next = [...thread.tags, tag.trim()];
              setTag("");
              void run(() => setThreadTags(thread.key, next));
            }
          }}
          placeholder="Add a tag"
        />
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Note for the team
        </p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if ((thread.notes ?? "") !== notes) {
              void run(() => setThreadNotes(thread.key, notes));
            }
          }}
          rows={4}
          className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm text-slate-700"
          placeholder="Context the next person needs"
        />
      </div>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Clock className="h-3 w-3" /> Snooze
        </p>
        {thread.snoozedUntil ? (
          <button
            disabled={busy}
            onClick={() => run(() => snoozeThread(thread.key, null))}
            className="w-full rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200"
          >
            Snoozed until {new Date(thread.snoozedUntil).toLocaleString()} — wake it
          </button>
        ) : (
          <div className="flex gap-1.5">
            {[
              { label: "3h", hours: 3 },
              { label: "Tomorrow", hours: 24 },
              { label: "A week", hours: 24 * 7 },
            ].map((o) => (
              <button
                key={o.label}
                disabled={busy}
                onClick={() => snoozeFor(o.hours)}
                className="flex-1 rounded-lg bg-slate-100 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-200"
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
