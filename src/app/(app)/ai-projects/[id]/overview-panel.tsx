"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, KeyRound, RefreshCw } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input, Select } from "@/components/ui/input";
import { AI_STATUS_META, compact, maskKey, shortDate, usd } from "@/lib/ai-projects/format";
import type { AiProjectStatus } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";

import { archiveAiProject, rotatePublicKey, setAiProjectStatus, updateAiProjectBasics } from "./actions";

export type OverviewData = {
  id: string;
  name: string;
  status: AiProjectStatus;
  clientId: string | null;
  websiteUrl: string | null;
  publicKey: string;
  allowedOrigins: string[];
  agentName: string;
  model: string;
  tools: string[];
  knowledge: { ready: number; pending: number; failed: number; chunks: number; lastCrawlAt: string | null; nextCrawlAt: string | null; crawlIntervalDays: number | null };
  month: { label: string; costUsd: number; conversations: number; messages: number };
  today: { messages: number; cap: number };
  billing: {
    enabled: boolean;
    currency: "USD" | "LKR";
    fee: number;
    markup: number;
    minimum: number;
    fx: number | null;
    mode: "draft" | "auto_send";
    nextInvoiceOn: string;
    lastInvoice: { number: string; total: number; currency: string | null; status: string } | null;
  };
  clients: { id: string; label: string }[];
};

export function OverviewPanel({ data }: { data: OverviewData }) {
  const [name, setName] = React.useState(data.name);
  const [clientId, setClientId] = React.useState(data.clientId ?? "");
  const [websiteUrl, setWebsiteUrl] = React.useState(data.websiteUrl ?? "");
  const [saving, setSaving] = React.useState(false);
  const [statusBusy, setStatusBusy] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const [confirmRotate, setConfirmRotate] = React.useState(false);

  const meta = AI_STATUS_META[data.status];
  const dirty = name !== data.name || (clientId || "") !== (data.clientId ?? "") || websiteUrl !== (data.websiteUrl ?? "");

  async function saveBasics(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await updateAiProjectBasics(data.id, { name, clientId: clientId || null, websiteUrl });
      if (res.ok) toast.success("Saved");
      else toast.error(res.error);
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(status: AiProjectStatus) {
    if (status === data.status) return;
    setStatusBusy(true);
    try {
      const res = await setAiProjectStatus(data.id, status);
      if (res.ok) toast.success(status === "active" ? "The agent is live." : `Status set to ${AI_STATUS_META[status].label.toLowerCase()}.`);
      else toast.error(res.error);
    } finally {
      setStatusBusy(false);
    }
  }

  const readyToGoLive = data.knowledge.ready > 0 && data.allowedOrigins.length > 0;

  return (
    <div className="space-y-6">
      {data.status === "draft" && !readyToGoLive && (
        <Alert variant="info">
          Before going live: add at least one knowledge source on the Knowledge tab, set the agent up on the Agent tab, and
          list the client&apos;s website under allowed origins on the Deploy tab.
        </Alert>
      )}
      {data.status === "active" && data.allowedOrigins.length === 0 && (
        <Alert variant="error">
          This project is live but has no allowed origins, so the widget will refuse every website except the preview
          here. Add the client&apos;s domain on the Deploy tab.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Basics</CardTitle>
              <CardDescription>Who this agent works for and where it lives.</CardDescription>
            </div>
            <Badge className={meta.className} dot={meta.dot}>
              {meta.label}
            </Badge>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveBasics} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Project name" required>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Client" hint="Invoices go to this client's email and statement.">
                  <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">No client linked</option>
                    {data.clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Website" hint="What the crawler reads. The widget's allowed origins are set on the Deploy tab.">
                <Input value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://www.example.com" />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" loading={saving} disabled={!dirty}>
                  Save
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Status</CardTitle>
              <CardDescription>{meta.blurb}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.status === "archived" ? (
              <Button variant="outline" onClick={() => changeStatus("draft")} loading={statusBusy} className="w-full">
                Restore as draft
              </Button>
            ) : (
              <>
                <Select value={data.status} onChange={(e) => changeStatus(e.target.value as AiProjectStatus)} disabled={statusBusy}>
                  <option value="draft">Draft — preview only</option>
                  <option value="active">Live — serving the client&apos;s site</option>
                  <option value="paused">Paused — widget hidden</option>
                </Select>
                <Button variant="ghost" className="w-full text-rose-600 hover:bg-rose-50" onClick={() => setConfirmArchive(true)}>
                  Archive project
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{data.month.label}</CardTitle>
              <CardDescription>Model usage so far this month.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tracking-tight text-slate-900">{usd(data.month.costUsd)}</p>
            <p className="mt-1 text-sm text-slate-500">
              {data.month.conversations} conversation{data.month.conversations === 1 ? "" : "s"} · {compact(data.month.messages)} messages
            </p>
            <div className="mt-4">
              <div className="flex justify-between text-xs text-slate-500">
                <span>Today</span>
                <span>
                  {data.today.messages} / {data.today.cap} messages
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                <div
                  className={data.today.messages >= data.today.cap ? "h-1.5 rounded-full bg-rose-500" : "h-1.5 rounded-full bg-primary-400"}
                  style={{ width: `${Math.min(100, (data.today.messages / Math.max(1, data.today.cap)) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-400">The daily cap is the cost circuit breaker; change it on the Agent tab.</p>
            </div>
            <Link href={`/ai-projects/${data.id}?tab=analytics`} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
              Analytics <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Knowledge</CardTitle>
              <CardDescription>What the agent can answer from.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tracking-tight text-slate-900">{data.knowledge.ready}</p>
            <p className="mt-1 text-sm text-slate-500">
              ready source{data.knowledge.ready === 1 ? "" : "s"} · {compact(data.knowledge.chunks)} chunks
              {data.knowledge.pending ? ` · ${data.knowledge.pending} indexing` : ""}
              {data.knowledge.failed ? ` · ${data.knowledge.failed} failed` : ""}
            </p>
            <dl className="mt-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Last crawl</dt>
                <dd className="text-slate-900">{shortDate(data.knowledge.lastCrawlAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Next crawl</dt>
                <dd className="text-slate-900">
                  {data.knowledge.crawlIntervalDays ? shortDate(data.knowledge.nextCrawlAt) : "Manual only"}
                </dd>
              </div>
            </dl>
            <Link href={`/ai-projects/${data.id}?tab=knowledge`} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
              Manage knowledge <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Agent</CardTitle>
              <CardDescription>Who visitors talk to.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold text-slate-900">{data.agentName}</p>
            <p className="mt-1 text-sm text-slate-500">{data.model}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {data.tools.length ? (
                data.tools.map((t) => (
                  <Badge key={t} className="bg-primary-50 text-primary-700 ring-primary-100">
                    {t}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-slate-400">Answers only — no tools switched on.</span>
              )}
            </div>
            <Link href={`/ai-projects/${data.id}?tab=agent`} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
              Customise <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Billing</CardTitle>
              <CardDescription>How this month becomes an invoice.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data.billing.enabled ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <dt className="text-slate-500">Currency</dt>
                <dd className="text-slate-900">
                  {data.billing.currency}
                  {data.billing.currency === "LKR" ? (data.billing.fx ? ` · Rs ${data.billing.fx} per USD` : " · rate not set") : ""}
                </dd>
                <dt className="text-slate-500">Monthly fee</dt>
                <dd className="text-slate-900">{formatCurrency(data.billing.fee, data.billing.currency)}</dd>
                <dt className="text-slate-500">Usage markup</dt>
                <dd className="text-slate-900">×{data.billing.markup}</dd>
                <dt className="text-slate-500">Minimum</dt>
                <dd className="text-slate-900">{data.billing.minimum ? formatCurrency(data.billing.minimum, data.billing.currency) : "None"}</dd>
                <dt className="text-slate-500">Next invoice</dt>
                <dd className="text-slate-900">
                  {data.billing.nextInvoiceOn} · {data.billing.mode === "auto_send" ? "sent automatically" : "raised as a draft for review"}
                </dd>
                <dt className="text-slate-500">Last invoice</dt>
                <dd className="text-slate-900">
                  {data.billing.lastInvoice
                    ? `${data.billing.lastInvoice.number} · ${formatCurrency(data.billing.lastInvoice.total, data.billing.lastInvoice.currency ?? "LKR")} · ${data.billing.lastInvoice.status}`
                    : "None yet"}
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">Billing is switched off for this project. Usage is still metered.</p>
            )}
            <Link href={`/ai-projects/${data.id}?tab=invoices`} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
              Billing settings and invoices <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-slate-400" /> Snippet key
              </CardTitle>
              <CardDescription>Identifies this project in the client&apos;s snippet. The allowed origins are the gate.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-300">{maskKey(data.publicKey)}</code>
              <CopyButton value={data.publicKey} label="Copy key" className="text-slate-400 hover:bg-white/10 hover:text-white" />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Allowed origins: {data.allowedOrigins.length ? data.allowedOrigins.join(", ") : "none yet"}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={`/ai-projects/${data.id}?tab=deploy`} className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
                Deploy tab <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setConfirmRotate(true)}>
                <RefreshCw className="h-3.5 w-3.5" /> Rotate key
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title="Archive this project?"
        description="The widget stops answering and the project leaves the list. Usage history and invoices are kept. You can restore it later."
        confirmLabel="Archive"
        onConfirm={async () => {
          const res = await archiveAiProject(data.id);
          if (res.ok) toast.success("Archived");
          else toast.error(res.error);
        }}
      />
      <ConfirmDialog
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        title="Rotate the snippet key?"
        description="The current key stops working within a minute. The client must update the data-project value in their snippet, or their widget goes dark."
        confirmLabel="Rotate key"
        onConfirm={async () => {
          const res = await rotatePublicKey(data.id);
          if (res.ok) toast.success("New key issued — update the client's snippet.");
          else toast.error(res.error);
        }}
      />
      {data.status === "active" && data.knowledge.ready === 0 && (
        <p className="flex items-center gap-2 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" /> Live with an empty knowledge base: the agent can only answer from the owner&apos;s instructions.
        </p>
      )}
    </div>
  );
}
