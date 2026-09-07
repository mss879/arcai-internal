"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { BarList, Stat, TrendChart } from "@/app/(app)/web-analytics/panels";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { compact, usd } from "@/lib/ai-projects/format";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";

export type DailyPoint = {
  day: string;
  conversations: number;
  user_messages: number;
  assistant_messages: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  embedding_tokens: number;
  cost_usd: number;
  leads: number;
  handoffs: number;
};

export type Totals = {
  conversations: number;
  messages: number;
  leads: number;
  handoffs: number;
  input: number;
  cached: number;
  output: number;
  embedding: number;
  cost: number;
};

export type ModelShare = { model: string; calls: number; tokens: number; cost: number };

export type MonthRow = {
  period: string;
  label: string;
  conversations: number;
  messages: number;
  tokens: number;
  cost: number;
  invoice: { number: string; status: string; total: number; currency: string | null } | null;
};

export type AnalyticsData = {
  projectId: string;
  days: number;
  range: { from: string; to: string };
  totals: Totals;
  previous: Totals;
  daily: DailyPoint[];
  models: ModelShare[];
  months: MonthRow[];
  estimate: { total: number; currency: "USD" | "LKR"; skip: boolean; error: string | null; label: string };
};

const WINDOWS = [7, 30, 90];

function CostList({ title, rows }: { title: string; rows: ModelShare[] }) {
  const max = Math.max(...rows.map((r) => r.cost), 0.000001);
  const total = rows.reduce((n, r) => n + r.cost, 0);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="mb-3 text-sm font-medium text-slate-700">{title}</p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">No model calls in this window.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.model}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-mono text-xs text-slate-700">{r.model}</span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {usd(r.cost)}
                  <span className="ml-1 text-xs text-slate-400">{total ? `${Math.round((r.cost / total) * 100)}%` : ""}</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-primary-500/70" style={{ width: `${(r.cost / max) * 100}%` }} />
              </div>
              <p className="mt-0.5 text-[11px] text-slate-400">{r.calls.toLocaleString("en-US")} calls · {compact(r.tokens)} tokens</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnalyticsPanel({ data }: { data: AnalyticsData }) {
  const router = useRouter();
  const t = data.totals;
  const p = data.previous;
  const cachedShare = t.input ? Math.round((t.cached / t.input) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {data.range.from} → {data.range.to} · Colombo days · billable usage only (previews excluded)
        </p>
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => router.push(`/ai-projects/${data.projectId}?tab=analytics&days=${w}`)}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", data.days === w ? "bg-primary-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100")}
            >
              {w} days
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Conversations" value={t.conversations.toLocaleString("en-US")} current={t.conversations} previous={p.conversations} />
        <Stat label="Visitor messages" value={t.messages.toLocaleString("en-US")} current={t.messages} previous={p.messages} hint={t.conversations ? `${(t.messages / t.conversations).toFixed(1)} per conversation` : undefined} />
        <Stat label="Leads captured" value={t.leads.toLocaleString("en-US")} current={t.leads} previous={p.leads} />
        <Stat label="Hand-offs" value={t.handoffs.toLocaleString("en-US")} current={t.handoffs} previous={p.handoffs} goodIsUp={false} hint="Visitors who asked for a person" />
        <Stat label="Model cost" value={usd(t.cost)} current={t.cost} previous={p.cost} goodIsUp={false} hint={t.messages ? `${usd(t.cost / t.messages)} per visitor message` : undefined} />
        <Stat label="Input tokens" value={compact(t.input)} current={t.input} previous={p.input} goodIsUp={false} hint={`${cachedShare}% served from cache`} />
        <Stat label="Output tokens" value={compact(t.output)} current={t.output} previous={p.output} goodIsUp={false} />
        <Stat
          label={`Invoice estimate · ${data.estimate.label}`}
          value={data.estimate.error ? "—" : data.estimate.skip ? "Nothing yet" : formatCurrency(data.estimate.total, data.estimate.currency)}
          hint={data.estimate.error ?? "Month to date, on the project's billing terms"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <TrendChart rows={data.daily} metric="cost_usd" label="Model cost per day (USD)" />
        <TrendChart rows={data.daily} metric="user_messages" label="Visitor messages per day" />
        <TrendChart rows={data.daily} metric="conversations" label="Conversations per day" />
        <TrendChart rows={data.daily} metric="leads" label="Leads per day" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CostList title="Cost by model" rows={data.models} />
        <BarList title="Tokens by model" rows={data.models.map((m) => ({ key: m.model, count: m.tokens }))} emptyLabel="No model calls in this window." />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Month by month</CardTitle>
            <CardDescription>The last twelve months of usage beside the invoice each became.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="py-2 font-semibold">Month</th>
                <th className="py-2 font-semibold">Conversations</th>
                <th className="hidden py-2 font-semibold sm:table-cell">Messages</th>
                <th className="hidden py-2 font-semibold md:table-cell">Tokens</th>
                <th className="py-2 font-semibold">Model cost</th>
                <th className="py-2 font-semibold">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.period} className="border-t border-slate-100">
                  <td className="py-2 text-slate-800">{m.label}</td>
                  <td className="py-2 text-slate-600">{m.conversations.toLocaleString("en-US")}</td>
                  <td className="hidden py-2 text-slate-600 sm:table-cell">{m.messages.toLocaleString("en-US")}</td>
                  <td className="hidden py-2 text-slate-600 md:table-cell">{compact(m.tokens)}</td>
                  <td className="py-2 font-medium text-slate-900">{usd(m.cost)}</td>
                  <td className="py-2">
                    {m.invoice ? (
                      <Link href={`/ai-projects/${data.projectId}?tab=invoices`} className="text-primary-700 hover:underline">
                        {m.invoice.number} · {formatCurrency(m.invoice.total, m.invoice.currency ?? "LKR")} · {m.invoice.status}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {data.months.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">No usage recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
