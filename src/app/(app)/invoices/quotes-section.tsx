"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  ArrowRight,
  FileSignature,
  Link2,
  Plus,
  Send,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import type { InvoiceItem } from "@/lib/database.types";
import { cn, formatCurrency } from "@/lib/utils";
import type { Quote, QuoteStatus } from "@/lib/types";

import {
  convertQuoteToInvoice,
  deleteQuote,
  saveQuote,
  sendQuote,
  type QuoteInput,
} from "./quote-actions";

const STATUS_META: Record<QuoteStatus, { label: string; badge: string; dot: string }> = {
  draft: { label: "Draft", badge: "bg-slate-100 text-slate-600 ring-slate-200", dot: "bg-slate-400" },
  sent: { label: "Sent", badge: "bg-primary-50 text-primary-600 ring-primary-200", dot: "bg-primary-500" },
  viewed: { label: "Viewed", badge: "bg-amber-50 text-amber-600 ring-amber-200", dot: "bg-amber-500" },
  accepted: { label: "Accepted ✍", badge: "bg-emerald-50 text-emerald-600 ring-emerald-200", dot: "bg-emerald-500" },
  declined: { label: "Declined", badge: "bg-rose-50 text-rose-600 ring-rose-200", dot: "bg-rose-500" },
  expired: { label: "Expired", badge: "bg-slate-100 text-slate-500 ring-slate-200", dot: "bg-slate-300" },
};

export type LeadLite = {
  id: string;
  title: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
};
export type ClientLite = { id: string; name: string; company: string | null; email: string | null; phone: string | null };

export function QuotesSection({
  quotes,
  clients,
  leads,
}: {
  quotes: Quote[];
  clients: ClientLite[];
  leads: LeadLite[];
}) {
  useRealtimeSync("quotes");
  const [editing, setEditing] = React.useState<Quote | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Quote | null>(null);

  const accepted = quotes.filter((q) => q.status === "accepted");
  const awaiting = quotes.filter((q) => ["sent", "viewed"].includes(q.status));
  const acceptedValue = accepted.reduce((s, q) => s + Number(q.grand_total), 0);

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteQuote(toDelete.id);
    if (res.ok) toast.success("Quote deleted.");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Quotes</h2>
          <p className="text-sm text-slate-500">
            Build a quotation, send the link, client accepts and e-signs — then
            convert it to an invoice in one click.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New quote
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Awaiting response" value={String(awaiting.length)} />
        <StatCard label="Accepted" value={String(accepted.length)} />
        <StatCard label="Accepted value" value={formatCurrency(acceptedValue)} />
      </div>

      {quotes.length === 0 ? (
        <EmptyState
          icon={<FileSignature className="h-6 w-6" />}
          title="No quotes yet"
          description="Create a quote from a CRM lead or from scratch. Clients accept and sign online — no more PDF ping-pong."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Create your first quote
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {quotes.map((quote) => (
            <QuoteRow
              key={quote.id}
              quote={quote}
              onEdit={() => setEditing(quote)}
              onDelete={() => setToDelete(quote)}
            />
          ))}
        </div>
      )}

      <QuoteEditor
        open={creating || editing !== null}
        quote={editing}
        clients={clients}
        leads={leads}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title={toDelete ? `Delete quote ${toDelete.quote_number}?` : ""}
        description="The share link stops working immediately. This cannot be undone."
      />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

function QuoteRow({
  quote,
  onEdit,
  onDelete,
}: {
  quote: Quote;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = STATUS_META[quote.status];
  const [sending, setSending] = React.useState(false);
  const [converting, setConverting] = React.useState(false);
  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/q/${quote.share_token}`
      : `/q/${quote.share_token}`;

  async function handleSend() {
    setSending(true);
    const res = await sendQuote(quote.id, shareUrl);
    setSending(false);
    if (res.ok) {
      toast.success(
        res.emailed
          ? "Quote emailed to the client with the accept link."
          : "Marked as sent — share the link manually (no email on file or Resend not set up).",
      );
    } else toast.error(res.error);
  }

  async function handleConvert() {
    setConverting(true);
    const res = await convertQuoteToInvoice(quote.id);
    setConverting(false);
    if (res.ok) toast.success("Invoice created — see the Past invoices tab.");
    else toast.error(res.error);
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-[var(--shadow-card)]">
      <Badge className={meta.badge} dot={meta.dot}>
        {meta.label}
      </Badge>
      <button onClick={onEdit} className="text-left">
        <span className="text-sm font-semibold text-slate-900 hover:text-primary-600">
          {quote.quote_number}
        </span>
        <span className="ml-2 text-sm text-slate-600">
          {quote.title || quote.customer_name}
        </span>
      </button>
      <span className="text-xs text-slate-400">
        · {quote.customer_name} · {formatCurrency(Number(quote.grand_total), quote.currency)}
      </span>
      {quote.accepted_at && quote.signed_name && (
        <span className="text-xs text-emerald-600">
          · signed by {quote.signed_name}{" "}
          {formatDistanceToNow(new Date(quote.accepted_at), { addSuffix: true })}
        </span>
      )}
      {quote.declined_reason && (
        <span className="text-xs text-rose-500">· “{quote.declined_reason}”</span>
      )}
      <span className="ml-auto flex items-center gap-1">
        <CopyButton value={shareUrl} label="Copy share link" />
        <a
          href={`/q/${quote.share_token}`}
          target="_blank"
          rel="noreferrer"
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          aria-label="Open public page"
        >
          <Link2 className="h-4 w-4" />
        </a>
        {["draft", "sent", "viewed"].includes(quote.status) && (
          <Button variant="outline" size="sm" onClick={handleSend} loading={sending}>
            <Send className="h-3.5 w-3.5" />
            {quote.status === "draft" ? "Send" : "Resend"}
          </Button>
        )}
        {quote.status === "accepted" && !quote.invoice_id && (
          <Button size="sm" onClick={handleConvert} loading={converting}>
            <ArrowRight className="h-3.5 w-3.5" />
            To invoice
          </Button>
        )}
        {quote.invoice_id && (
          <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">Invoiced</Badge>
        )}
        <button
          onClick={onDelete}
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
          aria-label="Delete quote"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </span>
    </div>
  );
}

// ---- Editor -----------------------------------------------------------------

type DraftItem = { key: string; item: string; description: string; qty: string; rate: string };

function itemTotal(d: DraftItem): number {
  const qty = d.qty.trim() === "" ? 1 : Number(d.qty) || 0;
  return qty * (Number(d.rate) || 0);
}

function QuoteEditor({
  open,
  quote,
  clients,
  leads,
  onClose,
}: {
  open: boolean;
  quote: Quote | null;
  clients: ClientLite[];
  leads: LeadLite[];
  onClose: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const [customerPhone, setCustomerPhone] = React.useState("");
  const [leadId, setLeadId] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [items, setItems] = React.useState<DraftItem[]>([]);
  const [discount, setDiscount] = React.useState("0");
  const [taxRate, setTaxRate] = React.useState("0");
  const [validUntil, setValidUntil] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [terms, setTerms] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setTitle(quote?.title ?? "");
    setCustomerName(quote?.customer_name ?? "");
    setCustomerEmail(quote?.customer_email ?? "");
    setCustomerPhone(quote?.customer_phone ?? "");
    setLeadId(quote?.lead_id ?? "");
    setClientId(quote?.client_id ?? "");
    setItems(
      (quote?.items ?? []).map((it, i) => ({
        key: `${i}-${Math.random().toString(36).slice(2, 8)}`,
        item: it.item,
        description: it.description,
        qty: it.qty,
        rate: it.rate,
      })),
    );
    setDiscount(String(quote?.discount ?? 0));
    setTaxRate(String(quote?.tax_rate ?? 0));
    setValidUntil(quote?.valid_until ?? "");
    setNotes(quote?.notes ?? "");
    setTerms(quote?.terms ?? "");
  }, [open, quote]);

  function pickLead(id: string) {
    setLeadId(id);
    const lead = leads.find((l) => l.id === id);
    if (lead) {
      if (!title) setTitle(lead.title);
      if (lead.contact_name) setCustomerName(lead.contact_name);
      if (lead.contact_email) setCustomerEmail(lead.contact_email);
      if (lead.contact_phone) setCustomerPhone(lead.contact_phone);
    }
  }

  function pickClient(id: string) {
    setClientId(id);
    const client = clients.find((c) => c.id === id);
    if (client) {
      setCustomerName(client.name);
      if (client.email) setCustomerEmail(client.email);
      if (client.phone) setCustomerPhone(client.phone);
    }
  }

  const subtotal = items.reduce((s, d) => s + itemTotal(d), 0);
  const discounted = Math.max(0, subtotal - (Number(discount) || 0));
  const tax = (discounted * (Number(taxRate) || 0)) / 100;
  const grandTotal = discounted + tax;

  async function handleSave() {
    setSaving(true);
    const input: QuoteInput = {
      id: quote?.id,
      title,
      customer_name: customerName,
      customer_email: customerEmail || null,
      customer_phone: customerPhone || null,
      lead_id: leadId || null,
      client_id: clientId || null,
      items: items.map(
        (d): InvoiceItem => ({
          item: d.item,
          description: d.description,
          qty: d.qty,
          rate: d.rate,
          total: itemTotal(d),
        }),
      ),
      discount: Number(discount) || 0,
      tax_rate: Number(taxRate) || 0,
      currency: "LKR",
      valid_until: validUntil || null,
      notes: notes || null,
      terms: terms || null,
    };
    const res = await saveQuote(input);
    setSaving(false);
    if (res.ok) {
      toast.success(quote ? "Quote updated." : `Quote ${res.quote.quote_number} created.`);
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={quote ? `Edit ${quote.quote_number}` : "New quote"}
      size="xl"
      footer={
        <>
          <div className="mr-auto text-sm">
            <span className="text-slate-400">Total: </span>
            <span className="font-bold text-slate-900">{formatCurrency(grandTotal)}</span>
          </div>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!customerName.trim() || items.length === 0}>
            {quote ? "Save changes" : "Create quote"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From CRM lead" hint="Optional — fills contact details.">
            <Select value={leadId} onChange={(e) => pickLead(e.target.value)}>
              <option value="">No linked lead</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Or client">
            <Select value={clientId} onChange={(e) => pickClient(e.target.value)}>
              <option value="">No linked client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` — ${c.company}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Quote title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Business website + 3 months marketing"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Customer name" required>
            <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </Field>
          <Field label="Email" hint="Needed to email the accept link.">
            <Input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} type="email" />
          </Field>
          <Field label="Phone">
            <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} inputMode="tel" />
          </Field>
        </div>

        {/* Line items */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Line items</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setItems((prev) => [
                  ...prev,
                  {
                    key: crypto.randomUUID(),
                    item: "",
                    description: "",
                    qty: "1",
                    rate: "",
                  },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" />
              Add item
            </Button>
          </div>
          {items.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-sm text-slate-400">
              No items yet — add your first line item.
            </p>
          )}
          {items.map((d, i) => (
            <div
              key={d.key}
              className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3 sm:grid-cols-[2fr_1fr_1fr_auto_auto]"
            >
              <div className="space-y-1.5">
                <Input
                  value={d.item}
                  onChange={(e) =>
                    setItems((prev) => prev.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))
                  }
                  placeholder="Item, e.g. E-commerce website"
                />
                <Input
                  value={d.description}
                  onChange={(e) =>
                    setItems((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                    )
                  }
                  placeholder="Description (optional)"
                />
              </div>
              <Input
                value={d.qty}
                onChange={(e) =>
                  setItems((prev) => prev.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))
                }
                placeholder="Qty"
                inputMode="numeric"
              />
              <Input
                value={d.rate}
                onChange={(e) =>
                  setItems((prev) => prev.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))
                }
                placeholder="Rate"
                inputMode="decimal"
              />
              <div className="self-center text-sm font-semibold text-slate-700">
                {formatCurrency(itemTotal(d))}
              </div>
              <button
                onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                className="grid h-8 w-8 place-items-center self-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                aria-label="Remove item"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Discount (Rs.)">
            <Input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Tax / VAT %">
            <Input value={taxRate} onChange={(e) => setTaxRate(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Valid until">
            <Input value={validUntil} onChange={(e) => setValidUntil(e.target.value)} type="date" />
          </Field>
        </div>

        <div
          className={cn(
            "rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-sm",
            "flex flex-wrap items-center gap-x-6 gap-y-1",
          )}
        >
          <span className="text-slate-500">
            Subtotal <strong className="text-slate-800">{formatCurrency(subtotal)}</strong>
          </span>
          {Number(discount) > 0 && (
            <span className="text-slate-500">
              Discount <strong className="text-slate-800">-{formatCurrency(Number(discount))}</strong>
            </span>
          )}
          {Number(taxRate) > 0 && (
            <span className="text-slate-500">
              Tax <strong className="text-slate-800">{formatCurrency(tax)}</strong>
            </span>
          )}
          <span className="ml-auto text-slate-500">
            Grand total <strong className="text-base text-slate-900">{formatCurrency(grandTotal)}</strong>
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Notes to customer">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>
          <Field label="Terms">
            <Textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={2}
              placeholder="e.g. 50% advance, balance on delivery."
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
