"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  Copy,
  Database,
  Eye,
  FileCode2,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { describeWait } from "@/lib/ai-projects/delivery-core";
import { shortDateTime } from "@/lib/ai-projects/format";
import type { KitFile } from "@/lib/ai-projects/kit";
import { TOOL_MAX_PARAMS } from "@/lib/ai-projects/tool-core";
import type { AiToolParam } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  deleteTool,
  saveCalendarSettings,
  saveSupabaseConnection,
  testCalendarConnection,
  testSupabaseConnection,
  retryDelivery,
  revealBackendSecret,
  revealReadKey,
  rotateBackendSecret,
  rotateReadKey,
  saveBackendConnection,
  saveDeliverySettings,
  saveTool,
  sendBackendTest,
  setToolEnabled,
  testTool,
  type ToolInput,
} from "./backend-actions";

export type ToolRow = {
  id: string;
  name: string;
  label: string;
  description: string;
  kind: "read" | "write";
  method: "GET" | "POST";
  path: string;
  parameters: AiToolParam[];
  timeoutMs: number;
  enabled: boolean;
  calls: number;
  failures: number;
  lastCalledAt: string | null;
  lastError: string | null;
};

export type DeliveryRow = {
  id: string;
  kind: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
  leadName: string | null;
};

export type BackendPanelData = {
  projectId: string;
  baseUrl: string;
  hasSecret: boolean;
  hasReadKey: boolean;
  cryptoConfigured: boolean;
  verifiedAt: string | null;
  lastError: string | null;
  deliveryEnabled: boolean;
  webhookPath: string;
  tools: ToolRow[];
  deliveries: DeliveryRow[];
  kit: KitFile[];
  supabase: {
    url: string;
    hasKey: boolean;
    table: string;
    fieldMap: Record<string, string>;
    enabled: boolean;
    verifiedAt: string | null;
    lastError: string | null;
    policySql: string;
  };
  calendar: {
    provider: "none" | "endpoint" | "cal_com";
    hasKey: boolean;
    eventTypeId: string;
    timezone: string;
    availabilityPath: string;
    bookPath: string;
    apiBase: string;
    verifiedAt: string | null;
    lastError: string | null;
  };
};

function CodeBlock({ file }: { file: KitFile }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-semibold text-slate-700">{file.path}</p>
          <p className="truncate text-[11px] text-slate-500">{file.what}</p>
        </div>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(file.body);
              toast.success(`${file.path} copied`);
            } catch {
              toast.error("Couldn't copy");
            }
          }}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-200 hover:text-slate-700"
          aria-label={`Copy ${file.path}`}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      <pre className="max-h-72 overflow-auto bg-slate-900 px-3 py-2.5 text-[11px] leading-relaxed text-slate-200">
        <code>{file.body}</code>
      </pre>
    </div>
  );
}

function SecretRow({
  label,
  hint,
  present,
  onReveal,
  onRotate,
  disabled,
}: {
  label: string;
  hint: string;
  present: boolean;
  onReveal: () => Promise<string | null>;
  onRotate: () => Promise<string | null>;
  disabled: boolean;
}) {
  const [shown, setShown] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-300">
            {shown ?? (present ? "•".repeat(28) : "not set")}
          </code>
          {shown && (
            <button
              type="button"
              onClick={() => copy(shown, label)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-400 hover:bg-white/10 hover:text-white"
              aria-label={`Copy ${label}`}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {present && !shown && (
          <Button
            variant="outline"
            size="sm"
            loading={busy}
            disabled={disabled}
            onClick={async () => {
              setBusy(true);
              try {
                setShown(await onReveal());
              } finally {
                setBusy(false);
              }
            }}
          >
            <Eye className="h-3.5 w-3.5" /> Reveal
          </Button>
        )}
        <Button
          variant={present ? "ghost" : "primary"}
          size="sm"
          loading={busy}
          disabled={disabled}
          onClick={async () => {
            if (present && !confirm(`Rotate the ${label.toLowerCase()}? The client's site stops working until they paste the new one.`)) return;
            setBusy(true);
            try {
              setShown(await onRotate());
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" /> {present ? "Rotate" : "Generate"}
        </Button>
      </div>
    </Field>
  );
}

async function copy(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy");
  }
}

export function BackendPanel({ data }: { data: BackendPanelData }) {
  useRealtimeSync("ai_deliveries");
  const [baseUrl, setBaseUrl] = React.useState(data.baseUrl);
  const [savingUrl, setSavingUrl] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [deliveryEnabled, setDeliveryEnabled] = React.useState(data.deliveryEnabled);
  const [webhookPath, setWebhookPath] = React.useState(data.webhookPath);
  const [savingDelivery, setSavingDelivery] = React.useState(false);
  const [editing, setEditing] = React.useState<ToolRow | "new" | null>(null);
  const [toDelete, setToDelete] = React.useState<ToolRow | null>(null);
  const [testingTool, setTestingTool] = React.useState<ToolRow | null>(null);

  const connected = Boolean(data.baseUrl && data.hasSecret);

  return (
    <div className="space-y-6">
      {!data.cryptoConfigured && (
        <Alert variant="error">
          <strong>SOCIAL_TOKEN_KEY is not set on the server.</strong> Secrets are encrypted with it, so nothing here can
          be stored until it is. Set it on Netlify and reload.
        </Alert>
      )}

      {/* ---- 1. Connection ---- */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-slate-400" /> The client&apos;s backend
            </CardTitle>
            <CardDescription>
              One origin, one shared secret. Everything below — the leads we push, the tools the agent calls — goes to
              this address, signed with this secret.
            </CardDescription>
          </div>
          {data.verifiedAt ? (
            <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200" dot="bg-emerald-500">
              Verified {shortDateTime(data.verifiedAt)}
            </Badge>
          ) : connected ? (
            <Badge className="bg-amber-50 text-amber-700 ring-amber-200">Not tested</Badge>
          ) : (
            <Badge>Not connected</Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {data.lastError && !data.verifiedAt && (
            <Alert variant="error">Last test failed: {data.lastError}</Alert>
          )}
          <div className="flex items-end gap-2">
            <Field
              label="Site address"
              hint="The https origin of the client's own site. In development an http://localhost address is allowed."
              className="flex-1"
            >
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://www.client.com" />
            </Field>
            <Button
              loading={savingUrl}
              onClick={async () => {
                setSavingUrl(true);
                try {
                  const res = await saveBackendConnection(data.projectId, { baseUrl });
                  if (res.ok) toast.success(baseUrl.trim() ? "Address saved" : "Backend disconnected");
                  else toast.error(res.error);
                } finally {
                  setSavingUrl(false);
                }
              }}
            >
              Save
            </Button>
          </div>

          <SecretRow
            label="Shared secret"
            hint="Goes in the client's .env as ARC_AI_SECRET. It signs everything we send them, so their server can prove a lead really came from here."
            present={data.hasSecret}
            disabled={!data.cryptoConfigured}
            onReveal={async () => {
              const res = await revealBackendSecret(data.projectId);
              if (!res.ok) {
                toast.error(res.error);
                return null;
              }
              return res.secret;
            }}
            onRotate={async () => {
              const res = await rotateBackendSecret(data.projectId);
              if (!res.ok) {
                toast.error(res.error);
                return null;
              }
              toast.success("New secret — paste it into the client's .env");
              return res.secret;
            }}
          />

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              loading={testing}
              disabled={!connected}
              onClick={async () => {
                setTesting(true);
                try {
                  const res = await sendBackendTest(data.projectId);
                  if (res.ok) toast.success(res.detail);
                  else toast.error(res.error);
                } finally {
                  setTesting(false);
                }
              }}
            >
              <Send className="h-4 w-4" /> Send test
            </Button>
            <p className="text-xs text-slate-500">
              Posts a signed <code className="font-mono">{"{ test: true }"}</code> to{" "}
              <code className="font-mono">{data.webhookPath}</code>. The kit&apos;s endpoint answers it without creating a
              lead.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ---- 2. Lead delivery ---- */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Lead delivery</CardTitle>
            <CardDescription>
              Every captured lead, posted to the client&apos;s site the moment the conversation ends. Retried for about nine
              hours if their server is down, then shown here as failed.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-3 text-sm">
              <input
                type="checkbox"
                checked={deliveryEnabled}
                onChange={(e) => setDeliveryEnabled(e.target.checked)}
                className="accent-primary-600"
                disabled={!connected}
              />
              <span className="font-medium text-slate-800">Send leads to the client&apos;s site</span>
            </label>
            <Field label="Endpoint path" className="max-w-xs flex-1">
              <Input value={webhookPath} onChange={(e) => setWebhookPath(e.target.value)} className="font-mono text-[13px]" />
            </Field>
            <Button
              variant="outline"
              loading={savingDelivery}
              onClick={async () => {
                setSavingDelivery(true);
                try {
                  const res = await saveDeliverySettings(data.projectId, { enabled: deliveryEnabled, path: webhookPath });
                  if (res.ok) toast.success("Saved");
                  else toast.error(res.error);
                } finally {
                  setSavingDelivery(false);
                }
              }}
            >
              Save
            </Button>
          </div>

          {data.deliveries.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing delivered yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 font-semibold">Lead</th>
                  <th className="py-2 font-semibold">Status</th>
                  <th className="hidden py-2 font-semibold sm:table-cell">When</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d) => (
                  <tr key={d.id} className="border-t border-slate-100">
                    <td className="py-2.5">
                      <span className="font-medium text-slate-800">{d.leadName ?? (d.kind === "handoff" ? "Hand-off" : "Lead")}</span>
                      {d.lastError && <p className="text-xs text-rose-600">{d.lastError}</p>}
                    </td>
                    <td className="py-2.5">
                      {d.status === "sent" ? (
                        <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                          <CheckCircle2 className="h-3 w-3" /> Delivered
                        </Badge>
                      ) : d.status === "failed" ? (
                        <Badge className="bg-rose-50 text-rose-700 ring-rose-200">
                          <XCircle className="h-3 w-3" /> Failed ({d.attempts})
                        </Badge>
                      ) : (
                        <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                          Retrying {describeWait(d.nextAttemptAt)}
                        </Badge>
                      )}
                    </td>
                    <td className="hidden py-2.5 text-slate-500 sm:table-cell">
                      {shortDateTime(d.deliveredAt ?? d.createdAt)}
                    </td>
                    <td className="py-2.5 text-right">
                      {d.status !== "sent" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            const res = await retryDelivery(data.projectId, d.id);
                            if (res.ok) toast.success("Delivered");
                            else toast.error(res.error);
                          }}
                        >
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ---- 3. Tools ---- */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-slate-400" /> What the agent can do
            </CardTitle>
            <CardDescription>
              Each tool is one thing the agent may ask the client&apos;s site, or do in it. The agent can only ever call what
              is listed here.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setEditing("new")} disabled={!connected}>
            <Plus className="h-4 w-4" /> Add tool
          </Button>
        </CardHeader>
        <CardContent>
          {!connected ? (
            <p className="text-sm text-slate-500">Connect the client&apos;s backend above first.</p>
          ) : data.tools.length === 0 ? (
            <EmptyState
              icon={<Wrench className="h-6 w-6" />}
              title="No tools yet"
              description="A read tool lets the agent answer from live data — is Thursday free, is that in stock. A write tool lets it act — take the booking."
              className="py-8"
            />
          ) : (
            <div className="space-y-2">
              {data.tools.map((t) => (
                <div key={t.id} className="rounded-xl border border-slate-200 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-semibold text-slate-900">{t.name}</code>
                    <Badge
                      className={
                        t.kind === "write"
                          ? "bg-amber-50 text-amber-700 ring-amber-200"
                          : "bg-sky-50 text-sky-700 ring-sky-200"
                      }
                    >
                      {t.kind}
                    </Badge>
                    {!t.enabled && <Badge>Off</Badge>}
                    {t.failures > 0 && (
                      <Badge className="bg-rose-50 text-rose-700 ring-rose-200">
                        {t.failures} of {t.calls} failed
                      </Badge>
                    )}
                    <span className="ml-auto font-mono text-xs text-slate-400">
                      {t.method} {t.path}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{t.description}</p>
                  {t.lastError && <p className="mt-1 text-xs text-rose-600">Last error: {t.lastError}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setTestingTool(t)}>
                      <Play className="h-3.5 w-3.5" /> Test
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const res = await setToolEnabled(data.projectId, t.id, !t.enabled);
                        if (!res.ok) toast.error(res.error);
                      }}
                    >
                      {t.enabled ? "Turn off" : "Turn on"}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50" onClick={() => setToDelete(t)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    {t.lastCalledAt && (
                      <span className="ml-auto text-xs text-slate-400">last used {shortDateTime(t.lastCalledAt)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- 4. The client's own Supabase ---- */}
      <SupabaseCard data={data} />

      {/* ---- 5. Calendar ---- */}
      <CalendarCard data={data} connected={connected} />

      {/* ---- 6. Read API & kit ---- */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-slate-400" /> Their dashboard, on their site
            </CardTitle>
            <CardDescription>
              The read key lets the client&apos;s own server fetch its leads and render them in their own branding. It sends
              no CORS headers, so it can only ever be used from a server — never from a browser.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <SecretRow
            label="Read key"
            hint="Goes in the client's .env as ARC_AI_READ_KEY. Server-side only — never prefix it with NEXT_PUBLIC_."
            present={data.hasReadKey}
            disabled={!data.cryptoConfigured}
            onReveal={async () => {
              const res = await revealReadKey(data.projectId);
              if (!res.ok) {
                toast.error(res.error);
                return null;
              }
              return res.key;
            }}
            onRotate={async () => {
              const res = await rotateReadKey(data.projectId);
              if (!res.ok) {
                toast.error(res.error);
                return null;
              }
              toast.success("New read key — paste it into the client's .env");
              return res.key;
            }}
          />
          <div>
            <p className="mb-2 text-sm font-medium text-slate-700">
              Paste these five files into the client&apos;s Next.js project
            </p>
            <div className="space-y-3">
              {data.kit.map((file) => (
                <CodeBlock key={file.path} file={file} />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <ToolModal
        projectId={data.projectId}
        tool={editing === "new" ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
      <TestToolModal projectId={data.projectId} tool={testingTool} onClose={() => setTestingTool(null)} />
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete this tool?"
        description="The agent stops being able to call it immediately. The client's endpoint is left alone."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteTool(data.projectId, toDelete.id);
          if (res.ok) toast.success("Deleted");
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

const LEAD_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "name", label: "Name", hint: "full_name" },
  { key: "email", label: "Email", hint: "email" },
  { key: "phone", label: "Phone", hint: "phone" },
  { key: "company", label: "Company", hint: "company" },
  { key: "interest", label: "What they want", hint: "message" },
  { key: "page_url", label: "Page they were on", hint: "source_url" },
  { key: "source", label: "Source label", hint: "source" },
  { key: "captured_at", label: "Captured at", hint: "created_at" },
];

function SupabaseCard({ data }: { data: BackendPanelData }) {
  const [url, setUrl] = React.useState(data.supabase.url);
  const [anonKey, setAnonKey] = React.useState("");
  const [table, setTable] = React.useState(data.supabase.table);
  const [enabled, setEnabled] = React.useState(data.supabase.enabled);
  const [map, setMap] = React.useState<Record<string, string>>(data.supabase.fieldMap);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-slate-400" /> Write leads into their Supabase
          </CardTitle>
          <CardDescription>
            For a client who has a Supabase project but no endpoint to post to. Each lead is inserted straight into
            their own table.
          </CardDescription>
        </div>
        {data.supabase.verifiedAt ? (
          <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200" dot="bg-emerald-500">
            Verified {shortDateTime(data.supabase.verifiedAt)}
          </Badge>
        ) : data.supabase.hasKey ? (
          <Badge className="bg-amber-50 text-amber-700 ring-amber-200">Not tested</Badge>
        ) : (
          <Badge>Not connected</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="info">
          <strong>The anon key, never the service-role key.</strong> Run the policy below in the client&apos;s SQL editor
          and the key stored here can do exactly one thing: add a lead. It cannot read their customers, cannot delete,
          and cannot touch another table — so it is close to harmless even if it leaks. A service key would be full
          admin on everything they own, and this page refuses one.
        </Alert>
        {data.supabase.lastError && !data.supabase.verifiedAt && (
          <Alert variant="error">Last test failed: {data.supabase.lastError}</Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supabase URL" hint="From their project settings — https://xxxx.supabase.co">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://abcdefgh.supabase.co" />
          </Field>
          <Field label="Anon key" hint={data.supabase.hasKey ? "A key is stored. Type a new one to replace it." : "The public anon key, not the service key."}>
            <Input
              type="password"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder={data.supabase.hasKey ? "•".repeat(24) : "eyJhbGciOi…"}
              autoComplete="off"
            />
          </Field>
        </div>
        <Field label="Leads table" hint="The table in their database that leads go into.">
          <Input value={table} onChange={(e) => setTable(e.target.value)} className="max-w-xs font-mono text-[13px]" />
        </Field>

        <Field label="Which of their columns holds what" hint="Leave a box empty and that field is simply not sent.">
          <div className="grid gap-2 sm:grid-cols-2">
            {LEAD_FIELDS.map((f) => (
              <div key={f.key} className="flex items-center gap-2">
                <span className="w-40 shrink-0 text-xs text-slate-500">{f.label}</span>
                <Input
                  value={map[f.key] ?? ""}
                  onChange={(e) => setMap((m) => ({ ...m, [f.key]: e.target.value }))}
                  placeholder={f.hint}
                  className="h-9 font-mono text-[13px]"
                />
              </div>
            ))}
          </div>
        </Field>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Run this once in their SQL editor
          </p>
          <div className="flex items-start gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
            <pre className="min-w-0 flex-1 overflow-x-auto text-[11px] leading-relaxed text-emerald-300">
              <code>{data.supabase.policySql}</code>
            </pre>
            <button
              type="button"
              onClick={() => copy(data.supabase.policySql, "Policy")}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
              aria-label="Copy policy"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-3 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-primary-600" />
            <span className="font-medium text-slate-800">Insert leads into their Supabase</span>
          </label>
          <Button
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                const res = await saveSupabaseConnection(data.projectId, { url, anonKey, table, fieldMap: map, enabled });
                if (res.ok) {
                  setAnonKey("");
                  toast.success("Saved");
                } else toast.error(res.error);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
          <Button
            variant="outline"
            loading={testing}
            disabled={!data.supabase.hasKey}
            onClick={async () => {
              setTesting(true);
              try {
                const res = await testSupabaseConnection(data.projectId);
                if (res.ok) toast.success(res.detail);
                else toast.error(res.error);
              } finally {
                setTesting(false);
              }
            }}
          >
            <Send className="h-4 w-4" /> Insert a test row
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CalendarCard({ data, connected }: { data: BackendPanelData; connected: boolean }) {
  const [provider, setProvider] = React.useState(data.calendar.provider);
  const [apiKey, setApiKey] = React.useState("");
  const [eventTypeId, setEventTypeId] = React.useState(data.calendar.eventTypeId);
  const [timezone, setTimezone] = React.useState(data.calendar.timezone);
  const [availabilityPath, setAvailabilityPath] = React.useState(data.calendar.availabilityPath);
  const [bookPath, setBookPath] = React.useState(data.calendar.bookPath);
  const [apiBase, setApiBase] = React.useState(data.calendar.apiBase);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-slate-400" /> Calendar
          </CardTitle>
          <CardDescription>
            With a calendar set, the agent gets two more abilities: it checks what is actually free before offering a
            time, and books the appointment itself. Without one it offers the booking link and captures the lead.
          </CardDescription>
        </div>
        {data.calendar.verifiedAt ? (
          <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200" dot="bg-emerald-500">
            Verified {shortDateTime(data.calendar.verifiedAt)}
          </Badge>
        ) : provider !== "none" ? (
          <Badge className="bg-amber-50 text-amber-700 ring-amber-200">Not tested</Badge>
        ) : (
          <Badge>Off</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {data.calendar.lastError && !data.calendar.verifiedAt && (
          <Alert variant="error">Last test failed: {data.calendar.lastError}</Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Where the diary lives">
            <Select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="none">No calendar</option>
              <option value="endpoint">The client&apos;s own site answers</option>
              <option value="cal_com">Cal.com</option>
            </Select>
          </Field>
          <Field label="Time zone" hint="The times the agent says and books in.">
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Colombo" />
          </Field>
        </div>

        {provider === "cal_com" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cal.com API key" hint={data.calendar.hasKey ? "A key is stored. Type a new one to replace it." : "From Cal.com → Settings → Developer → API keys."}>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={data.calendar.hasKey ? "•".repeat(24) : "cal_live_…"}
                autoComplete="off"
              />
            </Field>
            <Field label="Event type id" hint="The numeric id of the event type to book.">
              <Input value={eventTypeId} onChange={(e) => setEventTypeId(e.target.value)} placeholder="123456" />
            </Field>
            <Field label="API base" hint="Only if Cal.com moves. Blank uses https://api.cal.com/v2." className="sm:col-span-2">
              <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://api.cal.com/v2" />
            </Field>
          </div>
        )}

        {provider === "endpoint" && (
          <>
            {!connected && <Alert variant="error">Connect the client&apos;s backend at the top of this tab first.</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Availability path" hint="Answers with the free times for a date.">
                <Input value={availabilityPath} onChange={(e) => setAvailabilityPath(e.target.value)} className="font-mono text-[13px]" />
              </Field>
              <Field label="Booking path" hint="Takes the booking and confirms it.">
                <Input value={bookPath} onChange={(e) => setBookPath(e.target.value)} className="font-mono text-[13px]" />
              </Field>
            </div>
            <p className="text-xs text-slate-500">
              Both endpoints are in the kit below, ready to paste. Their server talks to whatever calendar the business
              actually uses — which is also the right home for a Google token: on the business&apos;s own server, not here.
            </p>
          </>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                const res = await saveCalendarSettings(data.projectId, {
                  provider,
                  apiKey,
                  eventTypeId,
                  timezone,
                  availabilityPath,
                  bookPath,
                  apiBase,
                });
                if (res.ok) {
                  setApiKey("");
                  toast.success(provider === "none" ? "Calendar switched off" : "Calendar saved");
                } else toast.error(res.error);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
          {provider !== "none" && (
            <Button
              variant="outline"
              loading={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  const res = await testCalendarConnection(data.projectId);
                  if (res.ok) toast.success(res.detail);
                  else toast.error(res.error);
                } finally {
                  setTesting(false);
                }
              }}
            >
              <Send className="h-4 w-4" /> Check tomorrow
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const EMPTY_TOOL: ToolInput = {
  name: "",
  label: "",
  description: "",
  kind: "read",
  method: "POST",
  path: "/api/arc/tools/",
  parameters: [],
  timeoutMs: 8000,
  enabled: true,
};

function ToolModal({
  projectId,
  tool,
  open,
  onClose,
}: {
  projectId: string;
  tool: ToolRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = React.useState<ToolInput>(EMPTY_TOOL);
  const [saving, setSaving] = React.useState(false);
  const key = tool?.id ?? "new";

  // Reset when a different tool is opened. Keyed on the id rather than an
  // effect, so nothing resets mid-edit.
  const [lastKey, setLastKey] = React.useState(key);
  if (open && lastKey !== key) {
    setLastKey(key);
    setForm(
      tool
        ? {
            toolId: tool.id,
            name: tool.name,
            label: tool.label,
            description: tool.description,
            kind: tool.kind,
            method: tool.method,
            path: tool.path,
            parameters: tool.parameters,
            timeoutMs: tool.timeoutMs,
            enabled: tool.enabled,
          }
        : EMPTY_TOOL,
    );
  }

  const set = <K extends keyof ToolInput>(k: K, v: ToolInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setParam = (i: number, patch: Partial<AiToolParam>) =>
    setForm((f) => ({ ...f, parameters: f.parameters.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tool ? `Edit ${tool.name}` : "Add a tool"}
      description="The description is what the model reads to decide when to reach for this. Write it as you would explain it to a new receptionist."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="tool-form" loading={saving}>
            Save tool
          </Button>
        </>
      }
    >
      <form
        id="tool-form"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            const res = await saveTool(projectId, form);
            if (res.ok) {
              toast.success("Tool saved");
              onClose();
            } else toast.error(res.error);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required hint="lower_snake_case. The model calls it by this.">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="check_availability" className="font-mono" />
          </Field>
          <Field label="Reads or writes" required hint="A write asks the visitor to confirm first, and is capped per conversation.">
            <Select value={form.kind} onChange={(e) => set("kind", e.target.value)}>
              <option value="read">Read — answers from live data</option>
              <option value="write">Write — changes something</option>
            </Select>
          </Field>
        </div>
        <Field label="What it does" required hint="One or two sentences. This is all the model has to go on.">
          <Textarea
            rows={3}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="Check whether a given date and time is free for an appointment at the clinic."
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shown while it runs" hint="What the visitor sees in the typing indicator.">
            <Input value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="Checking availability…" />
          </Field>
          <Field label="Timeout (ms)" hint="A visitor is waiting. 12000 is the ceiling.">
            <Input type="number" min={1000} max={12000} step={500} value={form.timeoutMs} onChange={(e) => set("timeoutMs", Number(e.target.value))} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[120px_minmax(0,1fr)]">
          <Field label="Method">
            <Select value={form.method} onChange={(e) => set("method", e.target.value)}>
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </Select>
          </Field>
          <Field label="Path on the client's site" required>
            <Input value={form.path} onChange={(e) => set("path", e.target.value)} className="font-mono text-[13px]" placeholder="/api/arc/tools/check-availability" />
          </Field>
        </div>

        <Field
          label="What it needs to know"
          hint={`Up to ${TOOL_MAX_PARAMS} fields. The model fills these in from the conversation, and they are checked before anything is sent.`}
        >
          <div className="space-y-2">
            {form.parameters.map((p, i) => (
              <div key={i} className="grid gap-2 rounded-xl border border-slate-200 p-2 sm:grid-cols-[140px_110px_minmax(0,1fr)_auto]">
                <Input value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} placeholder="day" className="font-mono text-[13px]" />
                <Select value={p.type} onChange={(e) => setParam(i, { type: e.target.value as AiToolParam["type"] })}>
                  <option value="string">text</option>
                  <option value="number">number</option>
                  <option value="boolean">yes / no</option>
                </Select>
                <Input value={p.description} onChange={(e) => setParam(i, { description: e.target.value })} placeholder="The date, as YYYY-MM-DD" />
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs text-slate-600">
                    <input type="checkbox" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} className="accent-primary-600" />
                    required
                  </label>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, parameters: f.parameters.filter((_, j) => j !== i) }))}
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    aria-label="Remove field"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {form.parameters.length < TOOL_MAX_PARAMS && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    parameters: [...f.parameters, { name: "", type: "string", description: "", required: false }],
                  }))
                }
              >
                <Plus className="h-3.5 w-3.5" /> Add a field
              </Button>
            )}
          </div>
        </Field>
      </form>
    </Modal>
  );
}

function TestToolModal({
  projectId,
  tool,
  onClose,
}: {
  projectId: string;
  tool: ToolRow | null;
  onClose: () => void;
}) {
  const [args, setArgs] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<{ succeeded: boolean; content: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastId, setLastId] = React.useState<string | null>(null);

  if (tool && lastId !== tool.id) {
    setLastId(tool.id);
    setArgs({});
    setResult(null);
  }

  return (
    <Modal
      open={Boolean(tool)}
      onClose={onClose}
      title={tool ? `Test ${tool.name}` : "Test"}
      description="Runs the real path — same validation, same signature, same guard. A write tool describes what it would do rather than doing it."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              if (!tool) return;
              setBusy(true);
              try {
                const res = await testTool(projectId, tool.id, args);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                setResult({ succeeded: res.succeeded, content: res.content });
              } finally {
                setBusy(false);
              }
            }}
          >
            <Play className="h-4 w-4" /> Run
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {(tool?.parameters ?? []).map((p) => (
          <Field key={p.name} label={`${p.name}${p.required ? " *" : ""}`} hint={p.description}>
            <Input value={args[p.name] ?? ""} onChange={(e) => setArgs((a) => ({ ...a, [p.name]: e.target.value }))} />
          </Field>
        ))}
        {(tool?.parameters ?? []).length === 0 && <p className="text-sm text-slate-500">This tool takes no arguments.</p>}
        {result && (
          <div className={cn("rounded-xl border px-3 py-2.5", result.succeeded ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50")}>
            <p className={cn("mb-1 text-xs font-semibold uppercase tracking-wide", result.succeeded ? "text-emerald-700" : "text-rose-700")}>
              {result.succeeded ? "The agent would be told" : "It failed"}
            </p>
            <pre className="overflow-auto text-xs text-slate-700">{JSON.stringify(result.content, null, 2)}</pre>
          </div>
        )}
      </div>
    </Modal>
  );
}
