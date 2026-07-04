"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Globe, KeyRound, Plus, Trash2, Webhook } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type {
  ApiKey,
  Automation,
  Pipeline,
  PipelineStage,
  WebhookEndpoint,
} from "@/lib/types";

import {
  createApiKey,
  createWebhookEndpoint,
  deleteApiKey,
  deleteWebhookEndpoint,
  setApiKeyActive,
} from "./actions";

export function ConnectTab({
  webhooks,
  apiKeys,
  automations,
  pipelines,
  stages,
}: {
  webhooks: WebhookEndpoint[];
  apiKeys: ApiKey[];
  automations: Automation[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
}) {
  const [origin, setOrigin] = React.useState("");
  React.useEffect(() => setOrigin(window.location.origin), []);

  return (
    <div className="space-y-6">
      <FormEndpointCard origin={origin} />
      <WebhooksCard
        origin={origin}
        webhooks={webhooks}
        automations={automations}
        pipelines={pipelines}
        stages={stages}
      />
      <ApiKeysCard origin={origin} apiKeys={apiKeys} />
      <TrackingCard origin={origin} />
    </div>
  );
}

function SectionCard({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-white">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-sm text-slate-500">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function CodeLine({ value }: { value: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-emerald-300">
        {value}
      </code>
      <CopyButton value={value} className="text-slate-400 hover:bg-white/10 hover:text-white" />
    </div>
  );
}

// ---- Inquiry form endpoint ------------------------------------------------

function FormEndpointCard({ origin }: { origin: string }) {
  const url = `${origin || "https://your-app"}/api/public/forms/lead`;
  return (
    <SectionCard
      icon={<Globe className="h-5 w-5" />}
      title="Website inquiry form"
      description="Point any website form at this endpoint. Each submission becomes a CRM lead and fires the 'Inquiry form submitted' + 'Lead created' triggers (your keep-warm SMS flow)."
    >
      <CodeLine value={`POST ${url}`} />
      <CodeLine
        value={`{ "name": "Nimal Perera", "phone": "0712345678", "email": "nimal@x.lk", "message": "Need a website", "service": "Business website" }`}
      />
    </SectionCard>
  );
}

// ---- Inbound webhooks -------------------------------------------------------

function WebhooksCard({
  origin,
  webhooks,
  automations,
  pipelines,
  stages,
}: {
  origin: string;
  webhooks: WebhookEndpoint[];
  automations: Automation[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
}) {
  const [open, setOpen] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<WebhookEndpoint | null>(null);

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteWebhookEndpoint(toDelete.id);
    if (res.ok) toast.success("Webhook deleted.");
    else toast.error(res.error);
  }

  return (
    <SectionCard
      icon={<Webhook className="h-5 w-5" />}
      title="Inbound webhooks"
      description="Give Zapier, Make or any landing-page builder a URL that creates leads or fires an automation directly."
      action={
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          New webhook
        </Button>
      }
    >
      {webhooks.length > 0 && (
        <div className="mt-4 space-y-2">
          {webhooks.map((w) => (
            <div
              key={w.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5"
            >
              <span className="text-sm font-medium text-slate-800">{w.name}</span>
              <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
                {w.action === "create_lead" ? "Creates lead" : "Fires automation"}
              </Badge>
              <span className="text-xs text-slate-400">
                {w.hits} hit{w.hits === 1 ? "" : "s"}
                {w.last_hit_at &&
                  ` · last ${formatDistanceToNow(new Date(w.last_hit_at), { addSuffix: true })}`}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <code className="hidden max-w-64 overflow-x-auto whitespace-nowrap rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-500 sm:block">
                  /api/public/hooks/{w.token.slice(0, 10)}…
                </code>
                <CopyButton value={`${origin}/api/public/hooks/${w.token}`} />
                <button
                  onClick={() => setToDelete(w)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Delete webhook"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <NewWebhookModal
        open={open}
        onClose={() => setOpen(false)}
        automations={automations}
        pipelines={pipelines}
        stages={stages}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete this webhook?"
        description="Anything posting to its URL will start getting 404s."
      />
    </SectionCard>
  );
}

function NewWebhookModal({
  open,
  onClose,
  automations,
  pipelines,
  stages,
}: {
  open: boolean;
  onClose: () => void;
  automations: Automation[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
}) {
  const [name, setName] = React.useState("");
  const [action, setAction] = React.useState<"create_lead" | "fire_automation">("create_lead");
  const [pipelineId, setPipelineId] = React.useState("");
  const [stageId, setStageId] = React.useState("");
  const [automationId, setAutomationId] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleCreate() {
    setSubmitting(true);
    const config: Record<string, unknown> =
      action === "create_lead"
        ? {
            ...(pipelineId ? { pipeline_id: pipelineId } : {}),
            ...(stageId ? { stage_id: stageId } : {}),
          }
        : { automation_id: automationId };
    const res = await createWebhookEndpoint({ name, action, config });
    setSubmitting(false);
    if (res.ok) {
      toast.success("Webhook created — copy its URL from the list.");
      setName("");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New inbound webhook"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            loading={submitting}
            disabled={action === "fire_automation" && !automationId}
          >
            Create webhook
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Facebook lead ads"
          />
        </Field>
        <Field label="When it receives a POST">
          <Select
            value={action}
            onChange={(e) => setAction(e.target.value as "create_lead")}
          >
            <option value="create_lead">Create a CRM lead from the payload</option>
            <option value="fire_automation">Fire a specific automation</option>
          </Select>
        </Field>
        {action === "create_lead" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Pipeline" hint="Optional — defaults to the first.">
              <Select
                value={pipelineId}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setStageId("");
                }}
              >
                <option value="">First pipeline</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Stage">
              <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
                <option value="">First stage</option>
                {stages
                  .filter((s) => !pipelineId || s.pipeline_id === pipelineId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        ) : (
          <Field label="Automation to fire">
            <Select value={automationId} onChange={(e) => setAutomationId(e.target.value)}>
              <option value="">Pick automation…</option>
              {automations.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.is_active ? "" : " (paused)"}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ---- API keys -----------------------------------------------------------------

function ApiKeysCard({ origin, apiKeys }: { origin: string; apiKeys: ApiKey[] }) {
  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<ApiKey | null>(null);

  async function handleCreate() {
    setCreating(true);
    const res = await createApiKey("API key");
    setCreating(false);
    if (res.ok) toast.success("API key created.");
    else toast.error(res.error);
  }

  async function handleToggle(key: ApiKey) {
    const res = await setApiKeyActive(key.id, !key.is_active);
    if (!res.ok) toast.error(res.error);
  }

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteApiKey(toDelete.id);
    if (res.ok) toast.success("API key deleted.");
    else toast.error(res.error);
  }

  return (
    <SectionCard
      icon={<KeyRound className="h-5 w-5" />}
      title="Open API"
      description="Programmatic access for integrations and white-label partners. Send the key as an x-api-key header."
      action={
        <Button variant="outline" size="sm" onClick={handleCreate} loading={creating}>
          <Plus className="h-4 w-4" />
          New key
        </Button>
      }
    >
      <CodeLine
        value={`curl -H "x-api-key: arc_…" ${origin || "https://your-app"}/api/public/v1/leads`}
      />
      {apiKeys.length > 0 && (
        <div className="mt-4 space-y-2">
          {apiKeys.map((k) => (
            <div
              key={k.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5"
            >
              <span className="text-sm font-medium text-slate-800">{k.name}</span>
              <code className="rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-500">
                {k.key.slice(0, 10)}…{k.key.slice(-4)}
              </code>
              <Badge
                className={
                  k.is_active
                    ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                    : "bg-slate-100 text-slate-600 ring-slate-200"
                }
              >
                {k.is_active ? "Active" : "Disabled"}
              </Badge>
              {k.last_used_at && (
                <span className="text-xs text-slate-400">
                  used {formatDistanceToNow(new Date(k.last_used_at), { addSuffix: true })}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                <CopyButton value={k.key} />
                <Button variant="ghost" size="sm" onClick={() => handleToggle(k)}>
                  {k.is_active ? "Disable" : "Enable"}
                </Button>
                <button
                  onClick={() => setToDelete(k)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Delete key"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete this API key?"
        description="Integrations using it will stop working immediately."
      />
    </SectionCard>
  );
}

// ---- Visitor tracking snippet ---------------------------------------------------

function TrackingCard({ origin }: { origin: string }) {
  const snippet = `<script src="${origin || "https://your-app"}/api/public/track" data-site="my-site" async></script>`;
  return (
    <SectionCard
      icon={<Globe className="h-5 w-5" />}
      title="Website visitor tracking"
      description="Drop this snippet on any site to capture pageviews, form starts, submits and abandons. Results appear on the AI & Intelligence page."
    >
      <CodeLine value={snippet} />
      <p className="mt-2 text-xs text-slate-400">
        Change <code className="rounded bg-slate-100 px-1">data-site</code> per website to keep
        their stats separate.
      </p>
    </SectionCard>
  );
}
