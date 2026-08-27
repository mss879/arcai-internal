"use client";

/**
 * The approvals tray (0103) — where a mission's prepared messages wait.
 *
 * A confirm card in the transcript works because someone is looking at it. A
 * mission running on a cron has nobody watching, so the cards it prepares are
 * persisted instead and collected here, behind a badge that says how many
 * things need a decision.
 *
 * The important part is what this component does NOT change: each approval
 * renders through the same `AssistantCardView` the conversation uses, and its
 * Send button calls the same `/api/assistant/send-*` routes with the user's
 * own session. Parking a card changes WHERE it waits, never how it is sent —
 * so "nothing leaves the building without the user" holds for a mission that
 * ran at three in the morning exactly as it does for a card on screen.
 */

import * as React from "react";
import { Inbox, Loader2, X } from "lucide-react";

import { AssistantCardView } from "@/components/assistant/assistant-card";
import type {
  SendInvoiceResult,
  VoiceChat,
} from "@/components/assistant/use-voice-chat";
import type { AssistantCard } from "@/lib/assistant-cards";
import { useArcusRealtime } from "@/components/assistant/use-arcus-realtime";
import { cn } from "@/lib/utils";

type Approval = {
  id: string;
  kind: "invoice_email" | "sms";
  card: AssistantCard;
  mission_id: string | null;
  created_at: string;
};

export function ApprovalsTray({
  chat,
  className,
}: {
  chat: VoiceChat;
  className?: string;
}) {
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/approvals", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { approvals?: Approval[] };
      setApprovals(data.approvals ?? []);
    } catch {
      // Offline, or migration 0103 not run yet — an empty tray is correct.
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Realtime, so a mission that finishes while the panel is open raises the
  // badge without anyone reloading.
  useArcusRealtime("assistant_approvals", load);

  /** Record the outcome after the card's own Send has run. */
  const record = React.useCallback(
    async (id: string, status: "sent" | "declined" | "failed", error?: string) => {
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      try {
        await fetch("/api/assistant/approvals", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status, error }),
        });
      } catch {
        // The send already happened; failing to record it just means the row
        // reappears on the next load, which is the safe direction.
      }
    },
    [],
  );

  if (!approvals.length && !open) {
    return null;
  }

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${approvals.length} waiting for your OK`}
        className="relative grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        <Inbox className="h-4 w-4" />
        {approvals.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
            {approvals.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-[340px] rounded-2xl border border-slate-200 bg-white p-3 shadow-lift">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">
              Waiting for your OK
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : approvals.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              Nothing waiting. Arcus hasn&apos;t prepared anything to send.
            </p>
          ) : (
            <div className="max-h-[420px] space-y-3 overflow-y-auto">
              {approvals.map((approval) => (
                <div key={approval.id} className="space-y-1.5">
                  <AssistantCardView
                    card={approval.card}
                    // Same routes the transcript uses; the tray only records
                    // what happened afterwards.
                    onSend={async (invoiceId, emails, message) => {
                      const res = await chat.sendInvoice(invoiceId, emails, message);
                      await record(
                        approval.id,
                        res.ok ? "sent" : "failed",
                        res.error,
                      );
                      return res;
                    }}
                    onSendSms={async (sms) => {
                      const res = await chat.sendSms(sms);
                      await record(
                        approval.id,
                        res.ok ? "sent" : "failed",
                        res.error,
                      );
                      return res;
                    }}
                    onApproveMission={chat.approveMission}
                  />
                  <button
                    type="button"
                    onClick={() => void record(approval.id, "declined")}
                    className="ml-1 text-xs font-medium text-slate-400 transition hover:text-rose-600"
                  >
                    Don&apos;t send this
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type { SendInvoiceResult };
