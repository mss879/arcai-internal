"use client";

/**
 * Additional expenses (0087) — the costs a project picks up after it was
 * quoted, and the button that turns them into an invoice.
 *
 * Each row is a cost incurred against the project: what it was, what it cost,
 * who it was bought from, and whether the client pays for it or the agency
 * absorbs it. "Generate invoice" adds the project's total value to every
 * billable expense that hasn't been invoiced yet, subtracts what the client
 * has already paid, and hands the result to the existing branded invoice
 * template. Whatever goes onto that invoice is stamped as invoiced on the way
 * out, so the same extra cost can't be billed a second time.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  CircleSlash,
  FileText,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  Receipt,
  RotateCcw,
  Trash2,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { STORAGE_BUCKETS } from "@/lib/constants";
import {
  INVOICE_HANDOFF_PARAM,
  INVOICE_HANDOFF_SOURCE_PROJECT,
  stashInvoiceDraft,
} from "@/lib/invoice-handoff";
import { uploadFile } from "@/lib/upload";
import { cn, formatCurrency } from "@/lib/utils";
import type { ProjectExpense } from "@/lib/types";

import {
  deleteProjectExpense,
  saveProjectExpense,
  setProjectExpensesInvoiced,
} from "@/app/(app)/projects/actions";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";

export type ProjectExpenseRow = ProjectExpense & {
  /** Signed link to the supplier receipt, minted server-side. */
  receiptUrl?: string | null;
};

/** Everything the invoice needs to know about money already in. */
export type PaidSummary = {
  /** What we'll pre-fill "already paid" with. */
  total: number;
  /** Plain-English breakdown of that figure, shown under the field. */
  breakdown: string;
  /**
   * Money recorded on the project's own Payments tab. Deliberately NOT part of
   * `total` — the board doesn't count it either, and on most projects it's the
   * internal budget rather than client money. Offered as a one-click add so
   * the call stays with whoever is issuing the invoice.
   */
  otherPayments: { amount: number; count: number } | null;
};

const money = (n: number, currency: string) => formatCurrency(n, currency);

export function ExpensesSection({
  projectId,
  projectName,
  projectDetail,
  currency,
  totalValue,
  paid,
  clientName,
  clientDetails,
  expenses,
}: {
  projectId: string;
  projectName: string;
  /** Printed under the project's own invoice line (service type or blurb). */
  projectDetail: string;
  currency: string;
  totalValue: number;
  paid: PaidSummary;
  clientName: string;
  clientDetails: string;
  expenses: ProjectExpenseRow[];
}) {
  useRealtimeSyncTables(["project_expenses", "projects"]);

  const router = useRouter();
  const [editing, setEditing] = React.useState<ProjectExpenseRow | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<ProjectExpenseRow | null>(null);
  const [invoicing, setInvoicing] = React.useState(false);

  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const billable = expenses.filter((e) => e.billable);
  const unbilled = billable.filter((e) => !e.invoiced_at);
  const unbilledTotal = unbilled.reduce((s, e) => s + Number(e.amount), 0);
  const invoicedTotal = billable
    .filter((e) => e.invoiced_at)
    .reduce((s, e) => s + Number(e.amount), 0);
  const absorbedTotal = expenses
    .filter((e) => !e.billable)
    .reduce((s, e) => s + Number(e.amount), 0);

  const toggleInvoiced = async (row: ProjectExpenseRow) => {
    const res = await setProjectExpensesInvoiced(
      [row.id],
      projectId,
      !row.invoiced_at,
    );
    if (res.ok) {
      toast.success(row.invoiced_at ? "Back on the to-invoice list" : "Marked invoiced");
      router.refresh();
    } else toast.error(res.error);
  };

  const toggleBillable = async (row: ProjectExpenseRow) => {
    const res = await saveProjectExpense({
      id: row.id,
      project_id: projectId,
      description: row.description,
      detail: row.detail,
      category: row.category,
      vendor: row.vendor,
      qty: Number(row.qty),
      unit_amount: Number(row.unit_amount),
      currency: row.currency,
      incurred_on: row.incurred_on,
      billable: !row.billable,
      notes: row.notes,
    });
    if (res.ok) {
      toast.success(row.billable ? "Marked as absorbed" : "Marked billable");
      router.refresh();
    } else toast.error(res.error);
  };

  return (
    <div className="space-y-6">
      {/* Totals ------------------------------------------------ */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Extra costs" value={money(total, currency)} />
        <Tile
          label="To invoice"
          value={money(unbilledTotal, currency)}
          accent="amber"
          hint={`${unbilled.length} item${unbilled.length === 1 ? "" : "s"}`}
        />
        <Tile
          label="Already invoiced"
          value={money(invoicedTotal, currency)}
          accent="emerald"
        />
        <Tile
          label="Absorbed by us"
          value={money(absorbedTotal, currency)}
          hint="Not billed to the client"
        />
      </div>

      <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-500">
              <TrendingUp className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Additional expenses
              </h2>
              <p className="text-xs text-slate-400">
                Costs picked up after the project was quoted — bill them or
                absorb them.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setInvoicing(true)}
            >
              <Receipt className="h-4 w-4" /> Generate invoice
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add expense
            </Button>
          </div>
        </div>

        {expenses.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-sm text-slate-500">No extra costs logged yet.</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
              Anything the project ran up beyond the quote — a licence, a stock
              pack, an extra page, hosting — goes here so it can be invoiced
              later instead of being remembered later.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {expenses.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-start gap-4 px-5 py-3.5 hover:bg-slate-50/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">
                      {e.description}
                    </span>
                    {!e.billable ? (
                      <Badge className="bg-slate-100 text-slate-500 ring-slate-200">
                        Absorbed
                      </Badge>
                    ) : e.invoiced_at ? (
                      <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
                        Invoiced{" "}
                        {format(new Date(e.invoiced_at), "d MMM")}
                      </Badge>
                    ) : (
                      <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                        To invoice
                      </Badge>
                    )}
                  </div>
                  {e.detail && (
                    <p className="mt-0.5 text-sm text-slate-500">{e.detail}</p>
                  )}
                  <p className="mt-0.5 text-xs text-slate-400">
                    {format(new Date(e.incurred_on), "MMM d, yyyy")}
                    {e.vendor ? ` · ${e.vendor}` : ""}
                    {e.category ? ` · ${e.category}` : ""}
                    {Number(e.qty) !== 1
                      ? ` · ${Number(e.qty)} × ${money(Number(e.unit_amount), e.currency)}`
                      : ""}
                    {e.notes ? ` · ${e.notes}` : ""}
                  </p>
                </div>

                <span className="whitespace-nowrap font-semibold text-slate-900">
                  {money(Number(e.amount), e.currency)}
                </span>

                {e.receiptUrl && (
                  <a
                    href={e.receiptUrl}
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
                    icon={<Pencil className="h-4 w-4" />}
                    onClick={() => setEditing(e)}
                  >
                    Edit
                  </DropdownItem>
                  <DropdownItem
                    icon={<CircleSlash className="h-4 w-4" />}
                    onClick={() => toggleBillable(e)}
                  >
                    {e.billable ? "We absorb this" : "Bill this to the client"}
                  </DropdownItem>
                  {e.billable && (
                    <DropdownItem
                      icon={
                        e.invoiced_at ? (
                          <RotateCcw className="h-4 w-4" />
                        ) : (
                          <Receipt className="h-4 w-4" />
                        )
                      }
                      onClick={() => toggleInvoiced(e)}
                    >
                      {e.invoiced_at ? "Not invoiced after all" : "Mark invoiced"}
                    </DropdownItem>
                  )}
                  <DropdownItem
                    destructive
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setToDelete(e)}
                  >
                    Delete
                  </DropdownItem>
                </Dropdown>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ExpenseModal
        open={adding || !!editing}
        projectId={projectId}
        currency={currency}
        expense={editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />

      <GenerateInvoiceModal
        open={invoicing}
        onClose={() => setInvoicing(false)}
        projectId={projectId}
        projectName={projectName}
        projectDetail={projectDetail}
        currency={currency}
        totalValue={totalValue}
        paid={paid}
        clientName={clientName}
        clientDetails={clientDetails}
        candidates={unbilled}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete expense"
        description={`Remove "${toDelete?.description}" from this project?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteProjectExpense(toDelete.id, projectId);
          if (res.ok) {
            toast.success("Expense deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: "amber" | "emerald";
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p
        className={cn(
          "mt-1.5 text-xl font-semibold",
          accent === "amber"
            ? "text-amber-600"
            : accent === "emerald"
              ? "text-emerald-600"
              : "text-slate-900",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add / edit                                                          */
/* ------------------------------------------------------------------ */

function ExpenseModal({
  open,
  projectId,
  currency,
  expense,
  onClose,
}: {
  open: boolean;
  projectId: string;
  currency: string;
  expense: ProjectExpenseRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [detail, setDetail] = React.useState("");
  const [qty, setQty] = React.useState("1");
  const [unitAmount, setUnitAmount] = React.useState("");
  const [incurredOn, setIncurredOn] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [vendor, setVendor] = React.useState("");
  const [billable, setBillable] = React.useState(true);
  const [notes, setNotes] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDescription(expense?.description ?? "");
    setDetail(expense?.detail ?? "");
    setQty(expense ? String(Number(expense.qty)) : "1");
    setUnitAmount(expense ? String(Number(expense.unit_amount)) : "");
    setIncurredOn(
      expense?.incurred_on ?? new Date().toISOString().slice(0, 10),
    );
    setCategory(expense?.category ?? "");
    setVendor(expense?.vendor ?? "");
    setBillable(expense?.billable ?? true);
    setNotes(expense?.notes ?? "");
    setFile(null);
  }, [open, expense]);

  const qtyValue = Number(qty) > 0 ? Number(qty) : 1;
  const unitValue = Number(unitAmount) || 0;
  const lineTotal = Math.round(qtyValue * unitValue * 100) / 100;

  async function submit() {
    if (!description.trim()) {
      toast.error("Describe what the expense was for.");
      return;
    }
    if (unitValue <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    setPending(true);
    try {
      let receipt_path: string | undefined;
      if (file) {
        const { path } = await uploadFile(
          STORAGE_BUCKETS.receipts,
          file,
          projectId,
        );
        receipt_path = path;
      }
      const res = await saveProjectExpense({
        id: expense?.id,
        project_id: projectId,
        description,
        detail,
        category,
        vendor,
        qty: qtyValue,
        unit_amount: unitValue,
        currency,
        incurred_on: incurredOn || null,
        billable,
        notes,
        ...(receipt_path ? { receipt_path } : {}),
      });
      if (res.ok) {
        toast.success(expense ? "Expense updated" : "Expense added");
        router.refresh();
        onClose();
      } else toast.error(res.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={expense ? "Edit expense" : "Add an expense"}
      description="Anything this project cost beyond what it was quoted for."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {expense ? "Save changes" : "Add expense"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="What was it"
          required
          hint="This becomes the invoice line item."
        >
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Extra landing page"
            autoFocus
          />
        </Field>

        <Field
          label="Description"
          hint="Printed under the line item on the invoice."
        >
          <Textarea
            rows={2}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Additional page designed and built after sign-off"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Qty" hint="Leave at 1 for a flat cost.">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </Field>
          <Field label={`Amount each (${currency})`} required>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={unitAmount}
              onChange={(e) => setUnitAmount(e.target.value)}
            />
          </Field>
          <Field label="Date incurred">
            <Input
              type="date"
              value={incurredOn}
              onChange={(e) => setIncurredOn(e.target.value)}
            />
          </Field>
          <Field label="Vendor" hint="Who it was bought from.">
            <Input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="Envato, AWS…"
            />
          </Field>
        </div>

        <Field label="Category" hint="Optional — e.g. Licence, Hosting, Scope.">
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Scope change"
          />
        </Field>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium text-slate-800">
              Bill this to the client
            </span>
            <span className="block text-xs text-slate-500">
              Unticked, it&rsquo;s a cost we absorb — it stays on the record but
              is never offered to an invoice.
            </span>
          </span>
        </label>

        <Field label="Internal notes">
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <Field label="Receipt" hint="Supplier bill — PDF or image, optional.">
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

        {unitValue > 0 && (
          <p className="text-right text-sm text-slate-500">
            Line total{" "}
            <span className="font-semibold text-slate-900">
              {money(lineTotal, currency)}
            </span>
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Generate invoice                                                    */
/* ------------------------------------------------------------------ */

function GenerateInvoiceModal({
  open,
  onClose,
  projectId,
  projectName,
  projectDetail,
  currency,
  totalValue,
  paid,
  clientName,
  clientDetails,
  candidates,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  projectDetail: string;
  currency: string;
  totalValue: number;
  paid: PaidSummary;
  clientName: string;
  clientDetails: string;
  /** Billable expenses that haven't been invoiced yet. */
  candidates: ProjectExpenseRow[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [includeProject, setIncludeProject] = React.useState(totalValue > 0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [paidInput, setPaidInput] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setIncludeProject(totalValue > 0);
    setSelected(new Set(candidates.map((c) => c.id)));
    setPaidInput(String(paid.total));
  }, [open, totalValue, candidates, paid.total]);

  const other = paid.otherPayments;
  const chosen = candidates.filter((c) => selected.has(c.id));
  const extrasTotal = chosen.reduce((s, c) => s + Number(c.amount), 0);
  const invoiceTotal = (includeProject ? totalValue : 0) + extrasTotal;
  const paidValue = Math.max(0, Number(paidInput) || 0);
  const dueNow = Math.max(0, invoiceTotal - paidValue);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function generate() {
    if (invoiceTotal <= 0) {
      toast.error("There's nothing to invoice yet.");
      return;
    }
    setPending(true);

    // Stamp what's going onto the invoice before leaving the page — that stamp
    // is the only thing stopping these costs being billed again next time.
    // Reversible from each row's menu if the invoice is abandoned.
    if (chosen.length > 0) {
      const res = await setProjectExpensesInvoiced(
        chosen.map((c) => c.id),
        projectId,
        true,
      );
      if (!res.ok) {
        toast.error(res.error);
        setPending(false);
        return;
      }
    }

    stashInvoiceDraft({
      billToName: clientName,
      billToDetails: clientDetails,
      items: [
        ...(includeProject && totalValue > 0
          ? [
              {
                item: projectName,
                description: projectDetail,
                total: totalValue,
              },
            ]
          : []),
        ...chosen.map((c) => ({
          item: c.description,
          description: c.detail ?? "",
          total: Number(c.amount),
          ...(Number(c.qty) !== 1
            ? { qty: String(Number(c.qty)), rate: String(Number(c.unit_amount)) }
            : {}),
        })),
      ],
      sourceLabel: projectName,
      sourceKind: "project" as const,
      amountPaid: paidValue,
    });

    router.push(
      `/invoices?${INVOICE_HANDOFF_PARAM}=${INVOICE_HANDOFF_SOURCE_PROJECT}`,
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Generate invoice"
      description="Project total, plus the extras, minus what's already been paid."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={generate} loading={pending} disabled={invoiceTotal <= 0}>
            <Receipt className="h-4 w-4" /> Open in invoice generator
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* The maths, line by line ---------------------------- */}
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 px-4 py-3",
              totalValue > 0 ? "hover:bg-slate-50" : "opacity-60",
            )}
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
              checked={includeProject}
              disabled={totalValue <= 0}
              onChange={(e) => setIncludeProject(e.target.checked)}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-900">
                {projectName}
              </span>
              <span className="block text-xs text-slate-400">
                {totalValue > 0
                  ? "The project's total value"
                  : "No total value set on this project yet"}
              </span>
            </span>
            <span className="whitespace-nowrap text-sm font-semibold text-slate-900">
              {money(totalValue, currency)}
            </span>
          </label>

          {candidates.length === 0 ? (
            <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-400">
              No additional expenses waiting to be invoiced.
            </p>
          ) : (
            candidates.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-start gap-3 border-t border-slate-100 px-4 py-3 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-slate-800">
                    {c.description}
                  </span>
                  <span className="block text-xs text-slate-400">
                    Additional expense ·{" "}
                    {format(new Date(c.incurred_on), "MMM d, yyyy")}
                  </span>
                </span>
                <span className="whitespace-nowrap text-sm font-semibold text-slate-900">
                  {money(Number(c.amount), c.currency)}
                </span>
              </label>
            ))
          )}
        </div>

        <div className="space-y-3 rounded-xl bg-slate-50 p-4">
          <Row label="Invoice total" value={money(invoiceTotal, currency)} bold />
          <div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-slate-500">
                Less: already paid
              </span>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-400">−</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={paidInput}
                  onChange={(e) => setPaidInput(e.target.value)}
                  className="w-40 text-right"
                />
              </div>
            </div>
            <p className="mt-1 text-right text-[11px] text-slate-400">
              {paid.breakdown}
            </p>
            {other && (
              <p className="mt-1 text-right text-[11px] text-slate-400">
                This project also has {other.count} payment
                {other.count === 1 ? "" : "s"} on its Payments tab totalling{" "}
                {money(other.amount, currency)} —{" "}
                <button
                  type="button"
                  className="font-medium text-primary-600 underline-offset-2 hover:underline"
                  onClick={() => setPaidInput(String(paid.total + other.amount))}
                >
                  add them
                </button>{" "}
                if that&rsquo;s client money.
              </p>
            )}
          </div>
          <div className="border-t border-slate-200 pt-3">
            <Row
              label="Balance due now"
              value={money(dueNow, currency)}
              bold
              accent
            />
          </div>
        </div>

        {!clientName.trim() && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700 ring-1 ring-amber-200">
            This project has no client attached, so &ldquo;Bill to&rdquo; will
            open blank — type the customer in on the next screen.
          </p>
        )}
        {currency !== "LKR" && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700 ring-1 ring-amber-200">
            This project is priced in {currency}, but the invoice template
            prints Rs. (LKR). Convert the figures on the next screen before you
            download.
          </p>
        )}
        <p className="text-xs text-slate-400">
          The expenses you tick are marked invoiced as you leave this screen, so
          they can&rsquo;t be billed twice. Undo that from a row&rsquo;s menu if
          you don&rsquo;t end up issuing the invoice. Nothing is filed under
          Past invoices until you hit Download there.
        </p>
      </div>
    </Modal>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: string;
  bold?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className={cn("text-slate-500", bold && "font-medium text-slate-700")}>
        {label}
      </span>
      <span
        className={cn(
          "font-semibold",
          accent ? "text-amber-600" : "text-slate-900",
        )}
      >
        {value}
      </span>
    </div>
  );
}
