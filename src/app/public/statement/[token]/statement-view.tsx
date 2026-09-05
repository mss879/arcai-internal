import { format } from "date-fns";
import { Download } from "lucide-react";

import type { ClientStatement, CurrencyStatement } from "@/lib/statement";
import { cn, formatCurrency } from "@/lib/utils";

export type PublicStatementData = {
  statement: ClientStatement;
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

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : format(d, "d MMM yyyy");
}

/** `(Rs. 1,000)` for a credit balance, plain otherwise. */
function signed(amount: number, currency: string): string {
  return amount < 0 ? `(${formatCurrency(Math.abs(amount), currency)})` : formatCurrency(amount, currency);
}

/**
 * The statement as a client reads it on their phone (T4.6).
 *
 * A server component, like the public invoice: nothing here is interactive
 * beyond the PDF link. Built for 375px first — the running balance column
 * is the one that matters, so it stays visible while the details wrap.
 */
export function PublicStatement({ data }: { data: PublicStatementData }) {
  const { statement } = data;
  const client = statement.client;
  const periodLabel = statement.period.from
    ? `${when(statement.period.from)} – ${when(statement.period.to)}`
    : `All activity to ${when(statement.period.to)}`;

  return (
    <div className="min-h-screen app-bg px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-[760px] space-y-4">
        <div className="rounded-3xl border border-white/30 bg-white/80 p-6 shadow-lg backdrop-blur-xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900">{data.company.name}</h1>
              <p className="text-xs text-slate-500">{data.company.phones}</p>
              <p className="text-xs text-slate-500">{data.company.email}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-extrabold tracking-tight text-slate-900">Statement</p>
              <p className="text-xs text-slate-500">{periodLabel}</p>
              <p className="text-xs text-slate-400">Issued {when(statement.generatedAt)}</p>
            </div>
          </div>
          <div className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Statement for</p>
              <p className="mt-1 text-sm font-semibold text-slate-800">{client.name}</p>
              {client.company && <p className="text-xs text-slate-500">{client.company}</p>}
              {client.email && <p className="text-xs text-slate-500">{client.email}</p>}
            </div>
            <div className="sm:text-right">
              <a
                href={data.pdfHref}
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                <Download className="h-4 w-4" /> Download PDF
              </a>
            </div>
          </div>
        </div>

        {statement.currencies.map((block) => (
          <CurrencyCard key={block.currency} block={block} many={statement.currencies.length > 1} />
        ))}

        <div className="rounded-3xl border border-white/30 bg-white/80 p-6 shadow-lg backdrop-blur-xl">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Bank details for payment</p>
              <dl className="mt-2 space-y-1 text-sm text-slate-700">
                <div className="flex gap-2"><dt className="w-32 shrink-0 text-slate-500">Bank</dt><dd>{data.bank.bankName}</dd></div>
                <div className="flex gap-2"><dt className="w-32 shrink-0 text-slate-500">Account name</dt><dd>{data.bank.accountName}</dd></div>
                <div className="flex gap-2"><dt className="w-32 shrink-0 text-slate-500">Account number</dt><dd className="font-mono">{data.bank.accountNumber}</dd></div>
                <div className="flex gap-2"><dt className="w-32 shrink-0 text-slate-500">Branch</dt><dd>{data.bank.branch}</dd></div>
              </dl>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Contact</p>
              <p className="mt-2 text-sm text-slate-700">{data.company.website}</p>
              <p className="text-sm text-slate-700">{data.company.email}</p>
              {data.company.addressLines.map((l) => (
                <p key={l} className="text-xs text-slate-500">{l}</p>
              ))}
            </div>
          </div>
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{data.questionsLine}</p>
        </div>
      </div>
    </div>
  );
}

function CurrencyCard({ block, many }: { block: CurrencyStatement; many: boolean }) {
  const cur = block.currency;
  return (
    <div className="rounded-3xl border border-white/30 bg-white/80 p-6 shadow-lg backdrop-blur-xl">
      {many && <h2 className="mb-3 text-sm font-semibold text-slate-900">Account in {cur}</h2>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Opening" value={signed(block.opening, cur)} />
        <Tile label="Invoiced" value={formatCurrency(block.invoiced, cur)} />
        <Tile label="Received" value={formatCurrency(block.received, cur)} tone="good" />
        <Tile
          label={block.closing < 0 ? "Credit balance" : "Balance due"}
          value={formatCurrency(Math.abs(block.closing), cur)}
          tone={block.closing > 0 ? "amber" : "good"}
        />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3 font-semibold">Date</th>
              <th className="py-2 pr-3 font-semibold">Details</th>
              <th className="py-2 pr-3 text-right font-semibold">Invoiced</th>
              <th className="py-2 pr-3 text-right font-semibold">Received</th>
              <th className="py-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {block.opening !== 0 && (
              <tr className="text-slate-500">
                <td className="py-2 pr-3" />
                <td className="py-2 pr-3 font-medium">Balance brought forward</td>
                <td className="py-2 pr-3" />
                <td className="py-2 pr-3" />
                <td className="py-2 text-right font-semibold tabular-nums text-slate-700">{signed(block.opening, cur)}</td>
              </tr>
            )}
            {block.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-sm text-slate-400">No activity in this period.</td>
              </tr>
            )}
            {block.lines.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap py-2 pr-3 text-xs text-slate-500">{when(l.date)}</td>
                <td className="py-2 pr-3">
                  <p className={cn("font-medium", l.kind === "invoice" ? "text-slate-800" : "text-slate-700")}>{l.reference}</p>
                  <p className="text-xs text-slate-400">{l.description}</p>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-700">{l.debit ? formatCurrency(l.debit, cur) : ""}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-emerald-600">{l.credit ? formatCurrency(l.credit, cur) : ""}</td>
                <td className="py-2 text-right font-semibold tabular-nums text-slate-800">{signed(l.balance, cur)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 font-semibold text-slate-800">
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3">Totals</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(block.invoiced, cur)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-emerald-600">{formatCurrency(block.received, cur)}</td>
              <td className={cn("py-2 text-right tabular-nums", block.closing > 0 ? "text-amber-600" : "text-emerald-600")}>
                {signed(block.closing, cur)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {block.outstanding.length > 0 && (
        <div className="mt-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Invoices still open</h3>
          <ul className="mt-2 divide-y divide-slate-100">
            {block.outstanding.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="font-semibold text-slate-800">Invoice {i.number}</span>
                <span className="text-xs text-slate-400">{when(i.date)}</span>
                {i.dueDate && (
                  <span className={cn("text-xs", i.overdue ? "font-medium text-rose-600" : "text-slate-400")}>
                    due {when(i.dueDate)}{i.overdue ? " · overdue" : ""}
                  </span>
                )}
                <span className="ml-auto font-semibold tabular-nums text-amber-600">{formatCurrency(i.balance, cur)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "good" | "amber" }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-sm font-bold tabular-nums",
          tone === "good" ? "text-emerald-600" : tone === "amber" ? "text-amber-600" : "text-slate-800",
        )}
      >
        {value}
      </p>
    </div>
  );
}
