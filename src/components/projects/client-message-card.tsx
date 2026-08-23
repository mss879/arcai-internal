"use client";

/**
 * Texting the client, from the project (0093).
 *
 * The team already has an SMS page, but getting a message out from there means
 * leaving the project, finding the client, and retyping what the project
 * already knows. This is the same feature where the context is.
 *
 * Every message here is composed and sent by a person. Nothing on this card
 * fires on its own.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import { MessageSquareText, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { SMS_MAX_LENGTH, countSmsSegments } from "@/lib/sms-utils";
import { cn } from "@/lib/utils";

import { messageClient } from "@/app/(app)/projects/client-sms-actions";

export type SentClientMessage = {
  id: string;
  message: string;
  status: string;
  created_at: string;
};

/** Openers for the things a client is most often told mid-project. */
const QUICK: { label: string; text: (project: string) => string }[] = [
  {
    label: "Chasing content",
    text: (p) =>
      `Hi, we're ready to move on with "${p}" — we just need the last few bits from you. Could you send them across when you get a moment?\n— ARC AI`,
  },
  {
    label: "Ready for review",
    text: (p) =>
      `Hi, "${p}" is ready for you to look over. Have a click through and tell us what you'd like changed.\n— ARC AI`,
  },
  {
    label: "Going live",
    text: (p) => `Hi, "${p}" is live. Thank you for your patience!\n— ARC AI`,
  },
];

export function ClientMessageCard({
  projectId,
  projectName,
  clientName,
  clientPhone,
  sent,
}: {
  projectId: string;
  projectName: string;
  clientName: string | null;
  clientPhone: string | null;
  /** The last few texts this project has sent, newest first. */
  sent: SentClientMessage[];
}) {
  const router = useRouter();
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const canSend = Boolean(clientPhone) && message.trim().length > 0;
  const segments = message.trim() ? countSmsSegments(message) : 0;
  const tooLong = message.length > SMS_MAX_LENGTH;

  async function send() {
    setBusy(true);
    const res = await messageClient(projectId, message);
    setBusy(false);
    if (res.ok) {
      setMessage("");
      toast.success("Sent");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-sky-50 text-sky-500">
          <MessageSquareText className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            Text the client
          </h2>
          <p className="truncate text-xs text-slate-400">
            {clientPhone
              ? `${clientName ?? "Client"} · ${clientPhone}`
              : clientName
                ? `${clientName} has no phone number on their record`
                : "No client attached to this project"}
          </p>
        </div>
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => setMessage(q.text(projectName))}
              className="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              {q.label}
            </button>
          ))}
        </div>

        <Textarea
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={`Hi, a quick update on "${projectName}"…`}
          disabled={!clientPhone}
        />

        <div className="flex items-center justify-between gap-3">
          <p
            className={cn(
              "text-xs tabular-nums",
              tooLong ? "font-semibold text-rose-500" : "text-slate-400",
            )}
          >
            {message.length}/{SMS_MAX_LENGTH}
            {segments > 0 && ` · ${segments} segment${segments === 1 ? "" : "s"}`}
          </p>
          <Button size="sm" onClick={send} disabled={!canSend || tooLong} loading={busy}>
            <Send className="h-3.5 w-3.5" /> Send
          </Button>
        </div>
      </div>

      {sent.length > 0 && (
        <div className="border-t border-slate-100 px-5 py-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Already sent
          </h3>
          <ul className="mt-2 space-y-2">
            {sent.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-slate-600">
                  {m.message.length > 110
                    ? `${m.message.slice(0, 107)}…`
                    : m.message}
                </p>
                <div className="shrink-0 text-right">
                  <p className="text-[11px] text-slate-400">
                    {format(new Date(m.created_at), "d MMM")}
                  </p>
                  {m.status !== "sent" && (
                    <Badge className="bg-rose-50 text-rose-600 ring-rose-200">
                      {m.status}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
