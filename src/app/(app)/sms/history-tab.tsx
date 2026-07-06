"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { History, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
  SMS_MAX_LENGTH,
  SMS_TOKENS,
  countSmsSegments,
  formatPhone,
  isUnicodeMessage,
  personalizeMessage,
} from "@/lib/sms-utils";
import type { SmsKind, SmsMessage } from "@/lib/types";

import { deleteSmsMessage } from "./actions";

const KIND_META: Record<SmsKind, { label: string; badge: string }> = {
  custom: { label: "Custom", badge: "bg-primary-50 text-primary-600 ring-primary-200" },
  payment_reminder: {
    label: "Payment reminder",
    badge: "bg-amber-50 text-amber-600 ring-amber-200",
  },
  automation: {
    label: "Automation",
    badge: "bg-violet-50 text-violet-600 ring-violet-200",
  },
  promotion: {
    label: "Promotion",
    badge: "bg-cyan-50 text-cyan-600 ring-cyan-200",
  },
  todo_reminder: {
    label: "Task reminder",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
};

type Filter = "all" | SmsKind | "failed";

export function HistoryTab({ messages }: { messages: SmsMessage[] }) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [toDelete, setToDelete] = React.useState<SmsMessage | null>(null);

  const filtered = messages.filter((m) => {
    if (filter === "all") return true;
    if (filter === "failed") return m.status === "failed";
    return m.kind === filter;
  });

  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "custom", label: "Custom" },
    { value: "payment_reminder", label: "Reminders" },
    { value: "todo_reminder", label: "Task reminders" },
    { value: "promotion", label: "Promotions" },
    { value: "automation", label: "Automation" },
    { value: "failed", label: "Failed" },
  ];

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteSmsMessage(toDelete.id);
    if (res.ok) toast.success("Message removed from the log.");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
              filter === f.value
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<History className="h-6 w-6" />}
          title="No messages here"
          description="Every SMS the app sends — custom, reminder or automation — is logged on this tab."
        />
      ) : (
        <div className="space-y-2.5">
          {filtered.map((m) => (
            <MessageRow key={m.id} message={m} onDelete={() => setToDelete(m)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Remove from log?"
        description="This only deletes the log entry — the SMS itself was already sent."
        confirmLabel="Remove"
      />
    </div>
  );
}

/** One logged SMS. Shared by the Send / Reminders / History tabs. */
export function MessageRow({
  message,
  onDelete,
}: {
  message: SmsMessage;
  onDelete?: () => void;
}) {
  const kind = KIND_META[message.kind];
  const failed = message.status === "failed";

  return (
    <div className="group rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className={
            failed
              ? "bg-rose-50 text-rose-600 ring-rose-200"
              : "bg-emerald-50 text-emerald-600 ring-emerald-200"
          }
          dot={failed ? "bg-rose-500" : "bg-emerald-500"}
        >
          {failed ? "Failed" : "Sent"}
        </Badge>
        <Badge className={kind.badge}>{kind.label}</Badge>
        <span className="text-xs font-medium text-slate-500">
          {message.client_name ? `${message.client_name} · ` : ""}
          {formatPhone(message.to_number)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          {formatDistanceToNow(new Date(message.created_at), { addSuffix: true })}
          {onDelete && (
            <button
              onClick={onDelete}
              className="rounded-md p-1 text-slate-300 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
              aria-label="Remove log entry"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
        {message.message}
      </p>
      {failed && message.error && (
        <p className="mt-1.5 text-xs text-rose-500">{message.error}</p>
      )}
    </div>
  );
}

/** Live character / segment counter under a composer. */
export function MessageMeta({
  message,
  clientName,
}: {
  message: string;
  clientName?: string;
}) {
  const resolved = personalizeMessage(message, clientName ?? "");
  const over = resolved.length > SMS_MAX_LENGTH;
  return (
    <p className={cn("text-xs", over ? "font-semibold text-rose-500" : "text-slate-400")}>
      {resolved.length} / {SMS_MAX_LENGTH} characters
      {resolved.length > 0 && <> · {countSmsSegments(resolved)} segment{countSmsSegments(resolved) === 1 ? "" : "s"}</>}
      {resolved.length > 0 && isUnicodeMessage(resolved) && <> · unicode</>}
    </p>
  );
}

/** Clickable {{token}} chips for personalization. */
export function TokenHints({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-4 text-xs text-slate-400">
      Personalize:
      {SMS_TOKENS.map((t) => (
        <button
          key={t.token}
          type="button"
          onClick={() => onInsert(t.token)}
          className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 transition-colors hover:bg-slate-200"
          title={t.label}
        >
          {t.token}
        </button>
      ))}
    </div>
  );
}
