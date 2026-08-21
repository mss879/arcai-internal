"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Plus, Trash2, Download, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn, formatCurrency } from "@/lib/utils";
import {
  DEFAULT_INVOICE_BANK_ID,
  FIRST_INVOICE_NUMBER,
  INVOICE_BANKS,
  INVOICE_COMPANY,
  INVOICE_SIGNOFF,
  INVOICE_STAMP_OPTIONS,
  emptyLineItem,
  invoiceBank,
  lineItemsFromSaved,
  lineItemTotal,
  nextInvoiceNumber,
  parseAmount,
  stampImage,
  type InvoiceLineItem,
  type InvoiceStamp,
} from "@/lib/invoice";

import { takeInvoiceDraft } from "@/lib/invoice-handoff";
import type { Quote } from "@/lib/types";

import { saveInvoice } from "./actions";
import { downloadInvoicePdf } from "./download-pdf";
import type { SavedInvoice } from "./invoices-view";

const fieldCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm transition-colors placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100";
const labelCls = "block text-xs font-semibold text-slate-600 mb-1";

export function InvoiceGenerator({
  pastInvoices = [],
  quotes = [],
}: {
  pastInvoices?: SavedInvoice[];
  quotes?: Quote[];
}) {
  // The invoice number is filled in automatically: highest past number + 1.
  // `suggestNumber()` reads the freshest list of past invoices every time it's
  // called, so it stays right after a save refreshes the page data.
  const pastNumbers = pastInvoices.map((p) => p.invoice_number);
  const suggestNumber = () => nextInvoiceNumber(pastNumbers);

  const [invoiceNumber, setInvoiceNumber] = React.useState(suggestNumber);
  const [invoiceDate, setInvoiceDate] = React.useState(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [billToName, setBillToName] = React.useState("");
  const [billToDetails, setBillToDetails] = React.useState("");
  const [items, setItems] = React.useState<InvoiceLineItem[]>([
    emptyLineItem(),
  ]);
  const [dueToday, setDueToday] = React.useState(""); // "" = same as total
  const [amountPaid, setAmountPaid] = React.useState(""); // "" = nothing paid yet
  const [stamp, setStamp] = React.useState<"none" | InvoiceStamp>("none");
  const [bankAccount, setBankAccount] = React.useState<string>(
    DEFAULT_INVOICE_BANK_ID,
  );
  // Which past invoice / quote the form was loaded from (controls the pickers only).
  const [loadedId, setLoadedId] = React.useState("");
  const [loadedQuoteId, setLoadedQuoteId] = React.useState("");
  /** Set when the form was filled from a proposal via "Generate invoice". */
  const [fromProposal, setFromProposal] = React.useState<string | null>(null);

  // Pick up a proposal handed over by the Proposals screen. Runs once, on
  // mount: the draft is consumed from sessionStorage so a later refresh
  // starts from a clean invoice instead of silently re-filling this one.
  React.useEffect(() => {
    const draft = takeInvoiceDraft();
    if (!draft) return;
    setBillToName(draft.billToName);
    setBillToDetails(draft.billToDetails);
    const loaded = draft.items.map((it) => ({
      ...emptyLineItem(),
      item: it.item,
      description: it.description,
      // The proposal's figure is authoritative — carry it as the row total
      // rather than re-deriving it from qty × rate.
      totalManual: true,
      total: String(it.total),
    }));
    setItems(loaded.length ? loaded : [emptyLineItem()]);
    setFromProposal(draft.sourceLabel);
  }, []);

  // Load a saved invoice's details into the form so the user can re-issue it
  // (typically to slap a "Deposit paid" / "Payment received" stamp on it).
  // Selecting the blank option resets to a fresh, empty invoice.
  const loadPastInvoice = (id: string) => {
    setLoadedId(id);
    setLoadedQuoteId("");
    const inv = pastInvoices.find((p) => p.id === id);
    if (!inv) {
      setInvoiceNumber(suggestNumber());
      setInvoiceDate(format(new Date(), "yyyy-MM-dd"));
      setBillToName("");
      setBillToDetails("");
      setItems([emptyLineItem()]);
      setDueToday("");
      setAmountPaid("");
      setStamp("none");
      setBankAccount(DEFAULT_INVOICE_BANK_ID);
      return;
    }
    setInvoiceNumber(inv.invoice_number);
    setInvoiceDate((inv.invoice_date || "").slice(0, 10));
    setBillToName(inv.bill_to_name || "");
    setBillToDetails(inv.bill_to_details || "");
    const loaded = lineItemsFromSaved(inv.items ?? []);
    setItems(loaded.length ? loaded : [emptyLineItem()]);
    // `due_today` is the amount charged today and `amount_paid` what was paid
    // before — both stored as-is, so they reload straight into their fields.
    setDueToday(String(Number(inv.due_today)));
    setAmountPaid(Number(inv.amount_paid) > 0 ? String(Number(inv.amount_paid)) : "");
    setStamp((inv.stamp as InvoiceStamp) || "none");
    setBankAccount(invoiceBank(inv.bank_account).id);
  };

  // Load a quote's customer + line items into the invoice form — the fastest
  // way to turn an accepted quotation into the branded invoice template.
  const loadQuote = (id: string) => {
    setLoadedQuoteId(id);
    setLoadedId("");
    const quote = quotes.find((q) => q.id === id);
    if (!quote) return;
    setInvoiceNumber(suggestNumber());
    setBillToName(quote.customer_name || "");
    setBillToDetails(
      [quote.customer_email, quote.customer_phone].filter(Boolean).join("\n"),
    );
    const loaded = lineItemsFromSaved(quote.items ?? []);
    setItems(loaded.length ? loaded : [emptyLineItem()]);
    setDueToday("");
    setAmountPaid("");
    setStamp("none");
    setInvoiceDate(format(new Date(), "yyyy-MM-dd"));
  };

  const grandTotal = items.reduce((sum, l) => sum + lineItemTotal(l), 0);
  // The running statement: TOTAL, minus anything already paid, minus what's
  // being charged today, leaves the balance still remaining.
  //  • Amount already paid — money in before this invoice.
  //  • Due today — what's charged now (its own figure). Left blank, it defaults
  //    to whatever's still owed after the earlier payment (total − paid).
  //  • Balance remaining — total − paid − due today, floored at zero.
  const amountPaidValue = parseAmount(amountPaid);
  const dueTodayValue =
    dueToday.trim() === ""
      ? Math.max(0, grandTotal - amountPaidValue)
      : parseAmount(dueToday);
  const balanceRemaining = Math.max(
    0,
    grandTotal - amountPaidValue - dueTodayValue,
  );
  const selectedBank = invoiceBank(bankAccount);

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
      amount_paid: amountPaidValue,
      stamp: stamp === "none" ? null : stamp,
      bank_account: bankAccount,
    };
    const res = await saveInvoice(payload);
    if (res.ok) {
      toast.success("Saved to Past invoices.");
      // Queue up the next number straight away so a second invoice needs no
      // typing. A re-issued invoice (loaded from Past invoices to add a paid
      // stamp) keeps the number it was issued under.
      if (!loadedId) {
        setInvoiceNumber(nextInvoiceNumber([...pastNumbers, invoiceNumber]));
      }
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

      {fromProposal && (
        <div className="no-print flex items-start gap-3 rounded-2xl border border-primary-200 bg-primary-50/60 p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-primary-600 ring-1 ring-primary-200">
            <FileText className="h-4 w-4" />
          </span>
          <div className="text-sm">
            <p className="font-semibold text-slate-900">
              Built from the proposal — {fromProposal}
            </p>
            <p className="text-slate-500">
              The customer and pricing came straight from that proposal. Check
              the invoice number, add anything already paid, then download.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(340px,400px)_1fr]">
        {/* ---------- FORM ---------- */}
        <div className="no-print space-y-5">
          {(pastInvoices.length > 0 || quotes.length > 0) && (
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
              <h2 className="mb-4 text-sm font-semibold text-slate-900">
                Start from…
              </h2>
              <div className="space-y-3">
                {quotes.length > 0 && (
                  <div>
                    <label className={labelCls}>A quote</label>
                    <select
                      className={fieldCls}
                      value={loadedQuoteId}
                      onChange={(e) => loadQuote(e.target.value)}
                    >
                      <option value="">Pick a quote…</option>
                      {quotes.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.quote_number} — {q.customer_name || "—"} (
                          {formatCurrency(Number(q.grand_total))})
                          {q.status === "accepted" ? " ✍ accepted" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-400">
                      Pulls the quote&rsquo;s customer and line items into the
                      invoice template.
                    </p>
                  </div>
                )}
                {pastInvoices.length > 0 && (
                  <div>
                    <label className={labelCls}>A past invoice</label>
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
                      Loads the invoice&rsquo;s details so you can add a Paid
                      stamp below and download it again.
                    </p>
                  </div>
                )}
              </div>
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
                  placeholder={FIRST_INVOICE_NUMBER}
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
            <p className="mt-1 text-[11px] text-slate-400">
              Numbered automatically from your highest past invoice — type over
              it if you need a different one.
            </p>

            <div className="mt-4">
              <label className={labelCls}>Pay into</label>
              <select
                className={fieldCls}
                value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value)}
              >
                {INVOICE_BANKS.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {bank.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400">
                {selectedBank.accountNumber} · {selectedBank.branch} — printed
                under &ldquo;Bank details for payment&rdquo;.
              </p>
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
                <label className={labelCls}>Amount already paid</label>
                <input
                  className={cn(
                    fieldCls,
                    amountPaid.trim() !== "" &&
                      "font-semibold text-rose-600 focus:ring-rose-100",
                  )}
                  value={amountPaid}
                  onChange={(e) => setAmountPaid(e.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  Anything the client has already paid — shown in red on the
                  invoice and subtracted from the total.
                </p>
              </div>
              <div>
                <label className={labelCls}>Due today</label>
                <input
                  className={fieldCls}
                  value={dueToday}
                  onChange={(e) => setDueToday(e.target.value)}
                  placeholder={`Defaults to ${formatCurrency(dueTodayValue)}`}
                  inputMode="decimal"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  What you&rsquo;re charging on this invoice today. Leave blank
                  to bill everything still owed.
                </p>
              </div>

              <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
                <span className="font-semibold text-slate-700">
                  Balance remaining
                </span>
                <span className="font-bold text-slate-900">
                  {formatCurrency(balanceRemaining)}
                </span>
              </div>
              <p className="-mt-1 text-[11px] text-slate-400">
                Total minus what&rsquo;s already paid and what&rsquo;s due today.
                Shows on the invoice only when something&rsquo;s left over.
              </p>

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
            amountPaid={amountPaidValue}
            dueToday={dueTodayValue}
            stamp={stamp === "none" ? null : stamp}
            bankAccount={bankAccount}
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
  amountPaid = 0,
  dueToday,
  stamp,
  bankAccount,
}: {
  invoiceNumber: string;
  displayDate: string;
  billToName: string;
  billToLines: string[];
  items: InvoiceLineItem[];
  grandTotal: number;
  /** Already paid; shown in red and subtracted from the total. 0 = hide it. */
  amountPaid?: number;
  dueToday: number;
  stamp?: string | null;
  /** Bank account id from INVOICE_BANKS; omitted/unknown = the default account. */
  bankAccount?: string | null;
}) {
  const stampSrc = stampImage(stamp);
  const bank = invoiceBank(bankAccount);
  // What's left after the earlier payment and today's charge — hidden when
  // there's nothing outstanding (a plain paid-in-full invoice).
  const balanceRemaining = Math.max(0, grandTotal - amountPaid - dueToday);
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
        {amountPaid > 0 && (
          <div className="flex w-full max-w-[340px] items-center justify-between py-2">
            <span className="font-bold text-rose-600">AMOUNT PAID:</span>
            <span className="text-rose-600">
              &minus;{formatCurrency(amountPaid)}
            </span>
          </div>
        )}
        <div className="w-full max-w-[340px] border-t border-neutral-300" />
        <div className="flex w-full max-w-[340px] items-center justify-between py-2">
          <span className="font-bold text-neutral-900">DUE TODAY:</span>
          <span className="text-neutral-700">{formatCurrency(dueToday)}</span>
        </div>
        {balanceRemaining > 0 && (
          <div className="flex w-full max-w-[340px] items-center justify-between border-t border-neutral-300 py-2">
            <span className="font-bold text-neutral-900">
              BALANCE REMAINING:
            </span>
            <span className="font-bold text-neutral-900">
              {formatCurrency(balanceRemaining)}
            </span>
          </div>
        )}
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
            {bank.bankName}
          </p>
          <p>
            <span className="font-bold text-neutral-900">Account Name:</span>{" "}
            {bank.accountName}
          </p>
          <p>
            <span className="font-bold text-neutral-900">Account Number:</span>{" "}
            {bank.accountNumber}
          </p>
          <p>
            <span className="font-bold text-neutral-900">Branch:</span>{" "}
            {bank.branch}
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
