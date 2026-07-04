"use client";

import * as React from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { BellRing, FileText, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { INVOICE_COMPANY } from "@/lib/invoice";
import { cn, formatCurrency } from "@/lib/utils";
import type { Client, Invoice, SmsMessage } from "@/lib/types";

import { sendSmsAction } from "./actions";
import { MessageMeta, MessageRow } from "./history-tab";

function reminderTemplate(invoice: Invoice): string {
  const due =
    invoice.due_today > 0 && invoice.due_today < invoice.grand_total
      ? invoice.due_today
      : invoice.grand_total;
  return (
    `Hi {{name}}, a friendly reminder from ${INVOICE_COMPANY.name}: ` +
    `invoice ${invoice.invoice_number} (${formatCurrency(due)}) is pending. ` +
    `Please let us know once the payment is made. Thank you!`
  );
}

/** Best-effort client match for an invoice's "bill to" name. */
function matchClient(clients: Client[], billToName: string): Client | null {
  const needle = billToName.trim().toLowerCase();
  if (!needle) return null;
  return (
    clients.find((c) => c.name.trim().toLowerCase() === needle) ??
    clients.find((c) => (c.company ?? "").trim().toLowerCase() === needle) ??
    clients.find(
      (c) =>
        needle.includes(c.name.trim().toLowerCase()) ||
        c.name.trim().toLowerCase().includes(needle),
    ) ??
    null
  );
}

export function RemindersTab({
  clients,
  invoices,
  messages,
  smsReady,
}: {
  clients: Client[];
  invoices: Invoice[];
  messages: SmsMessage[];
  smsReady: boolean;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const [invoiceId, setInvoiceId] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [sending, setSending] = React.useState(false);

  // "payment_received" means settled in full — those don't need reminders.
  const openInvoices = invoices.filter((i) => i.stamp !== "payment_received");
  const visible = showAll ? invoices : openInvoices;
  const selectedInvoice = invoices.find((i) => i.id === invoiceId) ?? null;
  const selectedClient = clients.find((c) => c.id === clientId) ?? null;
  const sentReminders = messages.filter((m) => m.kind === "payment_reminder").slice(0, 6);

  function pickInvoice(invoice: Invoice) {
    setInvoiceId(invoice.id);
    setMessage(reminderTemplate(invoice));
    const match = matchClient(clients, invoice.bill_to_name);
    setClientId(match?.id ?? "");
    setPhone(match?.phone ?? "");
  }

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
      clientName: selectedClient?.name ?? selectedInvoice?.bill_to_name ?? "",
      kind: "payment_reminder",
      invoiceId: invoiceId || null,
    });
    setSending(false);
    if (res.ok) toast.success("Payment reminder sent.");
    else toast.error(res.error);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">
            {showAll ? "All invoices" : "Awaiting payment"}
          </h2>
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-xs font-semibold text-primary-600 hover:text-primary-700"
          >
            {showAll ? "Show unpaid only" : "Show all"}
          </button>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-6 w-6" />}
            title={showAll ? "No invoices yet" : "Nothing awaiting payment"}
            description="Invoices you save from the Invoices page appear here so you can nudge clients by SMS."
          />
        ) : (
          <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
            {visible.map((invoice) => (
              <button
                key={invoice.id}
                onClick={() => pickInvoice(invoice)}
                className={cn(
                  "w-full rounded-2xl border bg-white p-4 text-left shadow-[var(--shadow-card)] transition-colors",
                  invoiceId === invoice.id
                    ? "border-primary-400 ring-2 ring-primary-100"
                    : "border-slate-200/80 hover:border-slate-300",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-900">
                    {invoice.invoice_number}
                  </span>
                  <span className="text-sm font-semibold text-slate-900">
                    {formatCurrency(invoice.grand_total)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className="truncate text-xs text-slate-500">
                    {invoice.bill_to_name || "—"}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {format(new Date(invoice.invoice_date), "d MMM yyyy")}
                  </span>
                </div>
                {invoice.stamp && (
                  <Badge
                    className={cn(
                      "mt-2",
                      invoice.stamp === "payment_received"
                        ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                        : "bg-amber-50 text-amber-600 ring-amber-200",
                    )}
                  >
                    {invoice.stamp === "payment_received"
                      ? "Paid in full"
                      : "Deposit paid"}
                  </Badge>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-6">
        <Card className="space-y-5 p-6">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Send a payment reminder
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Pick an invoice on the left — we&apos;ll draft the reminder and match
              the client&apos;s number when we can.
            </p>
          </div>

          {selectedInvoice ? (
            <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Reminding about <strong>{selectedInvoice.invoice_number}</strong> —{" "}
              {formatCurrency(selectedInvoice.grand_total)} billed to{" "}
              {selectedInvoice.bill_to_name || "—"}.
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-400">
              No invoice selected yet.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client">
              <Select value={clientId} onChange={(e) => pickClient(e.target.value)}>
                <option value="">No client (manual number)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company ? ` — ${c.company}` : ""}
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

          <Field label="Reminder message" required>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Select an invoice to draft this automatically…"
            />
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <MessageMeta
              message={message}
              clientName={selectedClient?.name ?? selectedInvoice?.bill_to_name ?? ""}
            />
            <Button
              onClick={handleSend}
              loading={sending}
              disabled={!smsReady || !phone.trim() || !message.trim()}
            >
              <Send className="h-4 w-4" />
              Send reminder
            </Button>
          </div>
        </Card>

        <div className="space-y-3">
          <h2 className="text-base font-semibold text-slate-900">Recent reminders</h2>
          {sentReminders.length === 0 ? (
            <EmptyState
              icon={<BellRing className="h-6 w-6" />}
              title="No reminders sent yet"
              description="Reminders you send show up here and in History."
            />
          ) : (
            <div className="space-y-2.5">
              {sentReminders.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
