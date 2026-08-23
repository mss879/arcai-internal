import Image from "next/image";
import { format } from "date-fns";
import { Download } from "lucide-react";

import { formatCurrency } from "@/lib/utils";

export type PublicInvoiceData = {
  invoiceNumber: string;
  invoiceDate: string;
  billToName: string;
  billToDetails: string;
  items: {
    item: string;
    description: string;
    qty: string;
    rate: string;
    total: number;
  }[];
  grandTotal: number;
  amountPaid: number;
  dueToday: number;
  stampSrc: string | null;
  stampLabel: string | null;
  company: {
    name: string;
    phones: string;
    email: string;
    website: string;
    addressLines: string[];
  };
  bank: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    branch: string;
  };
  questionsLine: string;
  pdfHref: string;
};

/**
 * The invoice as a client sees it on their phone.
 *
 * Built to be read on a 375px screen first — the PDF exists for anyone who
 * wants to file or print it, but the thing that opens when they tap the link
 * in a text has to be legible immediately, without pinching.
 *
 * A server component: there is nothing interactive here beyond a download
 * link, and shipping no JavaScript to a page that arrives over mobile data is
 * the point.
 */
export function PublicInvoice({ data }: { data: PublicInvoiceData }) {
  // The exact arithmetic the PDF uses (invoice-pdf.tsx): `due_today` is what
  // is being asked for now, and the balance is whatever is left after it. The
  // client will often have both documents open — they must never disagree.
  const balance = Math.max(
    0,
    data.grandTotal - data.amountPaid - data.dueToday,
  );
  const settled = data.dueToday <= 0 && balance <= 0;

  return (
    <div className="min-h-screen app-bg px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-[720px] space-y-4">
        {/* Company + invoice number ------------------------------------ */}
        <div className="rounded-3xl border border-white/30 bg-white/80 p-6 shadow-lg backdrop-blur-xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900">
                {data.company.name}
              </h1>
              <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-slate-500">
                {data.company.addressLines.join("\n")}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {data.company.email} · {data.company.phones}
              </p>
            </div>

            {data.stampSrc && (
              <Image
                src={data.stampSrc}
                alt={data.stampLabel ?? "Paid"}
                width={104}
                height={104}
                className="h-20 w-20 shrink-0 object-contain sm:h-24 sm:w-24"
                priority
              />
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-slate-100 pt-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Invoice
              </p>
              <p className="text-2xl font-bold tabular-nums text-slate-900">
                {data.invoiceNumber}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Date
              </p>
              <p className="text-sm font-medium text-slate-700">
                {safeDate(data.invoiceDate)}
              </p>
            </div>
          </div>
        </div>

        {/* Bill to ----------------------------------------------------- */}
        <div className="rounded-3xl border border-white/30 bg-white/80 p-6 shadow-lg backdrop-blur-xl">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Billed to
          </p>
          <p className="mt-1 text-base font-semibold text-slate-900">
            {data.billToName}
          </p>
          {data.billToDetails && (
            <p className="mt-0.5 whitespace-pre-line text-sm text-slate-500">
              {data.billToDetails}
            </p>
          )}
        </div>

        {/* Items ------------------------------------------------------- */}
        <div className="overflow-hidden rounded-3xl border border-white/30 bg-white/80 shadow-lg backdrop-blur-xl">
          <ul className="divide-y divide-slate-100">
            {data.items.map((item, i) => (
              <li key={i} className="px-6 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">
                      {item.item}
                    </p>
                    {item.description && (
                      <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                        {item.description}
                      </p>
                    )}
                    {item.qty && item.rate && (
                      <p className="mt-1 text-[11px] tabular-nums text-slate-400">
                        {item.qty} × {formatCurrency(Number(item.rate) || 0)}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {formatCurrency(item.total)}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <dl className="space-y-2 border-t border-slate-200/70 bg-slate-50/60 px-6 py-4 text-sm">
            <Row label="Total" value={formatCurrency(data.grandTotal)} />
            {data.amountPaid > 0 && (
              <Row
                label="Paid"
                value={`− ${formatCurrency(data.amountPaid)}`}
                tone="emerald"
              />
            )}
            <div className="flex items-baseline justify-between gap-4 border-t border-slate-200/70 pt-2">
              <dt className="text-sm font-semibold text-slate-900">
                {settled ? "Settled in full" : "Due now"}
              </dt>
              <dd
                className={`text-xl font-bold tabular-nums ${
                  settled ? "text-emerald-600" : "text-amber-600"
                }`}
              >
                {formatCurrency(data.dueToday)}
              </dd>
            </div>
            {balance > 0 && (
              <Row
                label="Balance remaining after that"
                value={formatCurrency(balance)}
              />
            )}
          </dl>
        </div>

        {/* How to pay the rest ----------------------------------------- */}
        {(data.dueToday > 0 || balance > 0) && (
          <div className="rounded-3xl border border-white/30 bg-white/80 p-6 shadow-lg backdrop-blur-xl">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Pay the balance into
            </p>
            <dl className="mt-2 space-y-1 text-sm">
              <Line label="Bank" value={data.bank.bankName} />
              <Line label="Account name" value={data.bank.accountName} />
              <Line label="Account no." value={data.bank.accountNumber} mono />
              <Line label="Branch" value={data.bank.branch} />
            </dl>
          </div>
        )}

        {/* Download ---------------------------------------------------- */}
        <div className="flex flex-col items-center gap-3 pb-6 pt-2">
          <a
            href={data.pdfHref}
            className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700"
          >
            <Download className="h-4 w-4" />
            Download PDF
          </a>
          <p className="max-w-[46ch] text-center text-xs leading-relaxed text-slate-400">
            {data.questionsLine}
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`font-medium tabular-nums ${
          tone === "emerald" ? "text-emerald-600" : "text-slate-800"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Line({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`font-medium text-slate-800 ${mono ? "font-mono tabular-nums" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** Invoice dates are stored as YYYY-MM-DD; anything else prints as-is. */
function safeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return format(new Date(`${value}T00:00:00`), "d MMMM yyyy");
}
