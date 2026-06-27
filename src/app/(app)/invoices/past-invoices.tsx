"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Download, FileText, Mail, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { lineItemsFromSaved } from "@/lib/invoice";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

import { InvoiceDocument } from "./invoice-generator";
import { deleteInvoice } from "./actions";
import { downloadInvoicePdf } from "./download-pdf";
import type { SavedInvoice } from "./invoices-view";

export function PastInvoices({ invoices }: { invoices: SavedInvoice[] }) {
  useRealtimeSync("invoices");
  const router = useRouter();
  const [viewing, setViewing] = React.useState<SavedInvoice | null>(null);
  const [toDelete, setToDelete] = React.useState<SavedInvoice | null>(null);
  const [downloading, setDownloading] = React.useState(false);

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
        stamp: inv.stamp ?? null,
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
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right">Due today</th>
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
                </td>
                <td className="px-4 py-3 text-right font-medium text-slate-900">
                  {formatCurrency(Number(inv.grand_total))}
                </td>
                <td className="px-4 py-3 text-right text-slate-600">
                  {formatCurrency(Number(inv.due_today))}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setViewing(inv)}
                    >
                      <Download className="h-4 w-4" />
                      View
                    </Button>
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
      </div>

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
                dueToday={Number(viewing.due_today)}
                stamp={viewing.stamp}
              />
            </div>
          </div>
        )}
      </Modal>

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
