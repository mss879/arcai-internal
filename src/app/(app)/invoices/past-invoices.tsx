"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Ban,
  BadgeCheck,
  Download,
  FileText,
  Mail,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { InvoiceStatus } from "@/lib/database.types";
import { formatCurrency } from "@/lib/utils";
import { lineItemsFromSaved } from "@/lib/invoice";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

import { InvoiceDocument } from "./invoice-generator";
import {
  deleteInvoice,
  markInvoicePaid,
  reissueInvoiceAction,
  voidInvoiceAction,
} from "./actions";

/** 0120 — the invoice's state, which the stamp only decorates. */
const STATUS_META: Record<InvoiceStatus, { label: string; className: string }> = {
  issued: { label: "Issued", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  sent: { label: "Sent", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  partially_paid: { label: "Part-paid", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  paid: { label: "Paid", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  void: { label: "Void", className: "bg-rose-50 text-rose-500 ring-rose-200 line-through" },
};
import { downloadInvoicePdf } from "./download-pdf";
import { ComposeEmailModal } from "@/components/email/compose-email-modal";
import { firstNameOf } from "@/lib/email-templates";
import type { SavedInvoice } from "./invoices-view";

export function PastInvoices({
  invoices,
  page = 1,
  pageCount = 1,
}: {
  invoices: SavedInvoice[];
  /** 0114 — the list is one page of 50; older invoices are a click away. */
  page?: number;
  pageCount?: number;
}) {
  useRealtimeSync("invoices");
  const router = useRouter();
  const [viewing, setViewing] = React.useState<SavedInvoice | null>(null);
  const [toDelete, setToDelete] = React.useState<SavedInvoice | null>(null);
  const [downloading, setDownloading] = React.useState(false);
  const [emailing, setEmailing] = React.useState<SavedInvoice | null>(null);
  // 0120
  const [paying, setPaying] = React.useState<SavedInvoice | null>(null);
  const [voiding, setVoiding] = React.useState<SavedInvoice | null>(null);
  const [reissuing, setReissuing] = React.useState<SavedInvoice | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [payAmount, setPayAmount] = React.useState("");
  const [payDate, setPayDate] = React.useState(format(new Date(), "yyyy-MM-dd"));
  const [payMethod, setPayMethod] = React.useState("");
  const [payNote, setPayNote] = React.useState("");
  const [voidReason, setVoidReason] = React.useState("");

  function openPay(inv: SavedInvoice) {
    const balance = Math.max(0, Number(inv.grand_total) - Number(inv.paid_amount ?? 0));
    setPayAmount(String(balance));
    setPayDate(format(new Date(), "yyyy-MM-dd"));
    setPayMethod("");
    setPayNote("");
    setPaying(inv);
  }

  async function submitPay() {
    if (!paying) return;
    setBusy(true);
    const res = await markInvoicePaid({
      id: paying.id,
      amount: Number(payAmount) || null,
      paid_at: payDate || null,
      method: payMethod || null,
      notes: payNote || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(
        res.status === "paid" ? "Paid in full — the stamp is on." : "Recorded as part-paid.",
      );
      setPaying(null);
      router.refresh();
    } else toast.error(res.error);
  }

  async function submitVoid() {
    if (!voiding) return;
    setBusy(true);
    const res = await voidInvoiceAction(voiding.id, voidReason);
    setBusy(false);
    if (res.ok) {
      toast.success("Voided. The number stays in history.");
      setVoiding(null);
      setVoidReason("");
      router.refresh();
    } else toast.error(res.error);
  }

  async function submitReissue() {
    if (!reissuing) return;
    setBusy(true);
    const res = await reissueInvoiceAction(reissuing.id);
    setBusy(false);
    if (res.ok) {
      toast.success(`Re-issued as ${res.invoiceNumber}. The old one is void.`);
      setReissuing(null);
      router.refresh();
    } else toast.error(res.error);
  }

  if (invoices.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="h-6 w-6" />}
        title="No saved invoices yet"
        description="Create an invoice and click Download — it'll be saved here automatically."
      />
    );
  }

  const handleDelete = async () => {
    if (!toDelete) return;
    const res = await deleteInvoice(toDelete.id);
    if (res.ok) {
      toast.success("Invoice deleted.");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  };

  const handleDownload = async (inv: SavedInvoice) => {
    setDownloading(true);
    try {
      await downloadInvoicePdf({
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        bill_to_name: inv.bill_to_name,
        bill_to_details: inv.bill_to_details || "",
        items: (inv.items ?? []).map((it) => ({
          item: it.item ?? "",
          description: it.description ?? "",
          qty: it.qty ?? "",
          rate: it.rate ?? "",
          total: Number(it.total ?? 0),
        })),
        grand_total: Number(inv.grand_total),
        due_today: Number(inv.due_today),
        amount_paid: Number(inv.amount_paid ?? 0),
        stamp: inv.stamp ?? null,
        bank_account: inv.bank_account ?? null,
        currency: inv.currency ?? null,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't download the PDF.",
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">Invoice</th>
              <th className="px-4 py-3">Bill to</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right">Owed</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr
                key={inv.id}
                className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60"
              >
                <td className="px-4 py-3 font-semibold text-slate-900">
                  <div className="flex items-center gap-2">
                    {inv.invoice_number}
                    {inv.recipient_email && (
                      <span
                        title={`Emailed to ${inv.recipient_email}`}
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                      >
                        <Mail className="h-3 w-3" />
                        Emailed
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {inv.bill_to_name || "—"}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {fmtDate(inv.invoice_date)}
                  {inv.due_date && inv.status !== "paid" && inv.status !== "void" && (
                    <span
                      className={
                        inv.due_date < format(new Date(), "yyyy-MM-dd")
                          ? "block text-[11px] text-rose-500"
                          : "block text-[11px] text-slate-400"
                      }
                    >
                      due {fmtDate(inv.due_date)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {(() => {
                    const meta = STATUS_META[(inv.status ?? "issued") as InvoiceStatus] ?? STATUS_META.issued;
                    return (
                      <Badge className={meta.className} title={inv.void_reason ?? undefined}>
                        {meta.label}
                      </Badge>
                    );
                  })()}
                </td>
                <td className="px-4 py-3 text-right font-medium text-slate-900">
                  {formatCurrency(Number(inv.grand_total), inv.currency ?? "LKR")}
                </td>
                <td className="px-4 py-3 text-right text-slate-600">
                  {inv.status === "void"
                    ? "—"
                    : formatCurrency(
                        Math.max(0, Number(inv.grand_total) - Number(inv.paid_amount ?? 0)),
                        inv.currency ?? "LKR",
                      )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {inv.status !== "paid" && inv.status !== "void" && (
                      <Button size="sm" variant="ghost" onClick={() => openPay(inv)}>
                        <BadgeCheck className="h-4 w-4" />
                        Mark paid
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setViewing(inv)}
                    >
                      <Download className="h-4 w-4" />
                      View
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEmailing(inv)}
                    >
                      <Mail className="h-4 w-4" />
                      Email
                    </Button>
                    {inv.status !== "void" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReissuing(inv)}
                        title="The same bill under a fresh number; this one becomes void"
                      >
                        <RefreshCw className="h-4 w-4" />
                        Re-issue
                      </Button>
                    )}
                    {inv.status !== "void" && inv.status !== "paid" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-rose-600 hover:bg-rose-50"
                        onClick={() => setVoiding(inv)}
                      >
                        <Ban className="h-4 w-4" />
                        Void
                      </Button>
                    )}
                    <button
                      onClick={() => setToDelete(inv)}
                      aria-label="Delete invoice"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            <span>
              Page {page} of {pageCount}
            </span>
            <span className="flex items-center gap-3">
              {page > 1 && (
                <Link
                  href={`/invoices?tab=past&page=${page - 1}`}
                  className="font-medium text-primary-600 hover:underline"
                >
                  ← Newer
                </Link>
              )}
              {page < pageCount && (
                <Link
                  href={`/invoices?tab=past&page=${page + 1}`}
                  className="font-medium text-primary-600 hover:underline"
                >
                  Older →
                </Link>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Email a saved invoice — the SAME PDF the assistant would attach. */}
      <ComposeEmailModal
        open={!!emailing}
        onClose={() => setEmailing(null)}
        title={emailing ? `Email invoice ${emailing.invoice_number}` : "Email invoice"}
        to={emailing?.recipient_email ?? ""}
        subject={emailing ? `Invoice ${emailing.invoice_number} from ARC AI` : ""}
        body={
          emailing
            ? `Hi ${firstNameOf(emailing.bill_to_name) || "there"},\nYour invoice is attached.\nThank you.`
            : ""
        }
        links={{
          clientId: emailing?.client_id ?? null,
          leadId: emailing?.lead_id ?? null,
          projectId: emailing?.project_id ?? null,
        }}
        attachInvoiceId={emailing?.id ?? null}
        attachmentLabel="Invoice attached as a PDF"
        onSent={() => router.refresh()}
      />

      {/* View + re-download a saved invoice */}
      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `Invoice ${viewing.invoice_number}` : ""}
        size="xl"
      >
        {viewing && (
          <div className="space-y-4">
            <div className="no-print flex justify-end">
              <Button
                onClick={() => handleDownload(viewing)}
                loading={downloading}
              >
                <Download className="h-4 w-4" />
                Download PDF
              </Button>
            </div>
            <div className="overflow-x-auto">
              <InvoiceDocument
                invoiceNumber={viewing.invoice_number}
                displayDate={fmtDate(viewing.invoice_date)}
                billToName={viewing.bill_to_name}
                billToLines={(viewing.bill_to_details || "")
                  .split("\n")
                  .filter(Boolean)}
                items={lineItemsFromSaved(viewing.items)}
                grandTotal={Number(viewing.grand_total)}
                amountPaid={Number(viewing.amount_paid ?? 0)}
                dueToday={Number(viewing.due_today)}
                stamp={viewing.stamp}
                bankAccount={viewing.bank_account}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* 0120 — money against a saved invoice */}
      <Modal
        open={!!paying}
        onClose={() => setPaying(null)}
        title={paying ? `Record a payment on ${paying.invoice_number}` : ""}
        description={
          paying
            ? `${formatCurrency(Math.max(0, Number(paying.grand_total) - Number(paying.paid_amount ?? 0)), paying.currency ?? "LKR")} still owed. A partial amount marks it part-paid; the balance marks it paid and puts the stamp on.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setPaying(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitPay} loading={busy} disabled={!Number(payAmount)}>
              <BadgeCheck className="h-4 w-4" /> Record payment
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount received" required>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
            />
          </Field>
          <Field label="Received on">
            <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </Field>
          <Field label="Method">
            <Input
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value)}
              placeholder="Bank transfer, cash, cheque…"
            />
          </Field>
          <Field label="Note">
            <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        {paying?.project_id && (
          <p className="mt-3 text-xs text-slate-400">
            This invoice bills a project: the payment lands on the project&apos;s ledger too, and
            its automations fire once.
          </p>
        )}
      </Modal>

      <Modal
        open={!!voiding}
        onClose={() => setVoiding(null)}
        title={voiding ? `Void ${voiding.invoice_number}` : ""}
        description="Withdraws the invoice. Its number is kept in history and never reused. An invoice with money against it can't be voided — re-issue it instead."
        footer={
          <>
            <Button variant="outline" onClick={() => setVoiding(null)} disabled={busy}>
              Keep it
            </Button>
            <Button onClick={submitVoid} loading={busy} className="bg-rose-600 hover:bg-rose-700">
              <Ban className="h-4 w-4" /> Void invoice
            </Button>
          </>
        }
      >
        <Field label="Why">
          <Textarea
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            rows={3}
            placeholder="Raised in error, wrong client, superseded…"
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={!!reissuing}
        onClose={() => setReissuing(null)}
        onConfirm={submitReissue}
        title={reissuing ? `Re-issue ${reissuing.invoice_number}?` : "Re-issue"}
        description="The same bill is filed under the next number, any payments already recorded move across, and this one is voided as “re-issued”. Edit the new one from Create if the figures need to change."
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete invoice?"
        description={
          toDelete
            ? `Invoice ${toDelete.invoice_number} will be removed from Past invoices. This cannot be undone.`
            : undefined
        }
      />
    </div>
  );
}

function fmtDate(d: string): string {
  if (!d) return "";
  try {
    return format(new Date(d), "dd/MM/yyyy");
  } catch {
    return d;
  }
}
