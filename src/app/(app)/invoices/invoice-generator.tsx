"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Plus, Trash2, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn, formatCurrency } from "@/lib/utils";
import {
  INVOICE_COMPANY,
  INVOICE_BANK,
  INVOICE_SIGNOFF,
  INVOICE_STAMP_OPTIONS,
  emptyLineItem,
  lineItemsFromSaved,
  lineItemTotal,
  parseAmount,
  stampImage,
  type InvoiceLineItem,
  type InvoiceStamp,
} from "@/lib/invoice";

import { saveInvoice } from "./actions";
import { downloadInvoicePdf } from "./download-pdf";
import type { SavedInvoice } from "./invoices-view";

const fieldCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm transition-colors placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100";
const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

export function InvoiceGenerator({
  pastInvoices = [],
}: {
  pastInvoices?: SavedInvoice[];
}) {
  const [invoiceNumber, setInvoiceNumber] = React.useState("#00200");
  const [invoiceDate, setInvoiceDate] = React.useState(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [billToName, setBillToName] = React.useState("");
  const [billToDetails, setBillToDetails] = React.useState("");
  const [items, setItems] = React.useState<InvoiceLineItem[]>([
    emptyLineItem(),
  ]);
  const [dueToday, setDueToday] = React.useState(""); // "" = same as total
  const [stamp, setStamp] = React.useState<"none" | InvoiceStamp>("none");
  // Which past invoice the form was loaded from (controls the picker only).
  const [loadedId, setLoadedId] = React.useState("");

  // Load a saved invoice's details into the form so the user can re-issue it
  // (typically to slap a "Deposit paid" / "Payment received" stamp on it).
  // Selecting the blank option resets to a fresh, empty invoice.
  const loadPastInvoice = (id: string) => {
    setLoadedId(id);
    const inv = pastInvoices.find((p) => p.id === id);
    if (!inv) {
      setInvoiceNumber("#00200");
      setInvoiceDate(format(new Date(), "yyyy-MM-dd"));
      setBillToName("");
      setBillToDetails("");
      setItems([emptyLineItem()]);
      setDueToday("");
      setStamp("none");
      return;
    }
    setInvoiceNumber(inv.invoice_number);
    setInvoiceDate((inv.invoice_date || "").slice(0, 10));
    setBillToName(inv.bill_to_name || "");
    setBillToDetails(inv.bill_to_details || "");
    const loaded = lineItemsFromSaved(inv.items ?? []);
    setItems(loaded.length ? loaded : [emptyLineItem()]);
    setDueToday(String(Number(inv.due_today)));
    setStamp((inv.stamp as InvoiceStamp) || "none");
  };

  const grandTotal = items.reduce((sum, l) => sum + lineItemTotal(l), 0);
  const dueTodayValue =
    dueToday.trim() === "" ? grandTotal : parseAmount(dueToday);

  const router = useRouter();
  const [saving, setSaving] = React.useState(false);

  // Save a snapshot to "Past invoices", then download the PDF straight away.
  // The download always proceeds even if saving fails — getting the file is the
  // primary action; archiving it is the bonus.
  const handleDownload = async () => {
    setSaving(true);
    const payload = {
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      bill_to_name: billToName,
      bill_to_details: billToDetails,
      items: items.map((l) => ({
        item: l.item,
        description: l.description,
        qty: l.qty,
        rate: l.rate,
        total: lineItemTotal(l),
      })),
      grand_total: grandTotal,
      due_today: dueTodayValue,
      stamp: stamp === "none" ? null : stamp,
    };
    const res = await saveInvoice(payload);
    if (res.ok) {
      toast.success("Saved to Past invoices.");
      router.refresh();
    } else {
      toast.error(`Couldn't save: ${res.error}`);
    }
    try {
      await downloadInvoicePdf(payload);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't download the PDF.",
      );
    } finally {
      setSaving(false);
    }
  };

  const updateItem = (id: string, patch: Partial<InvoiceLineItem>) =>
    setItems((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    );

  const addItem = () => setItems((prev) => [...prev, emptyLineItem()]);
  const removeItem = (id: string) =>
    setItems((prev) =>
      prev.length === 1 ? prev : prev.filter((l) => l.id !== id),
    );

  const billToLines = billToDetails.split("\n").filter(Boolean);
  const displayDate = invoiceDate
    ? format(new Date(invoiceDate), "dd/MM/yyyy")
    : "";

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Invoice Generator
          </h1>
          <p className="text-sm text-slate-500">
            Fill in the details — the preview updates live. Click Download to
            save a PDF.
          </p>
        </div>
        <Button onClick={handleDownload} loading={saving}>
          <Download className="h-4 w-4" />
          Download PDF
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(340px,400px)_1fr]">
        {/* ---------- FORM ---------- */}
        <div className="no-print space-y-5">
          {pastInvoices.length > 0 && (
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
              <h2 className="mb-4 text-sm font-semibold text-slate-900">
                Start from a past invoice
              </h2>
              <select
                className={fieldCls}
                value={loadedId}
                onChange={(e) => loadPastInvoice(e.target.value)}
              >
                <option value="">New blank invoice</option>
                {pastInvoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.invoice_number} — {inv.bill_to_name || "—"} (
                    {formatCurrency(Number(inv.grand_total))})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400">
                Loads the invoice&rsquo;s details so you can add a Paid stamp
                below and download it again.
              </p>
            </section>
          )}

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">
              Invoice details
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Invoice number</label>
                <input
                  className={fieldCls}
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="#00200"
                />
              </div>
              <div>
                <label className={labelCls}>Invoice date</label>
                <input
                  type="date"
                  className={fieldCls}
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">
              Bill to
            </h2>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Name</label>
                <input
                  className={fieldCls}
                  value={billToName}
                  onChange={(e) => setBillToName(e.target.value)}
                  placeholder="Franley"
                />
              </div>
              <div>
                <label className={labelCls}>Address & contact</label>
                <textarea
                  className={cn(fieldCls, "min-h-[88px] resize-y")}
                  value={billToDetails}
                  onChange={(e) => setBillToDetails(e.target.value)}
                  placeholder={"10, Atapattu Road,\nDehiwala, Sri Lanka\n+94 77 442 9216"}
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  One line per row — shown exactly as typed.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Line items
              </h2>
              <button
                onClick={addItem}
                className="inline-flex items-center gap-1 rounded-lg bg-primary-50 px-2.5 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-100"
              >
                <Plus className="h-3.5 w-3.5" />
                Add item
              </button>
            </div>

            <div className="space-y-4">
              {items.map((line, idx) => (
                <div
                  key={line.id}
                  className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Item {idx + 1}
                    </span>
                    <button
                      onClick={() => removeItem(line.id)}
                      disabled={items.length === 1}
                      aria-label="Remove item"
                      className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="space-y-2">
                    <input
                      className={fieldCls}
                      value={line.item}
                      onChange={(e) =>
                        updateItem(line.id, { item: e.target.value })
                      }
                      placeholder="Item / service (e.g. Franley.lk)"
                    />
                    <textarea
                      className={cn(fieldCls, "min-h-[64px] resize-y")}
                      value={line.description}
                      onChange={(e) =>
                        updateItem(line.id, { description: e.target.value })
                      }
                      placeholder="Description"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className={labelCls}>Qty</label>
                        <input
                          className={fieldCls}
                          value={line.qty}
                          onChange={(e) =>
                            updateItem(line.id, { qty: e.target.value })
                          }
                          placeholder="—"
                          inputMode="decimal"
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Rate</label>
                        <input
                          className={fieldCls}
                          value={line.rate}
                          onChange={(e) =>
                            updateItem(line.id, { rate: e.target.value })
                          }
                          placeholder="60000"
                          inputMode="decimal"
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Total</label>
                        <input
                          className={fieldCls}
                          value={
                            line.totalManual
                              ? line.total
                              : lineItemTotal(line) === 0
                                ? ""
                                : String(lineItemTotal(line))
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            updateItem(line.id, {
                              total: v,
                              totalManual: v.trim() !== "",
                            });
                          }}
                          placeholder="auto"
                          inputMode="decimal"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Amounts</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Total (auto)</span>
                <span className="font-semibold text-slate-900">
                  {formatCurrency(grandTotal)}
                </span>
              </div>
              <div>
                <label className={labelCls}>Due today</label>
                <input
                  className={fieldCls}
                  value={dueToday}
                  onChange={(e) => setDueToday(e.target.value)}
                  placeholder={`Defaults to total (${formatCurrency(grandTotal)})`}
                  inputMode="decimal"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  Leave blank to charge the full total. Enter a number for a
                  partial / deposit amount.
                </p>
              </div>

              <div>
                <label className={labelCls}>Paid stamp</label>
                <select
                  className={fieldCls}
                  value={stamp}
                  onChange={(e) =>
                    setStamp(e.target.value as "none" | InvoiceStamp)
                  }
                >
                  {INVOICE_STAMP_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-400">
                  Stamps the invoice once the deposit is paid, or
                  &ldquo;Payment received&rdquo; once it&rsquo;s settled in full.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* ---------- LIVE PREVIEW ---------- */}
        <div className="overflow-x-auto">
          <InvoiceDocument
            invoiceNumber={invoiceNumber}
            displayDate={displayDate}
            billToName={billToName}
            billToLines={billToLines}
            items={items}
            grandTotal={grandTotal}
            dueToday={dueTodayValue}
            stamp={stamp === "none" ? null : stamp}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The printable invoice — styled to match the template.              */
/* ------------------------------------------------------------------ */

export function InvoiceDocument({
  invoiceNumber,
  displayDate,
  billToName,
  billToLines,
  items,
  grandTotal,
  dueToday,
  stamp,
}: {
  invoiceNumber: string;
  displayDate: string;
  billToName: string;
  billToLines: string[];
  items: InvoiceLineItem[];
  grandTotal: number;
  dueToday: number;
  stamp?: string | null;
}) {
  const stampSrc = stampImage(stamp);
  return (
    <div
      id="invoice-print"
      className="invoice-doc relative mx-auto w-[794px] max-w-full bg-white px-14 py-12 text-neutral-900 shadow-[var(--shadow-lift)] ring-1 ring-slate-200"
    >
      {/* Paid stamp — big, centred over the whole page like a real rubber stamp */}
      {stampSrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={stampSrc}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 object-contain"
          style={{ width: 480 }}
        />
      )}

      {/* Wordmark */}
      <h1 className="invoice-wordmark font-black text-neutral-900">INVOICE</h1>

      <div className="mt-6 border-t border-neutral-300" />

      {/* Header: from / bill to / invoice meta */}
      <div className="mt-6 grid grid-cols-3 gap-6 text-[12px] leading-relaxed text-neutral-700">
        <div>
          <p className="font-bold text-neutral-900">{INVOICE_COMPANY.name}</p>
          <p className="mt-1">{INVOICE_COMPANY.phones}</p>
          <p>{INVOICE_COMPANY.email}</p>
          <p>{INVOICE_COMPANY.website}</p>
          {INVOICE_COMPANY.addressLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>

        <div>
          <p className="font-bold text-neutral-900">BILL TO</p>
          <p className="mt-1">{billToName || "—"}</p>
          {billToLines.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>

        <div>
          <p className="font-bold text-neutral-900">INVOICE</p>
          <p className="mt-1">InvoiceNumber:{invoiceNumber}</p>
          <p>Invoice Date: {displayDate}</p>
        </div>
      </div>

      {/* Line items table */}
      <table className="mt-10 w-full border-collapse text-[12px] leading-relaxed">
        <thead>
          <tr className="border-y border-neutral-300 text-[12px] font-bold text-neutral-900">
            <th className="w-[17%] px-3 py-2.5 text-left">ITEM / SERVICE</th>
            <th className="w-[44%] border-l border-neutral-300 px-3 py-2.5 text-center">
              DESCRIPTION
            </th>
            <th className="w-[10%] border-l border-neutral-300 px-3 py-2.5 text-center">
              QTY
            </th>
            <th className="w-[14%] border-l border-neutral-300 px-3 py-2.5 text-center">
              RATE
            </th>
            <th className="w-[15%] border-l border-neutral-300 px-3 py-2.5 text-center">
              TOTAL
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((line) => {
            const total = lineItemTotal(line);
            return (
              <tr
                key={line.id}
                className="border-b border-neutral-200 align-top text-neutral-700"
              >
                <td className="px-3 py-4">{line.item}</td>
                <td className="border-l border-neutral-200 px-3 py-4">
                  {line.description}
                </td>
                <td className="border-l border-neutral-200 px-3 py-4 text-center">
                  {line.qty}
                </td>
                <td className="border-l border-neutral-200 px-3 py-4 text-right">
                  {line.rate ? formatCurrency(parseAmount(line.rate)) : ""}
                </td>
                <td className="border-l border-neutral-200 px-3 py-4 text-right">
                  {total ? formatCurrency(total) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Totals */}
      <div className="mt-8 flex flex-col items-end gap-0 text-[13px]">
        <div className="flex w-full max-w-[340px] items-center justify-between py-2">
          <span className="font-bold text-neutral-900">TOTAL:</span>
          <span className="text-neutral-700">{formatCurrency(grandTotal)}</span>
        </div>
        <div className="w-full max-w-[340px] border-t border-neutral-300" />
        <div className="flex w-full max-w-[340px] items-center justify-between py-2">
          <span className="font-bold text-neutral-900">DUE TODAY:</span>
          <span className="text-neutral-700">{formatCurrency(dueToday)}</span>
        </div>
      </div>

      <div className="mt-10 border-t border-neutral-300" />

      {/* Footer: contact / bank details */}
      <div className="mt-6 grid grid-cols-2 gap-6 text-[12px] leading-relaxed text-neutral-700">
        <div>
          <p className="font-bold text-neutral-900">CONTACT</p>
          <p className="mt-1">{INVOICE_COMPANY.phones}</p>
          <p>{INVOICE_COMPANY.website}</p>
          <p>{INVOICE_COMPANY.email}</p>
          {INVOICE_COMPANY.addressLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        <div>
          <p className="font-bold text-neutral-900">BANK DETAILS FOR PAYMENT</p>
          <p className="mt-1">
            <span className="font-bold text-neutral-900">Bank Name:</span>{" "}
            {INVOICE_BANK.bankName}
          </p>
          <p>
            <span className="font-bold text-neutral-900">Account Name:</span>{" "}
            {INVOICE_BANK.accountName}
          </p>
          <p>
            <span className="font-bold text-neutral-900">Account Number:</span>{" "}
            {INVOICE_BANK.accountNumber}
          </p>
          <p>
            <span className="font-bold text-neutral-900">Branch:</span>{" "}
            {INVOICE_BANK.branch}
          </p>
        </div>
      </div>

      <div className="mt-12 border-t border-neutral-300" />

      {/* Sign-off */}
      <div className="mt-6">
        <p className="max-w-[60%] text-[12px] font-bold uppercase leading-relaxed text-neutral-900">
          {INVOICE_SIGNOFF.questionsLine}
        </p>
        <div className="mt-8 flex items-end justify-between">
          <span className="text-[13px] font-bold text-neutral-900">
            {INVOICE_SIGNOFF.signerName}
          </span>
          <div className="flex items-end gap-10">
            <span className="pb-1 text-[12px] text-neutral-500">
              {INVOICE_SIGNOFF.signerTitle}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={INVOICE_SIGNOFF.signatureImage}
              alt="Authorised signature"
              className="relative h-20 w-auto -translate-x-10 translate-y-3 object-contain"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
