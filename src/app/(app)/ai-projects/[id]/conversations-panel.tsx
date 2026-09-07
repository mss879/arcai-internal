"use client";

import * as React from "react";
import { toast } from "sonner";
import { CalendarCheck, ChevronDown, ChevronUp, Eye, MessagesSquare, Trash2, UserPlus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { compact, hostOf, shortDateTime, usd } from "@/lib/ai-projects/format";
import { cn } from "@/lib/utils";

import { deleteConversation, loadConversationTranscript, type TranscriptMessage } from "./conversation-actions";

export type ConversationRow = {
  id: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  userMessages: number;
  pageUrl: string | null;
  country: string | null;
  hasLead: boolean;
  handoff: boolean;
  booking: boolean;
  preview: boolean;
  costUsd: number;
  tokens: number;
};

export function ConversationsPanel({ projectId, conversations }: { projectId: string; conversations: ConversationRow[] }) {
  useRealtimeSync("ai_conversations");
  const [hidePreviews, setHidePreviews] = React.useState(true);
  const [open, setOpen] = React.useState<string | null>(null);
  const [transcripts, setTranscripts] = React.useState<Record<string, TranscriptMessage[]>>({});
  const [loading, setLoading] = React.useState<string | null>(null);
  const [toDelete, setToDelete] = React.useState<ConversationRow | null>(null);

  const shown = conversations.filter((c) => !hidePreviews || !c.preview);

  async function toggle(c: ConversationRow) {
    if (open === c.id) return void setOpen(null);
    setOpen(c.id);
    if (transcripts[c.id]) return;
    setLoading(c.id);
    try {
      const res = await loadConversationTranscript(projectId, c.id);
      if (res.ok) setTranscripts((t) => ({ ...t, [c.id]: res.messages }));
      else toast.error(res.error);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          {shown.length} conversation{shown.length === 1 ? "" : "s"} shown, newest first. Costs are the model&apos;s exact usage in USD.
        </p>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={hidePreviews} onChange={(e) => setHidePreviews(e.target.checked)} className="accent-primary-600" />
          Hide previews
        </label>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={<MessagesSquare className="h-6 w-6" />} title="No conversations yet" description="Once the widget is live on the client's site, every chat lands here with its transcript and cost." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          {shown.map((c) => {
            const isOpen = open === c.id;
            const messages = transcripts[c.id];
            return (
              <div key={c.id} className="border-b border-slate-100 last:border-0">
                <button type="button" onClick={() => toggle(c)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-slate-900">{shortDateTime(c.startedAt)}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600">{c.userMessages} message{c.userMessages === 1 ? "" : "s"}</span>
                      {c.pageUrl && (
                        <>
                          <span className="text-slate-400">·</span>
                          <span className="truncate text-slate-500">{hostOf(c.pageUrl)}{(() => { try { return new URL(c.pageUrl).pathname; } catch { return ""; } })()}</span>
                        </>
                      )}
                      {c.country && <span className="text-slate-400">· {c.country}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {c.preview && <Badge className="bg-slate-100 text-slate-500 ring-slate-200"><Eye className="h-3 w-3" /> Preview</Badge>}
                      {c.hasLead && <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200"><UserPlus className="h-3 w-3" /> Lead</Badge>}
                      {c.handoff && <Badge className="bg-amber-50 text-amber-700 ring-amber-200"><Users className="h-3 w-3" /> Hand-off</Badge>}
                      {c.booking && <Badge className="bg-sky-50 text-sky-700 ring-sky-200"><CalendarCheck className="h-3 w-3" /> Booking offered</Badge>}
                    </div>
                  </div>
                  <div className="text-right text-xs text-slate-500">
                    <div className="font-semibold text-slate-900">{usd(c.costUsd)}</div>
                    <div>{compact(c.tokens)} tokens</div>
                  </div>
                  {isOpen ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                </button>
                {isOpen && (
                  <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                    {loading === c.id && !messages && <p className="text-sm text-slate-500">Loading…</p>}
                    {messages && (
                      <div className="space-y-2">
                        {messages.map((m) => (
                          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                            {m.role === "tool" ? (
                              <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
                                ⚙ {m.toolName?.replace(/_/g, " ")}{typeof (m.meta.result as { ok?: boolean })?.ok === "boolean" ? ((m.meta.result as { ok?: boolean }).ok ? " ✓" : " ✗") : ""}
                              </span>
                            ) : (
                              <div className={cn("max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm", m.role === "user" ? "bg-primary-600 text-white" : "bg-white text-slate-800 ring-1 ring-slate-200")}>
                                {m.content}
                              </div>
                            )}
                          </div>
                        ))}
                        {messages.length === 0 && <p className="text-sm text-slate-500">Empty transcript.</p>}
                      </div>
                    )}
                    <div className="mt-3 flex justify-end">
                      <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50" onClick={() => setToDelete(c)}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete transcript
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete this transcript?"
        description="The conversation and its messages are removed. Its cost stays on the ledger and the month's bill is unchanged."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteConversation(projectId, toDelete.id);
          if (res.ok) toast.success("Deleted");
          else toast.error(res.error);
        }}
      />
    </div>
  );
}
