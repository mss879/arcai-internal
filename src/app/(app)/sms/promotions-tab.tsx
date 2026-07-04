"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Megaphone, Search, Send, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatPhone, normalizePhone } from "@/lib/sms-utils";
import type { Client, SmsMessage } from "@/lib/types";

import { sendPromotionSms } from "./actions";
import { MessageMeta, MessageRow, TokenHints } from "./history-tab";

export function PromotionsTab({
  clients,
  messages,
  smsReady,
}: {
  clients: Client[];
  messages: SmsMessage[];
  smsReady: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [message, setMessage] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Only clients with a usable phone number can receive a promotion.
  const reachable = clients.filter((c) => normalizePhone(c.phone ?? "").ok);
  const unreachable = clients.length - reachable.length;

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? reachable.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          (c.company ?? "").toLowerCase().includes(needle) ||
          (c.city ?? "").toLowerCase().includes(needle),
      )
    : reachable;

  const selected = reachable.filter((c) => selectedIds.has(c.id));
  const allVisibleSelected =
    visible.length > 0 && visible.every((c) => selectedIds.has(c.id));

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((c) => next.delete(c.id));
      else visible.forEach((c) => next.add(c.id));
      return next;
    });
  }

  async function handleSend() {
    setSending(true);
    const res = await sendPromotionSms({
      message,
      recipients: selected.map((c) => ({
        clientId: c.id,
        clientName: c.name,
        phone: c.phone ?? "",
      })),
    });
    setSending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (res.failed === 0) {
      toast.success(`Promotion sent to ${res.sent} client${res.sent === 1 ? "" : "s"}.`);
      setMessage("");
      setSelectedIds(new Set());
    } else {
      toast.warning(
        `Sent ${res.sent}, failed ${res.failed}.${res.firstError ? ` First error: ${res.firstError}` : ""} See History for details.`,
      );
    }
  }

  const recentPromos = messages.filter((m) => m.kind === "promotion").slice(0, 6);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      {/* Recipient picker */}
      <Card className="flex max-h-[640px] flex-col p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Recipients</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {selected.length} of {reachable.length} selected
              {unreachable > 0 && ` · ${unreachable} without a valid phone hidden`}
            </p>
          </div>
          <button
            onClick={toggleAllVisible}
            disabled={visible.length === 0}
            className="shrink-0 text-xs font-semibold text-primary-600 hover:text-primary-700 disabled:opacity-40"
          >
            {allVisibleSelected ? "Clear" : "Select all"}
            {needle && visible.length > 0 ? " (filtered)" : ""}
          </button>
        </div>

        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, company or city…"
            className="pl-9"
          />
        </div>

        <div className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {reachable.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No clients with phone numbers"
              description="Add phone numbers to your clients on the Clients page to send them promotions."
              className="py-10"
            />
          ) : visible.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-slate-400">
              No clients match “{query}”.
            </p>
          ) : (
            visible.map((c) => {
              const checked = selectedIds.has(c.id);
              const phone = normalizePhone(c.phone ?? "");
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    checked
                      ? "border-primary-300 bg-primary-50/60"
                      : "border-transparent hover:bg-slate-50",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors",
                      checked
                        ? "border-primary-600 bg-primary-600 text-white"
                        : "border-slate-300 bg-white",
                    )}
                    aria-hidden
                  >
                    {checked && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {c.name}
                      {c.company && (
                        <span className="font-normal text-slate-400"> — {c.company}</span>
                      )}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {phone.ok ? formatPhone(phone.value) : c.phone}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </Card>

      {/* Composer + recent */}
      <div className="space-y-6">
        <Card className="space-y-5 p-6">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Your offer message
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              One message, sent to everyone selected — {"{{name}}"} becomes each
              client&apos;s first name.
            </p>
          </div>

          <Field label="Message" required>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              placeholder={"Hi {{name}}! This month at ARC AI: 20% off ..."}
            />
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <MessageMeta message={message} clientName={selected[0]?.name ?? ""} />
            <Button
              onClick={() => setConfirmOpen(true)}
              loading={sending}
              disabled={!smsReady || selected.length === 0 || !message.trim()}
            >
              <Send className="h-4 w-4" />
              Send to {selected.length} client{selected.length === 1 ? "" : "s"}
            </Button>
          </div>

          <TokenHints onInsert={(token) => setMessage((m) => `${m}${token}`)} />
        </Card>

        <div className="space-y-3">
          <h2 className="text-base font-semibold text-slate-900">Recent promotions</h2>
          {recentPromos.length === 0 ? (
            <EmptyState
              icon={<Megaphone className="h-6 w-6" />}
              title="No promotions sent yet"
              description="Blasts you send from this tab are logged per recipient here and in History."
            />
          ) : (
            <div className="space-y-2.5">
              {recentPromos.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleSend}
        title={`Send this offer to ${selected.length} client${selected.length === 1 ? "" : "s"}?`}
        description="Each client gets their own personalized SMS. This can't be unsent."
        confirmLabel="Send promotion"
        destructive={false}
      />
    </div>
  );
}
