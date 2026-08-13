"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  Bot,
  BotOff,
  CalendarClock,
  Check,
  CheckCheck,
  Handshake,
  Inbox,
  KanbanSquare,
  Megaphone,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Search,
  Send,
  Settings2,
  Snowflake,
  Trash2,
  UserPlus,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { uploadFile } from "@/lib/upload";
import { WA_LANGUAGE_LABELS } from "@/lib/wa-lang";
import { WA_TOOL_CATALOG } from "@/lib/wa-tools-catalog";
import { cn, getInitials } from "@/lib/utils";
import type {
  Automation,
  Pipeline,
  PipelineStage,
  WaAgentConfig,
  WaAgentLog,
  WaCampaign,
  WaCampaignStatus,
  WaCoaching,
  WaColdOutreach,
  WaContact,
  WaKeywordRule,
  WaMatchType,
  WaMessage,
  WaPromise,
} from "@/lib/types";

import type { CampaignStats } from "./page";
import {
  createCampaignAction,
  deleteCampaignAction,
  deleteKeywordRuleAction,
  linkContactToCrmAction,
  markContactReadAction,
  saveCampaignModeAction,
  saveColdConfigAction,
  saveKeywordRuleAction,
  saveWaConfigAction,
  sendWaMessageAction,
  setCampaignStatusAction,
  setContactOptOutAction,
  toggleCoachingAction,
  toggleContactAgentAction,
  updateCampaignAction,
  type WaRuleInput,
} from "./actions";

// ---- helpers ----------------------------------------------------------------

function fmtWa(waId: string): string {
  const m = waId.match(/^94(\d{2})(\d{3})(\d{4})$/);
  if (m) return `+94 ${m[1]} ${m[2]} ${m[3]}`;
  return `+${waId}`;
}

function contactName(c: WaContact): string {
  return c.display_name || c.profile_name || fmtWa(c.wa_id);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** How long a lead waited for their first reply. */
function fmtWait(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 360) / 10}h`;
}

/** Contact silent for 24h+ = Meta only accepts template messages. */
function outsideWindow(c: WaContact): boolean {
  if (!c.last_inbound_at) return true;
  return Date.now() - new Date(c.last_inbound_at).getTime() > 24 * 3600_000;
}

const SENT_BY_LABEL: Record<string, string> = {
  agent: "AI agent",
  keyword: "Keyword rule",
  automation: "Automation",
  team: "You / team",
};

// ---- main view ----------------------------------------------------------------

type Tab = "inbox" | "agent" | "campaign" | "cold" | "keywords" | "activity";

/** A cold-outreach row with its lead's display label joined in. */
type ColdRow = WaColdOutreach & { lead_label: string };

/** Who the cold picker will message next (real eligibility scan). */
type ColdUpcoming = { leadId: string; label: string; waId: string };

/** 30-day cold-outreach performance, computed server-side in page.tsx. */
type ColdStats = {
  sent7: number;
  sent30: number;
  delivered30: number;
  replied30: number;
  replyRate: number | null;
  noWhatsApp30: number;
  failed30: number;
  nudged30: number;
};

export function WhatsappView({
  contacts,
  messages,
  config,
  rules,
  logs,
  pipelines,
  stages,
  automations,
  coaching,
  promises,
  coldRows,
  coldStats,
  coldUpcoming,
  campaigns,
  campaignCounts,
  campaignStats,
  waReady,
  aiReady,
  appBaseUrl,
}: {
  contacts: WaContact[];
  messages: WaMessage[];
  config: WaAgentConfig | null;
  rules: WaKeywordRule[];
  logs: WaAgentLog[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
  automations: Automation[];
  coaching: WaCoaching | null;
  promises: WaPromise[];
  coldRows: ColdRow[];
  coldStats: ColdStats;
  coldUpcoming: ColdUpcoming[];
  campaigns: WaCampaign[];
  campaignCounts: Record<string, number>;
  campaignStats: CampaignStats | null;
  waReady: boolean;
  aiReady: boolean;
  appBaseUrl: string;
}) {
  useRealtimeSyncTables([
    "wa_contacts",
    "wa_messages",
    "wa_agent_logs",
    "wa_promises",
    "wa_cold_outreach",
    "wa_campaigns",
  ]);
  const [tab, setTab] = React.useState<Tab>("inbox");

  const attention = contacts.filter((c) => c.needs_attention).length;
  const unread = contacts.reduce((s, c) => s + (c.unread ?? 0), 0);

  const TABS: { key: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: "inbox", label: "Inbox", icon: <Inbox className="h-4 w-4" />, badge: unread },
    { key: "agent", label: "AI Agent", icon: <Bot className="h-4 w-4" /> },
    { key: "campaign", label: "Campaign", icon: <Megaphone className="h-4 w-4" /> },
    { key: "cold", label: "Cold Outreach", icon: <Snowflake className="h-4 w-4" /> },
    { key: "keywords", label: "Keywords", icon: <Zap className="h-4 w-4" /> },
    { key: "activity", label: "Agent Activity", icon: <ScrollText className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">WhatsApp</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Every WhatsApp Business chat, answered by your AI sales agent and wired
            straight into the CRM.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className={
              waReady
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-amber-50 text-amber-700 ring-amber-200"
            }
            dot={waReady ? "bg-emerald-500" : "bg-amber-500"}
          >
            {waReady ? "WhatsApp connected" : "WhatsApp keys missing"}
          </Badge>
          <Badge
            className={
              aiReady
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-amber-50 text-amber-700 ring-amber-200"
            }
            dot={aiReady ? "bg-emerald-500" : "bg-amber-500"}
          >
            {aiReady ? "AI ready" : "OpenAI key missing"}
          </Badge>
          {attention > 0 && (
            <Badge className="bg-rose-50 text-rose-700 ring-rose-200" dot="bg-rose-500">
              {attention} need{attention === 1 ? "s" : ""} a human
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors",
              tab === t.key
                ? "bg-primary-600 text-white shadow-sm"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
            )}
          >
            {t.icon}
            {t.label}
            {t.badge ? (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[11px] font-semibold",
                  tab === t.key ? "bg-white/20 text-white" : "bg-emerald-100 text-emerald-700",
                )}
              >
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "inbox" && (
        <InboxTab contacts={contacts} messages={messages} promises={promises} waReady={waReady} appBaseUrl={appBaseUrl} />
      )}
      {tab === "agent" && (
        <AgentTab
          config={config}
          pipelines={pipelines}
          stages={stages}
          coaching={coaching}
          waReady={waReady}
          aiReady={aiReady}
          appBaseUrl={appBaseUrl}
        />
      )}
      {tab === "campaign" && (
        <CampaignTab
          config={config}
          campaigns={campaigns}
          campaignCounts={campaignCounts}
          campaignStats={campaignStats}
          waReady={waReady}
          aiReady={aiReady}
        />
      )}
      {tab === "cold" && (
        <ColdOutreachTab
          config={config}
          pipelines={pipelines}
          stages={stages}
          coldRows={coldRows}
          coldStats={coldStats}
          coldUpcoming={coldUpcoming}
          waReady={waReady}
        />
      )}
      {tab === "keywords" && <KeywordsTab rules={rules} automations={automations} />}
      {tab === "activity" && <ActivityTab logs={logs} contacts={contacts} />}
    </div>
  );
}

// ---- Inbox --------------------------------------------------------------------

function InboxTab({
  contacts,
  messages,
  promises,
  waReady,
  appBaseUrl,
}: {
  contacts: WaContact[];
  messages: WaMessage[];
  promises: WaPromise[];
  waReady: boolean;
  appBaseUrl: string;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(
    contacts[0]?.id ?? null,
  );
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [linking, setLinking] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const selected = contacts.find((c) => c.id === selectedId) ?? contacts[0] ?? null;

  const thread = React.useMemo(
    () => messages.filter((m) => m.contact_id === selected?.id),
    [messages, selected?.id],
  );

  /**
   * Reactions ride ON the message they target, the way WhatsApp shows them —
   * so they're pulled out of the message flow and handed to that bubble.
   *
   * One that targets a message which isn't loaded (older than the window, or
   * sent before reactions were captured) has nothing to attach to, so it
   * stays in the flow as a bubble of its own rather than vanishing.
   */
  const { visibleThread, reactionsFor } = React.useMemo(() => {
    const loaded = new Set(
      thread.map((m) => m.wa_message_id).filter(Boolean) as string[],
    );
    const byTarget = new Map<string, string[]>();
    for (const m of thread) {
      if (m.message_type !== "reaction") continue;
      const target = (m.meta as { reaction_target?: string } | null)
        ?.reaction_target;
      if (!target || !loaded.has(target)) continue;
      byTarget.set(target, [...(byTarget.get(target) ?? []), m.body]);
    }
    return {
      visibleThread: thread.filter((m) => {
        if (m.message_type !== "reaction") return true;
        const target = (m.meta as { reaction_target?: string } | null)
          ?.reaction_target;
        return !target || !loaded.has(target);
      }),
      reactionsFor: byTarget,
    };
  }, [thread]);

  // The next promised follow-up for this chat (promises arrive sorted by due_at).
  const selectedPromise = React.useMemo(
    () => promises.find((p) => p.contact_id === selected?.id) ?? null,
    [promises, selected?.id],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        contactName(c).toLowerCase().includes(q) ||
        c.wa_id.includes(q.replace(/[^\d]/g, "") || " "),
    );
  }, [contacts, query]);

  // Clear the unread badge when a chat is opened.
  React.useEffect(() => {
    if (selected && (selected.unread > 0 || selected.needs_attention)) {
      void markContactReadAction(selected.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread.length, selected?.id]);

  async function handleSend() {
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    const body = draft.trim();
    const wasAiOn = selected.agent_enabled;
    setDraft("");
    const res = await sendWaMessageAction(selected.id, body);
    setSending(false);
    if (!res.ok) {
      setDraft(body);
      toast.error(res.error);
    } else if (wasAiOn) {
      // Sending from the inbox hands the chat to the team — surface the
      // auto-pause once so they know to flip the AI back on when done.
      toast.success("AI paused — you're handling this chat. Turn it back on when you're done.");
    }
  }

  async function handleToggleAgent() {
    if (!selected) return;
    const res = await toggleContactAgentAction(selected.id, !selected.agent_enabled);
    if (!res.ok) toast.error(res.error);
    else
      toast.success(
        selected.agent_enabled ? "AI paused for this chat." : "AI re-enabled for this chat.",
      );
  }

  async function handleLink() {
    if (!selected || linking) return;
    setLinking(true);
    const res = await linkContactToCrmAction(selected.id);
    setLinking(false);
    if (!res.ok) toast.error(res.error);
    else toast.success("Client profile + CRM lead created.");
  }

  async function handleLiftOptOut() {
    if (!selected) return;
    const res = await setContactOptOutAction(selected.id, false);
    if (!res.ok) toast.error(res.error);
    else toast.success("Opt-out lifted — automated messaging re-enabled.");
  }

  if (contacts.length === 0) {
    return (
      <EmptyState
        icon={<MessageCircle className="h-7 w-7" />}
        title="No WhatsApp chats yet"
        description={
          waReady
            ? `Chats appear here the moment someone messages your WhatsApp Business number. Make sure the webhook points at ${appBaseUrl || "your app URL"}/api/whatsapp/webhook.`
            : "Add the WHATSAPP_* keys to .env.local, then configure the webhook in the AI Agent tab."
        }
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      {/* Contact list */}
      <div className="flex h-[72vh] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              className="h-10 pl-9"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={cn(
                "flex w-full items-center gap-3 border-b border-slate-50 px-3 py-3 text-left transition-colors hover:bg-slate-50",
                selected?.id === c.id && "bg-primary-50/70 hover:bg-primary-50/70",
              )}
            >
              <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700">
                {getInitials(contactName(c)) || "?"}
                {c.needs_attention && (
                  <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-rose-500" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {contactName(c)}
                  </p>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {timeAgo(c.last_message_at)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs text-slate-500">
                    {c.last_direction === "out" ? "You: " : ""}
                    {c.last_message_preview ?? ""}
                  </p>
                  <span className="flex shrink-0 items-center gap-1">
                    {!c.agent_enabled && <BotOff className="h-3.5 w-3.5 text-slate-400" />}
                    {c.unread > 0 && (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-emerald-500 px-1 text-[11px] font-bold text-white">
                        {c.unread}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="p-6 text-center text-sm text-slate-400">No chats match.</p>
          )}
        </div>
      </div>

      {/* Thread */}
      {selected ? (
        <div className="flex h-[72vh] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700">
              {getInitials(contactName(selected)) || "?"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-900">
                {contactName(selected)}
              </p>
              <p className="text-xs text-slate-400">
                {fmtWa(selected.wa_id)}
                {selected.language && (
                  <span
                    title="Detected chat language — the agent replies in it (same script), including follow-ups."
                    className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200"
                  >
                    {WA_LANGUAGE_LABELS[selected.language]}
                  </span>
                )}
              </p>
            </div>
            {selected.do_not_contact ? (
              <button
                type="button"
                onClick={handleLiftOptOut}
                title="This contact opted out — all automated messages are blocked. Click to lift the block."
                className="inline-flex h-7 items-center gap-1 rounded-full bg-rose-50 px-2.5 text-[11px] font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100"
              >
                <Ban className="h-3 w-3" /> Opted out — tap to lift
              </button>
            ) : selectedPromise ? (
              <span
                title={`They said: "${selectedPromise.summary}" — the agent will message them at exactly this moment. Kept automatically.`}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-amber-50 px-2.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200"
              >
                <Handshake className="h-3 w-3" /> Promise ·{" "}
                {new Date(selectedPromise.due_at).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : selected.next_followup_at ? (
              <span
                title="The agent will chase this deal automatically. Any reply from them cancels it."
                className="inline-flex h-7 items-center gap-1 rounded-full bg-sky-50 px-2.5 text-[11px] font-medium text-sky-700 ring-1 ring-sky-200"
              >
                <CalendarClock className="h-3 w-3" /> Follow-up{" "}
                {Math.min((selected.followup_stage ?? 0) + 1, 3)}/3 ·{" "}
                {new Date(selected.next_followup_at).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : null}
            <div className="flex items-center gap-1.5">
              {selected.lead_id ? (
                <Link
                  href={`/crm/lead/${selected.lead_id}`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-100 px-3 text-xs font-medium text-slate-700 hover:bg-slate-200"
                >
                  <KanbanSquare className="h-3.5 w-3.5" /> Lead
                </Link>
              ) : (
                <Button size="sm" variant="outline" onClick={handleLink} loading={linking}>
                  <UserPlus className="h-3.5 w-3.5" /> Add to CRM
                </Button>
              )}
              <Button
                size="sm"
                variant={selected.agent_enabled ? "secondary" : "outline"}
                onClick={handleToggleAgent}
                title={selected.agent_enabled ? "AI is answering — click to pause" : "AI is paused — click to enable"}
              >
                {selected.agent_enabled ? (
                  <>
                    <Bot className="h-3.5 w-3.5" /> AI on
                  </>
                ) : (
                  <>
                    <BotOff className="h-3.5 w-3.5" /> AI off
                  </>
                )}
              </Button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto bg-slate-50/60 p-4">
            {visibleThread.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                reactions={
                  m.wa_message_id ? reactionsFor.get(m.wa_message_id) : undefined
                }
              />
            ))}
            {thread.length === 0 && (
              <p className="pt-10 text-center text-sm text-slate-400">
                No messages loaded for this chat yet.
              </p>
            )}
          </div>

          <div className="border-t border-slate-100 p-3">
            {outsideWindow(selected) && (
              <p className="mb-2 flex items-center gap-1.5 text-[11px] text-amber-600">
                <AlertTriangle className="h-3.5 w-3.5" />
                No reply from them in 24h — WhatsApp may reject free text. Template
                messages (via automations) still deliver.
              </p>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                rows={2}
                placeholder={waReady ? "Type a reply… (Enter to send)" : "Add the WHATSAPP_* keys to send messages"}
                disabled={!waReady}
                className="min-h-[44px]"
              />
              <Button onClick={handleSend} loading={sending} disabled={!waReady || !draft.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState title="Select a chat" className="h-[72vh]" />
      )}
    </div>
  );
}

function MessageBubble({
  message,
  reactions,
}: {
  message: WaMessage;
  reactions?: string[];
}) {
  const out = message.direction === "out";
  const meta = (message.meta ?? {}) as {
    image_url?: string;
    document_url?: string;
    filename?: string;
  };

  // A reaction whose target isn't loaded has no bubble to sit on — show it
  // as a quiet standalone line rather than a full message bubble.
  if (message.message_type === "reaction") {
    return (
      <div className={cn("flex", out ? "justify-end" : "justify-start")}>
        <span
          className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500 shadow-sm"
          title={`Reacted ${message.body} to an earlier message`}
        >
          <span className="text-sm leading-none">{message.body}</span>
          <span>reacted to an earlier message</span>
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm",
          reactions?.length && "mb-3",
          out
            ? "rounded-br-md bg-emerald-600 text-white"
            : "rounded-bl-md border border-slate-200 bg-white text-slate-800",
        )}
      >
        {meta.image_url && (
          <a
            href={meta.image_url}
            target="_blank"
            rel="noreferrer"
            className="mb-1.5 block"
            title="Open full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={meta.image_url}
              alt="Attachment"
              className="max-h-56 w-full rounded-xl object-cover"
            />
          </a>
        )}
        {meta.document_url && (
          <a
            href={meta.document_url}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "mb-1.5 flex items-center gap-2 rounded-xl border px-2.5 py-2 text-xs font-medium",
              out
                ? "border-white/30 bg-white/10 text-white"
                : "border-slate-200 bg-slate-50 text-slate-700",
            )}
          >
            <ScrollText className="h-4 w-4 shrink-0" />
            {meta.filename || "Open document"}
          </a>
        )}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            out ? "text-emerald-100" : "text-slate-400",
          )}
        >
          {out && message.sent_by && message.sent_by !== "team" && (
            <span className="mr-1 rounded-full bg-white/20 px-1.5 py-px font-medium">
              {SENT_BY_LABEL[message.sent_by] ?? message.sent_by}
            </span>
          )}
          <span>{fmtClock(message.created_at)}</span>
          {out && <StatusTicks status={message.status} error={message.error} />}
        </div>

        {/* The customer's reaction, sitting on the bubble it belongs to. */}
        {reactions?.length ? (
          <span
            className={cn(
              "absolute -bottom-3 flex items-center gap-0.5 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-xs leading-none shadow-sm",
              out ? "left-2" : "right-2",
            )}
            title={`Reacted ${reactions.join(" ")}`}
          >
            {reactions.map((emoji, i) => (
              <span key={i}>{emoji}</span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StatusTicks({ status, error }: { status: string; error: string | null }) {
  if (status === "failed") {
    return (
      <span title={error ?? "Failed"} className="text-rose-200">
        <AlertTriangle className="h-3 w-3" />
      </span>
    );
  }
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 text-sky-300" />;
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5" />;
  return <Check className="h-3.5 w-3.5" />;
}

// ---- AI Agent tab ---------------------------------------------------------------

function AgentTab({
  config,
  pipelines,
  stages,
  coaching,
  waReady,
  aiReady,
  appBaseUrl,
}: {
  config: WaAgentConfig | null;
  pipelines: Pipeline[];
  stages: PipelineStage[];
  coaching: WaCoaching | null;
  waReady: boolean;
  aiReady: boolean;
  appBaseUrl: string;
}) {
  const [form, setForm] = React.useState(() => ({
    enabled: config?.enabled ?? true,
    agent_name: config?.agent_name ?? "Arc",
    greeting: config?.greeting ?? "",
    persona: config?.persona ?? "",
    knowledge: config?.knowledge ?? "",
    ask_name: config?.ask_name ?? true,
    auto_create_lead: config?.auto_create_lead ?? true,
    pipeline_id: config?.pipeline_id ?? "",
    stage_id: config?.stage_id ?? "",
    lead_source: config?.lead_source ?? "whatsapp",
    allowed_tools: config?.allowed_tools ?? WA_TOOL_CATALOG.map((t) => t.key),
    voice_replies: config?.voice_replies ?? "match",
    followups_enabled: config?.followups_enabled ?? true,
    followup_template_name: config?.followup_template_name ?? "",
    followup_template_lang: config?.followup_template_lang ?? "en",
    max_autonomous_discount_pct: config?.max_autonomous_discount_pct ?? 0,
    quiet_hours_enabled: config?.quiet_hours_enabled ?? true,
    quiet_hours_start: config?.quiet_hours_start ?? 21,
    quiet_hours_end: config?.quiet_hours_end ?? 9,
    timezone: config?.timezone ?? "Asia/Colombo",
    language_matching: config?.language_matching ?? true,
  }));
  const [saving, setSaving] = React.useState(false);

  const pipelineStages = stages.filter((s) => s.pipeline_id === form.pipeline_id);
  const webhookUrl = `${appBaseUrl || "https://<your-domain>"}/api/whatsapp/webhook`;

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleTool(key: string) {
    setForm((f) => ({
      ...f,
      allowed_tools: f.allowed_tools.includes(key)
        ? f.allowed_tools.filter((t) => t !== key)
        : [...f.allowed_tools, key],
    }));
  }

  async function handleSave() {
    setSaving(true);
    const res = await saveWaConfigAction({
      ...form,
      pipeline_id: form.pipeline_id || null,
      stage_id: form.stage_id || null,
    });
    setSaving(false);
    if (res.ok) toast.success("Agent configuration saved.");
    else toast.error(res.error);
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        {/* Behaviour */}
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Agent behaviour</h2>
              <p className="text-xs text-slate-500">
                How the AI greets, qualifies and hands over new WhatsApp leads.
              </p>
            </div>
            <Toggle checked={form.enabled} onChange={(v) => set("enabled", v)} label="Agent on" />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Agent name
              <Input
                value={form.agent_name}
                onChange={(e) => set("agent_name", e.target.value)}
                placeholder="Arc"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Lead source label
              <Input
                value={form.lead_source}
                onChange={(e) => set("lead_source", e.target.value)}
                placeholder="whatsapp"
              />
            </label>
          </div>

          <label className="mt-3 block space-y-1.5 text-xs font-medium text-slate-600">
            Extra persona / instructions (optional)
            <Textarea
              value={form.persona}
              onChange={(e) => set("persona", e.target.value)}
              rows={3}
              placeholder="e.g. Always mention our July offer. Never discuss competitor pricing."
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-4">
            <Toggle
              checked={form.ask_name}
              onChange={(v) => set("ask_name", v)}
              label="Ask new contacts for their name"
            />
            <Toggle
              checked={form.auto_create_lead}
              onChange={(v) => set("auto_create_lead", v)}
              label="Auto-create client + CRM lead"
            />
            <Toggle
              checked={form.voice_replies === "match"}
              onChange={(v) => set("voice_replies", v ? "match" : "off")}
              label="Reply to voice notes with voice"
            />
            <Toggle
              checked={form.language_matching}
              onChange={(v) => set("language_matching", v)}
              label="Match customer language (Sinhala / Tamil / Singlish)"
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              New leads land in pipeline
              <Select
                value={form.pipeline_id}
                onChange={(e) => {
                  set("pipeline_id", e.target.value);
                  set("stage_id", "");
                }}
              >
                <option value="">First pipeline (default)</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Stage
              <Select
                value={form.stage_id}
                onChange={(e) => set("stage_id", e.target.value)}
                disabled={!form.pipeline_id}
              >
                <option value="">First stage (default)</option>
                {pipelineStages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </section>

        {/* Knowledge base */}
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Extra notes for the agent (optional)
          </h2>
          <p className="text-xs text-slate-500">
            The agent already knows the full Smart Website system — every
            package, feature and FAQ, with live prices straight from your
            Pricing page. Use this box only for extra facts or corrections;
            anything written here overrides the built-in knowledge.
          </p>
          <Textarea
            value={form.knowledge}
            onChange={(e) => set("knowledge", e.target.value)}
            rows={6}
            className="mt-3 font-mono text-xs"
            placeholder={
              "e.g.\n- July offer: free logo with every Growth package\n- We don't build betting or crypto sites\n- Q: Do you work with clients outside Sri Lanka?\n  A: Yes — we invoice in USD via Stripe."
            }
          />
        </section>

        {/* Closing & follow-ups */}
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Closing &amp; follow-ups</h2>
              <p className="text-xs text-slate-500">
                When a chat goes quiet the agent chases it itself — a nudge after 2
                days, a fresh angle after 3 more, then a graceful goodbye. Any reply
                cancels the cadence instantly; &quot;stop&quot; blocks them forever.
              </p>
            </div>
            <Toggle
              checked={form.followups_enabled}
              onChange={(v) => set("followups_enabled", v)}
              label="Autonomous follow-ups"
            />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium text-slate-600 sm:col-span-2">
              Approved follow-up template (outside the 24h window)
              <Input
                value={form.followup_template_name}
                onChange={(e) => set("followup_template_name", e.target.value)}
                placeholder="e.g. friendly_checkin (Meta-approved template name)"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Template language
              <Input
                value={form.followup_template_lang}
                onChange={(e) => set("followup_template_lang", e.target.value)}
                placeholder="en"
              />
            </label>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            No template? Chats past the 24h window get a task for the team instead
            of an automated touch.
          </p>

          <label className="mt-4 block space-y-1.5 text-xs font-medium text-slate-600">
            Discount authority (max % the agent may offer on a quote — 0 = none)
            <Input
              type="number"
              min={0}
              max={50}
              value={String(form.max_autonomous_discount_pct)}
              onChange={(e) =>
                set(
                  "max_autonomous_discount_pct",
                  Math.min(50, Math.max(0, Math.round(Number(e.target.value) || 0))),
                )
              }
              className="max-w-[120px]"
            />
          </label>
          <p className="mt-1 text-[11px] text-slate-400">
            Used at most once per deal, only on a real price objection, framed as a
            sign-this-week incentive. The send-quote tool enforces the cap.
          </p>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <div>
              <h3 className="text-xs font-semibold text-slate-900">Quiet hours for nudges</h3>
              <p className="text-[11px] text-slate-400">
                Follow-up nudges and cold outreach due in this window are delivered
                next morning instead. The agent itself never sleeps — customer
                replies are answered 24/7.
              </p>
            </div>
            <Toggle
              checked={form.quiet_hours_enabled}
              onChange={(v) => set("quiet_hours_enabled", v)}
              label="Quiet hours"
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              From (hour)
              <Select
                value={String(form.quiet_hours_start)}
                onChange={(e) => set("quiet_hours_start", Number(e.target.value))}
                disabled={!form.quiet_hours_enabled}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Until (hour)
              <Select
                value={String(form.quiet_hours_end)}
                onChange={(e) => set("quiet_hours_end", Number(e.target.value))}
                disabled={!form.quiet_hours_enabled}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Timezone
              <Input
                value={form.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                placeholder="Asia/Colombo"
                disabled={!form.quiet_hours_enabled}
              />
            </label>
          </div>
        </section>

        {/* Tool permissions */}
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">What the agent is allowed to do</h2>
          <p className="text-xs text-slate-500">
            Untick anything you want to keep human-only. The agent can only ever use
            the ticked actions — every use is logged under Agent Activity.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {WA_TOOL_CATALOG.map((tool) => {
              const on = form.allowed_tools.includes(tool.key);
              return (
                <button
                  key={tool.key}
                  type="button"
                  onClick={() => toggleTool(tool.key)}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                    on
                      ? "border-primary-200 bg-primary-50/60"
                      : "border-slate-200 bg-white opacity-70 hover:opacity-100",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border",
                      on
                        ? "border-primary-600 bg-primary-600 text-white"
                        : "border-slate-300 bg-white",
                    )}
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span>
                    <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                      {tool.label}
                      <Badge
                        className={
                          tool.kind === "read"
                            ? "bg-sky-50 text-sky-700 ring-sky-200"
                            : "bg-amber-50 text-amber-700 ring-amber-200"
                        }
                      >
                        {tool.kind}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-slate-500">
                      {tool.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="flex justify-end">
          <Button onClick={handleSave} loading={saving}>
            <Settings2 className="h-4 w-4" /> Save agent configuration
          </Button>
        </div>
      </div>

      {/* Setup / status side panel */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Connection setup</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-4 text-xs leading-5 text-slate-600">
            <li>
              Create a Meta app with the <b>WhatsApp</b> product (business.facebook.com),
              add your business number and generate a permanent access token.
            </li>
            <li>
              Add <code className="rounded bg-slate-100 px-1">WHATSAPP_ACCESS_TOKEN</code>,{" "}
              <code className="rounded bg-slate-100 px-1">WHATSAPP_PHONE_NUMBER_ID</code>,{" "}
              <code className="rounded bg-slate-100 px-1">WHATSAPP_VERIFY_TOKEN</code> and{" "}
              <code className="rounded bg-slate-100 px-1">WHATSAPP_APP_SECRET</code> to{" "}
              <code className="rounded bg-slate-100 px-1">.env.local</code> (and Netlify).
            </li>
            <li>
              In WhatsApp → Configuration, set the webhook to
              <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1 font-mono text-[11px]">
                {webhookUrl}
              </code>
              with your verify token, and subscribe to the <b>messages</b> field.
            </li>
            <li>Send your number a WhatsApp message — it appears in the Inbox.</li>
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge
              className={waReady ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"}
              dot={waReady ? "bg-emerald-500" : "bg-amber-500"}
            >
              {waReady ? "API keys detected" : "API keys missing"}
            </Badge>
            <Badge
              className={aiReady ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"}
              dot={aiReady ? "bg-emerald-500" : "bg-amber-500"}
            >
              {aiReady ? "OpenAI ready" : "OPENAI_API_KEY missing"}
            </Badge>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Greeting</h2>
          <p className="text-xs text-slate-500">
            Tone-setter for brand-new contacts. The agent uses it as its opening style
            (it still adapts to what the customer wrote).
          </p>
          <Textarea
            value={form.greeting}
            onChange={(e) => set("greeting", e.target.value)}
            rows={4}
            className="mt-3"
          />
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Weekly coaching</h2>
            {coaching && (
              <Toggle
                checked={coaching.is_active}
                onChange={(v) => {
                  void toggleCoachingAction(coaching.id, v).then((res) => {
                    if (!res.ok) toast.error(res.error);
                  });
                }}
                label={coaching.is_active ? "Applied" : "Muted"}
              />
            )}
          </div>
          <p className="text-xs text-slate-500">
            Every Monday the agent studies its own conversations — what won, what
            got ghosted — and coaches itself. The latest lessons are fed straight
            into its brain.
          </p>
          {coaching ? (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Week of {coaching.week_start}
              </p>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-xs leading-5 text-slate-700">
                {coaching.notes}
              </pre>
            </>
          ) : (
            <p className="mt-3 text-xs italic text-slate-400">
              No lessons yet — they appear after the first weekly digest run once
              real conversations exist.
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">How it flows</h2>
          <ul className="mt-2 space-y-1.5 text-xs leading-5 text-slate-600">
            <li>1️⃣ New number messages in → agent greets & asks their name</li>
            <li>2️⃣ Name given → client profile + CRM lead created automatically</li>
            <li>3️⃣ Agent qualifies, researches their business, answers from your knowledge base</li>
            <li>4️⃣ Interested → booking link · Serious → proposal drafted for review</li>
            <li>5️⃣ Wants a human → AI pauses & the team is pinged</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

// ---- Cold Outreach tab ----------------------------------------------------------

function ColdOutreachTab({
  config,
  pipelines,
  stages,
  coldRows,
  coldStats,
  coldUpcoming,
  waReady,
}: {
  config: WaAgentConfig | null;
  pipelines: Pipeline[];
  stages: PipelineStage[];
  coldRows: ColdRow[];
  coldStats: ColdStats;
  coldUpcoming: ColdUpcoming[];
  waReady: boolean;
}) {
  const [form, setForm] = React.useState(() => ({
    cold_outreach_enabled: config?.cold_outreach_enabled ?? false,
    cold_daily_cap: config?.cold_daily_cap ?? 5,
    cold_template_name: config?.cold_template_name ?? "",
    cold_template_lang: config?.cold_template_lang ?? "en",
    // Edited as one comma-separated line; split back on save.
    cold_template_params: (config?.cold_template_params ?? []).join(", "),
    cold_pipeline_id: config?.cold_pipeline_id ?? "",
    cold_stage_id: config?.cold_stage_id ?? "",
    cold_followup_template_name: config?.cold_followup_template_name ?? "",
    cold_followup_template_lang: config?.cold_followup_template_lang ?? "en",
    cold_followup_template_params: (config?.cold_followup_template_params ?? []).join(", "),
    cold_followup_days: config?.cold_followup_days ?? 3,
  }));
  const [saving, setSaving] = React.useState(false);

  const coldPipelineStages = stages.filter(
    (s) => s.pipeline_id === form.cold_pipeline_id,
  );

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    const res = await saveColdConfigAction({
      ...form,
      cold_pipeline_id: form.cold_pipeline_id || null,
      cold_stage_id: form.cold_stage_id || null,
      cold_template_params: form.cold_template_params
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      cold_followup_template_params: form.cold_followup_template_params
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    });
    setSaving(false);
    if (res.ok) toast.success("Cold outreach settings saved.");
    else toast.error(res.error);
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1fr_380px]">
      {/* Left — settings */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Automatic cold outreach
              </h2>
              <p className="text-xs text-slate-500">
                Each day the agent takes the top leads of your New Lead column,
                researches the company first, then opens the conversation with
                your approved template. Numbers that turn out not to be on
                WhatsApp are tagged &quot;no-whatsapp&quot; and the next lead
                takes the slot.
              </p>
            </div>
            <Toggle
              checked={form.cold_outreach_enabled}
              onChange={(v) => set("cold_outreach_enabled", v)}
              label="Cold outreach"
            />
          </div>

          {!waReady && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-inset ring-amber-200">
              WhatsApp keys are missing — nothing can send until they&apos;re
              configured.
            </p>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium text-slate-600 sm:col-span-2">
              Approved cold template (opens the conversation)
              <Input
                value={form.cold_template_name}
                onChange={(e) => set("cold_template_name", e.target.value)}
                placeholder="e.g. site_audit_intro (Meta-approved template name)"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Template language
              <Input
                value={form.cold_template_lang}
                onChange={(e) => set("cold_template_lang", e.target.value)}
                placeholder="en"
              />
            </label>
          </div>
          <label className="mt-3 block space-y-1.5 text-xs font-medium text-slate-600">
            Template variables ({"{{1}}, {{2}}"}… in order, comma-separated)
            <Input
              value={form.cold_template_params}
              onChange={(e) => set("cold_template_params", e.target.value)}
              placeholder="{{first_name}}, {{business}}"
            />
          </label>
          <p className="mt-1 text-[11px] text-slate-400">
            Tokens filled per lead: {"{{business}} {{name}} {{first_name}} {{website}} {{city}}"}.
            Nothing sends until a template name is set — approve it in Meta
            Business Manager first.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Max messages per day
              <Input
                type="number"
                min={1}
                max={20}
                value={String(form.cold_daily_cap)}
                onChange={(e) =>
                  set(
                    "cold_daily_cap",
                    Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 5))),
                  )
                }
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Pick leads from pipeline
              <Select
                value={form.cold_pipeline_id}
                onChange={(e) => {
                  set("cold_pipeline_id", e.target.value);
                  set("cold_stage_id", "");
                }}
              >
                <option value="">First pipeline (default)</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Stage
              <Select
                value={form.cold_stage_id}
                onChange={(e) => set("cold_stage_id", e.target.value)}
                disabled={!form.cold_pipeline_id}
              >
                <option value="">Auto: New Lead stage</option>
                {coldPipelineStages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Account safety: at most {form.cold_daily_cap} cold message
            {form.cold_daily_cap === 1 ? "" : "s"} a day, spread 90+ minutes
            apart, only outside quiet hours, one lead at a time, and a number is
            never messaged twice.
          </p>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Follow-up nudge</h2>
          <p className="text-xs text-slate-500">
            If a delivered message gets no reply for the set number of days, the
            agent sends ONE follow-up template, then stops forever. Leave the
            template empty to disable. Nudges count toward the daily cap.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium text-slate-600 sm:col-span-2">
              Approved follow-up template
              <Input
                value={form.cold_followup_template_name}
                onChange={(e) => set("cold_followup_template_name", e.target.value)}
                placeholder="e.g. site_audit_nudge (a SECOND Meta-approved template)"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Template language
              <Input
                value={form.cold_followup_template_lang}
                onChange={(e) => set("cold_followup_template_lang", e.target.value)}
                placeholder="en"
              />
            </label>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium text-slate-600 sm:col-span-2">
              Template variables (comma-separated)
              <Input
                value={form.cold_followup_template_params}
                onChange={(e) => set("cold_followup_template_params", e.target.value)}
                placeholder="{{first_name}}, {{business}}"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Days of silence first
              <Input
                type="number"
                min={1}
                max={14}
                value={String(form.cold_followup_days)}
                onChange={(e) =>
                  set(
                    "cold_followup_days",
                    Math.min(14, Math.max(1, Math.round(Number(e.target.value) || 3))),
                  )
                }
              />
            </label>
          </div>
        </section>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save cold outreach settings"}
          </Button>
        </div>
      </div>

      {/* Right — what's happening */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Last 30 days</h2>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <ColdStat label="Sent (7d)" value={coldStats.sent7} />
            <ColdStat label="Sent (30d)" value={coldStats.sent30} />
            <ColdStat
              label="Replied"
              value={coldStats.replied30}
              sub={coldStats.replyRate != null ? `${coldStats.replyRate}% reply rate` : undefined}
              tone={coldStats.replied30 > 0 ? "emerald" : "slate"}
            />
            <ColdStat
              label="No WhatsApp"
              value={coldStats.noWhatsApp30}
              tone={coldStats.noWhatsApp30 > 0 ? "amber" : "slate"}
            />
          </div>
          {(coldStats.failed30 > 0 || coldStats.nudged30 > 0) && (
            <p className="mt-2 text-[11px] text-slate-400">
              {coldStats.failed30 > 0 ? `${coldStats.failed30} failed to send. ` : ""}
              {coldStats.nudged30 > 0 ? `${coldStats.nudged30} follow-up nudge${coldStats.nudged30 === 1 ? "" : "s"} sent.` : ""}
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Up next</h2>
          <p className="text-xs text-slate-500">
            The next leads the agent will message, straight from the top of
            your New Lead column — drag cards on the CRM board to change the
            order.
          </p>
          {coldUpcoming.length > 0 ? (
            <ol className="mt-3 space-y-2">
              {coldUpcoming.map((u, i) => (
                <li
                  key={u.leadId}
                  className="flex items-center gap-2 text-xs text-slate-700"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-500">
                    {i + 1}
                  </span>
                  <Link
                    href={`/crm/lead/${u.leadId}`}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {u.label}
                    <span className="ml-2 text-slate-400">{fmtWa(u.waId)}</span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-xs text-slate-400">
              No eligible leads right now — add leads with phone numbers to the
              New Lead column and they&apos;ll appear here.
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Recent picks (48h)</h2>
          {coldRows.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {coldRows.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <Link
                    href={`/crm/lead/${r.lead_id}`}
                    className="min-w-0 flex-1 truncate text-slate-700 hover:underline"
                  >
                    {r.lead_label}
                    <span className="ml-2 text-slate-400">{fmtWa(r.wa_id)}</span>
                    {r.followup_sent_at && (
                      <span className="ml-1 text-[10px] text-sky-600">· nudged</span>
                    )}
                  </Link>
                  <ColdStatusChip status={r.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-slate-400">
              Nothing yet — once the agent starts messaging, every pick shows up
              here with its live status.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

// ---- Campaign -----------------------------------------------------------------

const CAMPAIGN_STATUS_STYLE: Record<WaCampaignStatus, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  paused: "bg-amber-50 text-amber-700 ring-amber-200",
  draft: "bg-slate-100 text-slate-600 ring-slate-200",
  ended: "bg-slate-100 text-slate-400 ring-slate-200",
};

/**
 * Campaign mode — what the agent is selling while a Meta ad is running.
 *
 * Ads point at this WhatsApp number, so the people who tap them arrive as
 * ordinary inbound chats. Without this tab the agent has no idea what they
 * just clicked and falls back to generic discovery. The team gives it two
 * things — the ad image and one box of service info — and both stack on top
 * of the existing knowledge base rather than replacing it.
 *
 * Campaigns build up as a library for reuse; exactly one is live at a time,
 * so the agent is never ambiguous about which offer it's pitching.
 */
function CampaignTab({
  config,
  campaigns,
  campaignCounts,
  campaignStats,
  waReady,
  aiReady,
}: {
  config: WaAgentConfig | null;
  campaigns: WaCampaign[];
  campaignCounts: Record<string, number>;
  campaignStats: CampaignStats | null;
  waReady: boolean;
  aiReady: boolean;
}) {
  const [enabled, setEnabled] = React.useState(
    config?.campaign_mode_enabled ?? false,
  );
  const [editing, setEditing] = React.useState<WaCampaign | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<WaCampaign | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const active = campaigns.find((c) => c.status === "active") ?? null;

  async function toggleMode(next: boolean) {
    setEnabled(next); // optimistic — the switch should never feel laggy
    const res = await saveCampaignModeAction(next);
    if (!res.ok) {
      setEnabled(!next);
      toast.error(res.error);
      return;
    }
    toast.success(next ? "Campaign mode is on." : "Campaign mode is off.");
  }

  async function setStatus(campaign: WaCampaign, status: WaCampaignStatus) {
    setBusyId(campaign.id);
    const res = await setCampaignStatusAction(campaign.id, status);
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(
      status === "active"
        ? `"${campaign.name}" is live — any other campaign was paused.`
        : `"${campaign.name}" paused.`,
    );
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1fr_380px]">
      {/* Left — the switch and what's live */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Campaign mode
              </h2>
              <p className="text-xs text-slate-500">
                When your Meta ad sends people to this WhatsApp number, they
                land straight in the inbox. Turn this on and the agent goes
                hyper-focused for those leads: it sells ONLY the live
                campaign — no service menus, no website discovery — prices it
                from your pricing line, and closes for a booked call. Existing
                conversations and everyone else are untouched, and switching
                this off brings the normal agent straight back.
              </p>
            </div>
            <Toggle checked={enabled} onChange={toggleMode} label="Campaign mode" />
          </div>

          {!waReady && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-inset ring-amber-200">
              WhatsApp keys are missing — the agent can&apos;t reply to anyone
              until they&apos;re configured.
            </p>
          )}
          {enabled && !active && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-inset ring-amber-200">
              Campaign mode is on but nothing is live — activate a campaign on
              the right, or the agent carries on exactly as before.
            </p>
          )}
          {!aiReady && (
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              Without an OpenAI key the ad image can&apos;t be read — the agent
              will pitch from your details box alone.
            </p>
          )}
        </section>

        {active ? (
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Now selling
              </h2>
              <Badge
                className="bg-emerald-50 text-emerald-700 ring-emerald-200"
                dot="bg-emerald-500"
              >
                {campaignCounts[active.id] ?? 0} lead
                {(campaignCounts[active.id] ?? 0) === 1 ? "" : "s"} so far
              </Badge>
            </div>

            <div className="mt-4 flex flex-wrap gap-4">
              {active.image_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={active.image_url}
                  alt={`${active.name} ad creative`}
                  className="h-36 w-36 rounded-xl object-cover ring-1 ring-slate-200"
                />
              )}
              <div className="min-w-[240px] flex-1">
                <p className="text-sm font-semibold text-slate-900">
                  {active.name}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">
                  {active.details.trim() ||
                    "No details written yet — the agent has nothing to pitch from."}
                </p>
                {active.pricing_note?.trim() && (
                  <p className="mt-2 rounded-lg bg-emerald-50/60 px-3 py-2 text-[11px] leading-relaxed text-emerald-800 ring-1 ring-inset ring-emerald-100">
                    <span className="font-medium">When they ask the price:</span>{" "}
                    {active.pricing_note}
                  </p>
                )}
              </div>
            </div>

            {active.image_summary && (
              <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                <span className="font-medium text-slate-600">
                  What the agent reads off your ad image:
                </span>{" "}
                {active.image_summary}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(active)}
              >
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
              <Button
                variant="subtle"
                size="sm"
                disabled={busyId === active.id}
                onClick={() => setStatus(active, "paused")}
              >
                <Pause className="h-4 w-4" />
                Pause
              </Button>
            </div>
          </section>
        ) : (
          <EmptyState
            icon={<Megaphone className="h-6 w-6" />}
            title="No campaign is live"
            description="Add the ad you're running and everything the agent should know about the offer, then activate it."
            action={
              <Button onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" />
                New campaign
              </Button>
            }
          />
        )}
      </div>

      {/* Right — results, then the library */}
      <div className="space-y-4">
        {campaignStats && (
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">
              This campaign
            </h2>
            <p className="text-xs text-slate-500">
              Everyone who messaged while it&apos;s been live.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <ColdStat label="Leads" value={campaignStats.leads} />
              <ColdStat
                label="First reply"
                value={fmtWait(campaignStats.medianFirstReply)}
                sub={
                  campaignStats.p90FirstReply != null
                    ? `slowest 10%: ${fmtWait(campaignStats.p90FirstReply)}`
                    : undefined
                }
                tone={
                  campaignStats.medianFirstReply != null &&
                  campaignStats.medianFirstReply <= 60
                    ? "emerald"
                    : campaignStats.medianFirstReply != null
                      ? "amber"
                      : "slate"
                }
              />
              <ColdStat label="Quoted" value={campaignStats.quoted} />
              <ColdStat
                label="Won"
                value={campaignStats.won}
                sub={
                  campaignStats.closeRate != null
                    ? `${campaignStats.closeRate}% close rate`
                    : undefined
                }
                tone={campaignStats.won > 0 ? "emerald" : "slate"}
              />
            </div>
            {campaignStats.revenue > 0 && (
              <p className="mt-2 text-[11px] text-slate-400">
                Rs {campaignStats.revenue.toLocaleString()} won so far ·{" "}
                {campaignStats.inCrm} of {campaignStats.leads} in the CRM.
              </p>
            )}
          </section>
        )}

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Campaigns</h2>
              <p className="text-xs text-slate-500">
                One runs at a time — activating a campaign pauses the others.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" />
              New
            </Button>
          </div>

          {campaigns.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {campaigns.map((c) => (
                <li
                  key={c.id}
                  className="rounded-xl p-3 ring-1 ring-slate-200"
                >
                  <div className="flex items-start gap-3">
                    {c.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.image_url}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-slate-200"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-800">
                        {c.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {campaignCounts[c.id] ?? 0} lead
                        {(campaignCounts[c.id] ?? 0) === 1 ? "" : "s"}
                      </p>
                    </div>
                    <Badge className={CAMPAIGN_STATUS_STYLE[c.status]}>
                      {c.status}
                    </Badge>
                  </div>

                  <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
                    {c.status !== "active" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === c.id}
                        onClick={() => setStatus(c, "active")}
                      >
                        <Play className="h-3.5 w-3.5" />
                        Activate
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(c)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPendingDelete(c)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-slate-400">
              No campaigns yet. Add one with the ad image and everything the
              agent should know about what you&apos;re offering.
            </p>
          )}
        </section>
      </div>

      <CampaignModal
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        open={editing !== null}
        campaign={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        description="The ad image goes with it. Contacts that came in under this campaign keep their chats — they just stop being counted against it."
        onConfirm={async () => {
          if (!pendingDelete) return;
          const res = await deleteCampaignAction(pendingDelete.id);
          if (!res.ok) toast.error(res.error);
          else toast.success("Campaign deleted.");
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

/** New/edit campaign — three inputs: name, the ad image, and one box for
 * everything the agent should know. The image is uploaded to storage first,
 * then read once by the server action so the agent can "see" it. */
function CampaignModal({
  open,
  campaign,
  onClose,
}: {
  open: boolean;
  campaign: WaCampaign | null;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(campaign?.name ?? "");
  const [details, setDetails] = React.useState(campaign?.details ?? "");
  const [pricingNote, setPricingNote] = React.useState(
    campaign?.pricing_note ?? "",
  );
  const [firstReply, setFirstReply] = React.useState(campaign?.first_reply ?? "");
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(
    campaign?.image_url ?? null,
  );
  const [saving, setSaving] = React.useState(false);

  /** Swap the preview as they pick, freeing the blob URL we're replacing. */
  function pickFile(next: File | null) {
    if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : (campaign?.image_url ?? null));
  }

  async function submit() {
    if (!name.trim()) {
      toast.error("Give the campaign a name.");
      return;
    }
    if (file && !file.type.startsWith("image/")) {
      toast.error("The ad has to be an image.");
      return;
    }

    setSaving(true);
    try {
      // Only touch storage when a new file was actually picked; editing the
      // text alone keeps the existing creative and skips the vision re-read.
      let imageUrl = campaign?.image_url ?? null;
      let imagePath = campaign?.image_path ?? null;
      if (file) {
        const uploaded = await uploadFile(STORAGE_BUCKETS.waCampaigns, file);
        imageUrl = uploaded.publicUrl;
        imagePath = uploaded.path;
      }

      const input = {
        name,
        details,
        pricing_note: pricingNote,
        first_reply: firstReply,
        image_url: imageUrl,
        image_path: imagePath,
      };
      const res = campaign
        ? await updateCampaignAction(campaign.id, input)
        : await createCampaignAction(input);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(campaign ? "Campaign updated." : "Campaign added.");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={campaign ? "Edit campaign" : "New campaign"}
      description="The agent sells from this while campaign mode is on."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : campaign ? "Save changes" : "Add campaign"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          Campaign name
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. July website offer"
          />
        </label>

        <div className="space-y-1.5 text-xs font-medium text-slate-600">
          The ad you&apos;re running
          <div className="flex items-start gap-3">
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt=""
                className="h-24 w-24 rounded-xl object-cover ring-1 ring-slate-200"
              />
            )}
            <div className="flex-1 space-y-1.5">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
              <p className="text-[11px] font-normal text-slate-400">
                A screenshot of the post or the ad creative. The agent reads it
                once so it knows what the customer just tapped.
              </p>
            </div>
          </div>
        </div>

        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          Everything the agent should know
          <Textarea
            rows={9}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={
              "The offer you're advertising: what's included, who it's for, why it wins, and the goal of the conversation.\n\nWhile this campaign is live, the agent sells ONLY this to people arriving from the ad — so put everything it needs to close in here."
            }
          />
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          When they ask the price
          <Textarea
            rows={3}
            value={pricingNote}
            onChange={(e) => setPricingNote(e.target.value)}
            placeholder={
              'e.g. Custom solution, every business is different — starts from Rs 175,000; exact number comes after a quick scoping call. State the commercial terms exactly (one-time, or setup plus monthly) so the agent never guesses.'
            }
          />
          <span className="block text-[11px] font-normal text-slate-400">
            The only pricing the agent is allowed to give for this offer. Leave
            it blank and the agent answers price questions from the details box
            above instead.
          </span>
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          Instant reply
          <Textarea
            rows={2}
            value={firstReply}
            onChange={(e) => setFirstReply(e.target.value)}
            placeholder="Leave blank and it'll be written for you from the details above."
          />
          <span className="block text-[11px] font-normal text-slate-400">
            Fires the second someone messages from the ad — before the agent has
            read anything. It should introduce the agent as ARC&apos;s AI agent
            and name the campaign; don&apos;t quote a price here — the real
            reply follows a moment later.
          </span>
        </label>
      </div>
    </Modal>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-xs font-medium text-slate-600"
    >
      <span
        className={cn(
          "relative h-6 w-11 rounded-full transition-colors",
          checked ? "bg-primary-600" : "bg-slate-200",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}

const COLD_STATUS_META: Record<string, { label: string; className: string }> = {
  researching: { label: "Researching", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  ready: { label: "Ready to send", className: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  sent: { label: "Sent", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  delivered: { label: "Delivered", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  replied: { label: "Replied 🎉", className: "bg-emerald-100 text-emerald-800 ring-emerald-300" },
  no_whatsapp: { label: "No WhatsApp", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  skipped: { label: "Skipped", className: "bg-slate-50 text-slate-500 ring-slate-200" },
};

const COLD_STAT_TONES: Record<string, string> = {
  slate: "bg-slate-50 text-slate-700 ring-slate-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
};

function ColdStat({
  label,
  value,
  sub,
  tone = "slate",
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: "slate" | "emerald" | "amber";
}) {
  return (
    <div className={cn("rounded-xl px-3 py-2.5 ring-1 ring-inset", COLD_STAT_TONES[tone])}>
      <div className="text-lg font-bold leading-tight">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
      {sub && <div className="text-[10px] opacity-60">{sub}</div>}
    </div>
  );
}

function ColdStatusChip({ status }: { status: string }) {
  const meta = COLD_STATUS_META[status] ?? COLD_STATUS_META.sent;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

// ---- Keywords tab ---------------------------------------------------------------

const EMPTY_RULE: WaRuleInput = {
  keyword: "",
  match_type: "contains",
  reply: "",
  add_tag: "",
  notify_team: false,
  handoff: false,
  automation_id: null,
  is_active: true,
};

function KeywordsTab({
  rules,
  automations,
}: {
  rules: WaKeywordRule[];
  automations: Automation[];
}) {
  const [editing, setEditing] = React.useState<WaRuleInput | null>(null);
  const [deleting, setDeleting] = React.useState<WaKeywordRule | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function handleSave() {
    if (!editing || saving) return;
    setSaving(true);
    const res = await saveKeywordRuleAction(editing);
    setSaving(false);
    if (res.ok) {
      toast.success("Keyword rule saved.");
      setEditing(null);
    } else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Instant, deterministic reactions to words in incoming messages — they run
          before the AI (e.g. <b>&quot;stop&quot;</b> → pause AI, <b>&quot;price&quot;</b> → notify team).
        </p>
        <Button onClick={() => setEditing({ ...EMPTY_RULE })}>
          <Plus className="h-4 w-4" /> New rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-7 w-7" />}
          title="No keyword rules yet"
          description={'Try one: keyword "stop" → hand off to a human. Or "price" → notify the team instantly.'}
          action={
            <Button onClick={() => setEditing({ ...EMPTY_RULE })}>
              <Plus className="h-4 w-4" /> Create your first rule
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => {
            const actions = [
              rule.reply ? "auto-reply" : null,
              rule.add_tag ? `tag "${rule.add_tag}"` : null,
              rule.notify_team ? "notify team" : null,
              rule.handoff ? "human handoff" : null,
              rule.automation_id ? "run automation" : null,
            ].filter(Boolean);
            return (
              <div
                key={rule.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm",
                  !rule.is_active && "opacity-55",
                )}
              >
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
                  <Zap className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900">
                    &quot;{rule.keyword}&quot;{" "}
                    <span className="font-normal text-slate-400">
                      ({rule.match_type.replace("_", " ")})
                    </span>
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {actions.length ? actions.join(" · ") : "no actions"} · {rule.hits} hit
                    {rule.hits === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Toggle
                    checked={rule.is_active}
                    onChange={(v) =>
                      void saveKeywordRuleAction({
                        id: rule.id,
                        keyword: rule.keyword,
                        match_type: rule.match_type,
                        reply: rule.reply ?? "",
                        add_tag: rule.add_tag ?? "",
                        notify_team: rule.notify_team,
                        handoff: rule.handoff,
                        automation_id: rule.automation_id,
                        is_active: v,
                      })
                    }
                    label={rule.is_active ? "On" : "Off"}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing({
                        id: rule.id,
                        keyword: rule.keyword,
                        match_type: rule.match_type,
                        reply: rule.reply ?? "",
                        add_tag: rule.add_tag ?? "",
                        notify_team: rule.notify_team,
                        handoff: rule.handoff,
                        automation_id: rule.automation_id,
                        is_active: rule.is_active,
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(rule)}>
                    <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit keyword rule" : "New keyword rule"}
        description="Runs instantly on matching inbound messages, before the AI agent."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save rule
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Keyword
                <Input
                  value={editing.keyword}
                  onChange={(e) => setEditing({ ...editing, keyword: e.target.value })}
                  placeholder="e.g. price"
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Match
                <Select
                  value={editing.match_type}
                  onChange={(e) =>
                    setEditing({ ...editing, match_type: e.target.value as WaMatchType })
                  }
                >
                  <option value="contains">contains</option>
                  <option value="exact">is exactly</option>
                  <option value="starts_with">starts with</option>
                </Select>
              </label>
            </div>
            <label className="block space-y-1.5 text-xs font-medium text-slate-600">
              Auto-reply (optional — supports {"{{name}}"})
              <Textarea
                value={editing.reply}
                onChange={(e) => setEditing({ ...editing, reply: e.target.value })}
                rows={3}
                placeholder="Hi {{name}}, here's our price list: …"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Tag the lead (optional)
                <Input
                  value={editing.add_tag}
                  onChange={(e) => setEditing({ ...editing, add_tag: e.target.value })}
                  placeholder="e.g. pricing-request"
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Run automation (optional)
                <Select
                  value={editing.automation_id ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, automation_id: e.target.value || null })
                  }
                >
                  <option value="">None</option>
                  {automations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="flex flex-wrap gap-4 pt-1">
              <Toggle
                checked={editing.notify_team}
                onChange={(v) => setEditing({ ...editing, notify_team: v })}
                label="Notify the team"
              />
              <Toggle
                checked={editing.handoff}
                onChange={(v) => setEditing({ ...editing, handoff: v })}
                label="Pause AI (human handoff)"
              />
              <Toggle
                checked={editing.is_active}
                onChange={(v) => setEditing({ ...editing, is_active: v })}
                label="Active"
              />
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this keyword rule?"
        description={deleting ? `"${deleting.keyword}" will stop matching immediately.` : undefined}
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteKeywordRuleAction(deleting.id);
          if (res.ok) toast.success("Rule deleted.");
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

// ---- Activity tab ---------------------------------------------------------------

function ActivityTab({
  logs,
  contacts,
}: {
  logs: WaAgentLog[];
  contacts: WaContact[];
}) {
  const names = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) map.set(c.id, contactName(c));
    return map;
  }, [contacts]);

  if (logs.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="h-7 w-7" />}
        title="No agent activity yet"
        description="Every CRM action the AI agent takes (creating leads, research, proposals…) is audited here."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
      <div className="max-h-[70vh] overflow-y-auto">
        {logs.map((log) => {
          const meta = WA_TOOL_CATALOG.find((t) => t.key === log.tool);
          return (
            <div
              key={log.id}
              className="flex items-start gap-3 border-b border-slate-50 px-4 py-3 last:border-0"
            >
              <div
                className={cn(
                  "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                  log.ok ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600",
                )}
              >
                <Bot className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-slate-900">
                    {meta?.label ?? log.tool}
                  </p>
                  <Badge
                    className={
                      log.ok
                        ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                        : "bg-rose-50 text-rose-700 ring-rose-200"
                    }
                  >
                    {log.ok ? "ok" : "failed"}
                  </Badge>
                  {log.contact_id && (
                    <span className="text-xs text-slate-400">
                      {names.get(log.contact_id) ?? "Unknown contact"}
                    </span>
                  )}
                </div>
                {log.result && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{log.result}</p>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-slate-400">
                {timeAgo(log.created_at)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
