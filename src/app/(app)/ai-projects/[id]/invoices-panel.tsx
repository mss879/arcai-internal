"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ExternalLink, FileText, Receipt } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { shortDate, usd } from "@/lib/ai-projects/format";
import type { AiInvoiceStatus } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";

import { raiseAiInvoice, saveBillingSettings, type BillingSettingsInput } from "./billing-actions";

export type InvoiceHistoryRow = {
  id: string;
  period: string;
  label: string;
  status: AiInvoiceStatus;
  total: number | null;
  currency: string | null;
  usageCostUsd: number;
  markup: number | null;
  error: string | null;
  emailed: boolean;
  createdAt: string;
  invoice: { id: string; number: string; date: string; status: string | null; shareToken: string | null } | null;
};

export type InvoicesPanelData = {
  projectId: string;
  settings: BillingSettingsInput;
  history: InvoiceHistoryRow[];
  raisable: { period: string; label: string }[];
  clientEmail: string | null;
  nextRun: string;
};

const LINK_STATUS: Record<AiInvoiceStatus, { label: string; className: string }> = {
  pending: { label: "In progress", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  created: { label: "Raised", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  skipped_zero: { label: "Nothing to bill", className: "bg-slate-100 text-slate-500 ring-slate-200" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-200" },
};

function invoiceStatusLabel(status: string | null): { label: string; className: string } {
  switch (status) {
    case "paid":
      return { label: "Paid", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
    case "partially_paid":
      return { label: "Part paid", className: "bg-amber-50 text-amber-700 ring-amber-200" };
    case "sent":
      return { label: "Sent", className: "bg-sky-50 text-sky-700 ring-sky-200" };
    case "void":
      return { label: "Void", className: "bg-rose-50 text-rose-700 ring-rose-200" };
    default:
      return { label: "Draft — not sent", className: "bg-slate-100 text-slate-600 ring-slate-200" };
  }
}

export function InvoicesPanel({ data }: { data: InvoicesPanelData }) {
  const [s, setS] = React.useState<BillingSettingsInput>(data.settings);
  const [saving, setSaving] = React.useState(false);
  const [period, setPeriod] = React.useState(data.raisable[0]?.period ?? "");
  const [raising, setRaising] = React.useState(false);
  const set = <K extends keyof BillingSettingsInput>(k: K, v: BillingSettingsInput[K]) => setS((p) => ({ ...p, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await saveBillingSettings(data.projectId, s);
      if (res.ok) toast.success("Billing terms saved");
      else toast.error(res.error);
    } finally {
      setSaving(false);
    }
  }

  async function raise() {
    if (!period) return;
    setRaising(true);
    try {
      const res = await raiseAiInvoice(data.projectId, period);
      if (!res.ok) return void toast.error(res.error);
      if (res.skipped) toast.success("Nothing to bill for that month — no fee, no usage, no minimum.");
      else if (!res.created) toast.success(`That month already has invoice ${res.invoiceNumber}.`);
      else toast.success(`Invoice ${res.invoiceNumber} raised for ${formatCurrency(res.total, s.currency)}${res.emailed ? " and emailed." : " — review it on the Invoices page."}`);
    } finally {
      setRaising(false);
    }
  }

  return (
    <div className="space-y-6">
      {!data.clientEmail && (
        <Alert variant="info">No client (or no client email) is linked, so invoices are raised as drafts with no recipient. Link a client on the Overview tab.</Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Billing terms</CardTitle>
              <CardDescription>
                Each month: the fee, plus the month&apos;s exact model cost times the markup, topped up to any minimum. The client&apos;s
                invoice shows conversations and tokens — never the provider cost or the markup.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-3 text-sm">
                <input type="checkbox" checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} className="accent-primary-600" />
                <span>
                  <span className="block font-medium text-slate-800">Invoice this project monthly</span>
                  <span className="block text-xs text-slate-500">Usage is metered either way; this only controls whether a bill is raised.</span>
                </span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Currency">
                  <Select value={s.currency} onChange={(e) => set("currency", e.target.value as "USD" | "LKR")}>
                    <option value="USD">USD</option>
                    <option value="LKR">LKR (Sri Lankan rupees)</option>
                  </Select>
                </Field>
                {s.currency === "LKR" ? (
                  <Field label="Rupees per US dollar" required hint="Used to convert the usage line. Snapshotted onto each invoice.">
                    <Input type="number" step="0.01" min="0" value={s.fx ?? ""} onChange={(e) => set("fx", e.target.value === "" ? null : Number(e.target.value))} placeholder="305.00" />
                  </Field>
                ) : (
                  <Field label="Invoice mode">
                    <Select value={s.mode} onChange={(e) => set("mode", e.target.value as "draft" | "auto_send")}>
                      <option value="draft">Raise as a draft for review</option>
                      <option value="auto_send">Email the client automatically</option>
                    </Select>
                  </Field>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={`Monthly fee (${s.currency})`} hint="0 for none.">
                  <Input type="number" step="0.01" min="0" value={s.fee} onChange={(e) => set("fee", Number(e.target.value))} />
                </Field>
                <Field label="Usage markup ×" hint="1 = pass-through, 2 = double the cost.">
                  <Input type="number" step="0.05" min="0" value={s.markup} onChange={(e) => set("markup", Number(e.target.value))} />
                </Field>
                <Field label={`Monthly minimum (${s.currency})`} hint="Applied only on months the agent was live.">
                  <Input type="number" step="0.01" min="0" value={s.minimum} onChange={(e) => set("minimum", Number(e.target.value))} />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {s.currency === "LKR" && (
                  <Field label="Invoice mode">
                    <Select value={s.mode} onChange={(e) => set("mode", e.target.value as "draft" | "auto_send")}>
                      <option value="draft">Raise as a draft for review</option>
                      <option value="auto_send">Email the client automatically</option>
                    </Select>
                  </Field>
                )}
                <Field label="Billing starts" hint="Months before this are never invoiced.">
                  <Input type="date" value={s.billingFrom} onChange={(e) => set("billingFrom", e.target.value)} />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button type="submit" loading={saving}>Save terms</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-slate-400" /> Raise a month by hand
              </CardTitle>
              <CardDescription>The automatic run happens every morning from 06:00 Colombo — next: {data.nextRun}. Use this to bill earlier or to retry a failed month.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {data.raisable.map((r) => (
                <option key={r.period} value={r.period}>{r.label}</option>
              ))}
            </Select>
            <Button onClick={raise} loading={raising} disabled={!period || !s.enabled} className="w-full">
              <FileText className="h-4 w-4" /> Raise invoice
            </Button>
            <p className="text-xs text-slate-500">A month that already has a live invoice returns it rather than raising a second one.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Invoice history</CardTitle>
            <CardDescription>Every month this project has been billed, with what the usage cost you underneath.</CardDescription>
          </div>
          <Link href="/invoices" className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
            Invoices page <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </CardHeader>
        <CardContent>
          {data.history.length === 0 ? (
            <EmptyState icon={<FileText className="h-6 w-6" />} title="No invoices yet" description="The first one is raised on the 1st of the month after billing starts." className="py-8" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 font-semibold">Month</th>
                  <th className="py-2 font-semibold">Invoice</th>
                  <th className="py-2 font-semibold">Total</th>
                  <th className="hidden py-2 font-semibold md:table-cell">Model cost</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => {
                  const link = LINK_STATUS[h.status];
                  const inv = h.invoice ? invoiceStatusLabel(h.invoice.status) : null;
                  return (
                    <tr key={h.id} className="border-t border-slate-100">
                      <td className="py-2.5 text-slate-800">{h.label}</td>
                      <td className="py-2.5">
                        {h.invoice ? (
                          h.invoice.shareToken ? (
                            <a href={`/public/invoice/${h.invoice.shareToken}`} target="_blank" rel="noopener noreferrer" className="font-medium text-primary-700 hover:underline">
                              {h.invoice.number}
                            </a>
                          ) : (
                            <span className="font-medium text-slate-800">{h.invoice.number}</span>
                          )
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                        {h.invoice && <span className="ml-2 text-xs text-slate-400">{shortDate(h.invoice.date)}</span>}
                      </td>
                      <td className="py-2.5 font-medium text-slate-900">{h.total != null && h.status === "created" ? formatCurrency(h.total, h.currency ?? "LKR") : "—"}</td>
                      <td className="hidden py-2.5 text-slate-500 md:table-cell">{usd(h.usageCostUsd)}{h.markup ? ` × ${h.markup}` : ""}</td>
                      <td className="py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {inv ? <Badge className={inv.className}>{inv.label}</Badge> : <Badge className={link.className}>{link.label}</Badge>}
                          {h.emailed && <span className="text-xs text-slate-400">emailed</span>}
                          {h.error && <span className="text-xs text-rose-600" title={h.error}>{h.error.slice(0, 60)}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
