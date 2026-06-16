"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Building2,
  CreditCard,
  MoreVertical,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import type { CompanyPayment, MemberLite } from "@/lib/types";

import { createCompanyPayment, deleteCompanyPayment } from "./actions";

type PaymentWithCreator = CompanyPayment & {
  creator?: Pick<MemberLite, "full_name" | "username" | "avatar_url"> | null;
};

export function PaymentsView({
  payments,
}: {
  payments: PaymentWithCreator[];
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<CompanyPayment | null>(null);

  const filtered = payments.filter((p) => {
    const q = query.toLowerCase();
    return !q || p.company_name.toLowerCase().includes(q);
  });

  function formatLKR(amount: number) {
    return "Rs. " + amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Record and manage shared workspace payments in Sri Lankan Rupees (LKR)."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Record payment
          </Button>
        }
      />

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by company name…"
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="h-6 w-6" />}
          title={query ? "No matching payments" : "No payments yet"}
          description={
            query
              ? "Try a different search term."
              : "Record your first company payment to get started."
          }
          action={
            !query && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> Record payment
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3.5 font-semibold">Company Name</th>
                <th className="px-5 py-3.5 font-semibold">Price (LKR)</th>
                <th className="px-5 py-3.5 font-semibold">Recorded By</th>
                <th className="px-5 py-3.5 font-semibold">Date</th>
                <th className="px-5 py-3.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map((p) => (
                <tr key={p.id} className="group hover:bg-slate-50/60">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-50 text-emerald-600">
                        <Building2 className="h-4 w-4" />
                      </span>
                      <span className="font-medium text-slate-900">{p.company_name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 font-semibold text-slate-900">
                    {formatLKR(Number(p.price_lkr))}
                  </td>
                  <td className="px-5 py-3.5">
                    {p.creator ? (
                      <div className="flex items-center gap-2">
                        <Avatar
                          name={p.creator.full_name}
                          src={p.creator.avatar_url}
                          size="xs"
                        />
                        <span className="text-xs text-slate-600">{p.creator.full_name}</span>
                      </div>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-slate-500">
                    {new Date(p.created_at).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <Dropdown
                      trigger={
                        <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PaymentFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => router.refresh()}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete payment record"
        description={`Remove the payment of ${toDelete ? formatLKR(Number(toDelete.price_lkr)) : ""} for ${toDelete?.company_name}? This cannot be undone.`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteCompanyPayment(toDelete.id);
          if (res.ok) {
            toast.success("Payment record deleted");
            router.refresh();
          } else {
            toast.error(res.error);
          }
          setToDelete(null);
        }}
      />
    </div>
  );
}

function PaymentFormModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [companyName, setCompanyName] = React.useState("");
  const [priceLkr, setPriceLkr] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setCompanyName("");
      setPriceLkr("");
    }
  }, [open]);

  function submit() {
    if (!companyName.trim()) {
      toast.error("Please enter a company name.");
      return;
    }
    const parsedPrice = parseFloat(priceLkr);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      toast.error("Please enter a valid positive price.");
      return;
    }

    startTransition(async () => {
      const res = await createCompanyPayment({
        company_name: companyName,
        price_lkr: parsedPrice,
      });
      if (res.ok) {
        toast.success("Payment recorded successfully");
        onSaved();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record Payment"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Record Payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Company Name" required>
          <Input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Enter company name"
            autoFocus
          />
        </Field>
        <Field label="Price (LKR)" required hint="Price in Sri Lankan Rupees (Rs.)">
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400">
              Rs.
            </span>
            <Input
              type="number"
              min="0"
              step="any"
              value={priceLkr}
              onChange={(e) => setPriceLkr(e.target.value)}
              placeholder="0.00"
              className="pl-10"
            />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
