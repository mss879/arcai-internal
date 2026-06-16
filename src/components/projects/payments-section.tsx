"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  FileText,
  MoreVertical,
  Paperclip,
  Plus,
  Receipt,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PAYMENT_STATUS_META } from "@/lib/constants";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { uploadFile } from "@/lib/upload";
import { formatCurrency } from "@/lib/utils";
import type { Payment, PaymentStatus } from "@/lib/types";

import { deletePayment, savePayment } from "@/app/(app)/projects/actions";

export type PaymentRow = Payment & { receiptUrl?: string | null };

export function PaymentsSection({
  projectId,
  currency,
  payments,
}: {
  projectId: string;
  currency: string;
  payments: PaymentRow[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Payment | null>(null);

  const total = payments
    .filter((p) => p.status === "paid")
    .reduce((s, p) => s + Number(p.amount), 0);

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-500">
            <Receipt className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Payments</h2>
            <p className="text-xs text-slate-400">
              {formatCurrency(total, currency)} received
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add payment
        </Button>
      </div>

      {payments.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-400">
          No payments recorded yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-50">
          {payments.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50/60"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900">
                    {formatCurrency(Number(p.amount), p.currency)}
                  </span>
                  <Badge className={PAYMENT_STATUS_META[p.status].badge}>
                    {PAYMENT_STATUS_META[p.status].label}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-slate-400">
                  {p.paid_at
                    ? format(new Date(p.paid_at), "MMM d, yyyy")
                    : "No date"}
                  {p.method ? ` · ${p.method}` : ""}
                  {p.notes ? ` · ${p.notes}` : ""}
                </p>
              </div>
              {p.receiptUrl && (
                <a
                  href={p.receiptUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200"
                >
                  <FileText className="h-3.5 w-3.5" /> Receipt
                </a>
              )}
              <Dropdown
                trigger={
                  <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                    <MoreVertical className="h-4 w-4" />
                  </button>
                }
              >
                <DropdownItem
                  destructive
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => setToDelete(p)}
                >
                  Delete
                </DropdownItem>
              </Dropdown>
            </li>
          ))}
        </ul>
      )}

      <PaymentModal
        open={adding}
        projectId={projectId}
        currency={currency}
        onClose={() => setAdding(false)}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete payment"
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deletePayment(toDelete.id, projectId);
          if (res.ok) {
            toast.success("Payment deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </section>
  );
}

function PaymentModal({
  open,
  projectId,
  currency,
  onClose,
}: {
  open: boolean;
  projectId: string;
  currency: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [status, setStatus] = React.useState<PaymentStatus>("paid");
  const [paidAt, setPaidAt] = React.useState(
    new Date().toISOString().slice(0, 10),
  );
  const [method, setMethod] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);

  React.useEffect(() => {
    if (open) {
      setAmount("");
      setStatus("paid");
      setPaidAt(new Date().toISOString().slice(0, 10));
      setMethod("");
      setNotes("");
      setFile(null);
    }
  }, [open]);

  async function submit() {
    if (!amount || Number(amount) <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    setPending(true);
    try {
      let receipt_path: string | null = null;
      if (file) {
        const { path } = await uploadFile(
          STORAGE_BUCKETS.receipts,
          file,
          projectId,
        );
        receipt_path = path;
      }
      const res = await savePayment({
        project_id: projectId,
        amount: Number(amount),
        currency,
        status,
        paid_at: paidAt || null,
        method,
        notes,
        receipt_path,
      });
      if (res.ok) {
        toast.success("Payment added");
        router.refresh();
        onClose();
      } else toast.error(res.error);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add payment"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Add payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" required>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Status">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as PaymentStatus)}
            >
              <option value="paid">Paid</option>
              <option value="pending">Pending</option>
              <option value="overdue">Overdue</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
            />
          </Field>
          <Field label="Method">
            <Input
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              placeholder="Bank, Card…"
            />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <Field label="Receipt" hint="PDF or image, optional.">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-slate-300 px-3.5 py-3 text-sm text-slate-500 hover:border-primary-300 hover:bg-primary-50/40">
            <Paperclip className="h-4 w-4" />
            {file ? file.name : "Attach a receipt"}
            <input
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </Field>
      </div>
    </Modal>
  );
}
