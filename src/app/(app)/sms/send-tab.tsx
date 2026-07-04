"use client";

import * as React from "react";
import { toast } from "sonner";
import { MessageSquareText, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import type { Client, SmsMessage } from "@/lib/types";

import { sendSmsAction } from "./actions";
import { MessageMeta, MessageRow, TokenHints } from "./history-tab";

export function SendTab({
  clients,
  messages,
  smsReady,
}: {
  clients: Client[];
  messages: SmsMessage[];
  smsReady: boolean;
}) {
  const [clientId, setClientId] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [sending, setSending] = React.useState(false);

  const selectedClient = clients.find((c) => c.id === clientId) ?? null;
  const recent = messages.filter((m) => m.kind === "custom").slice(0, 8);

  function pickClient(id: string) {
    setClientId(id);
    const client = clients.find((c) => c.id === id);
    if (client?.phone) setPhone(client.phone);
  }

  async function handleSend() {
    setSending(true);
    const res = await sendSmsAction({
      phone,
      message,
      clientId: clientId || null,
      clientName: selectedClient?.name ?? "",
      kind: "custom",
    });
    setSending(false);
    if (res.ok) {
      toast.success("SMS sent.");
      setMessage("");
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card className="space-y-5 p-6">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Compose a message
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Pick a client to autofill their number, or type any Sri Lankan
            mobile number.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client" hint="Optional — used for {{name}} tokens.">
            <Select value={clientId} onChange={(e) => pickClient(e.target.value)}>
              <option value="">No client (manual number)</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` — ${c.company}` : ""}
                  {c.phone ? "" : " (no phone saved)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Phone number" required hint="e.g. 0712345678 or 94712345678">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="07X XXX XXXX"
              inputMode="tel"
            />
          </Field>
        </div>

        <Field label="Message" required>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            placeholder={"Hi {{name}}, ..."}
          />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <MessageMeta message={message} clientName={selectedClient?.name ?? ""} />
          <Button
            onClick={handleSend}
            loading={sending}
            disabled={!smsReady || !phone.trim() || !message.trim()}
          >
            <Send className="h-4 w-4" />
            Send SMS
          </Button>
        </div>

        <TokenHints onInsert={(token) => setMessage((m) => `${m}${token}`)} />
      </Card>

      <div className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900">Recent custom messages</h2>
        {recent.length === 0 ? (
          <EmptyState
            icon={<MessageSquareText className="h-6 w-6" />}
            title="Nothing sent yet"
            description="Messages you send from this tab will show up here (and in History)."
          />
        ) : (
          <div className="space-y-2.5">
            {recent.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
