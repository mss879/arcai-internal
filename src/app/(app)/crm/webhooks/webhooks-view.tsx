"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Code2,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import type { Pipeline, PipelineStage, WebhookEndpoint } from "@/lib/types";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
} from "@/app/(app)/automation/actions";

type WebhookConfig = {
  pipeline_id?: string;
  stage_id?: string;
  source?: string;
};

// Form fields the inbound route understands, shown as a quick reference.
const FIELD_HINTS: { field: string; maps: string }[] = [
  { field: "name", maps: "Lead name (or first_name + last_name)" },
  { field: "website", maps: "Their website URL" },
  { field: "phone", maps: "Contact phone / mobile / whatsapp" },
  { field: "company", maps: "Company name" },
  { field: "message", maps: "Their message / enquiry → notes" },
  { field: "subject", maps: "Subject / service they're after" },
];

export function WebhooksView({
  webhooks,
  pipelines,
  stages,
}: {
  webhooks: WebhookEndpoint[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
}) {
  useRealtimeSync("webhook_endpoints");
  const [origin, setOrigin] = React.useState("");
  React.useEffect(() => setOrigin(window.location.origin), []);

  const [creating, setCreating] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<WebhookEndpoint | null>(null);
  const router = useRouter();

  const pipelineName = new Map(pipelines.map((p) => [p.id, p.name]));
  const stageName = new Map(stages.map((s) => [s.id, s.name]));

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteWebhookEndpoint(toDelete.id);
    if (res.ok) {
      toast.success("Webhook deleted — its URL now returns 404.");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/crm"
          className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-slate-800"
          aria-label="Back to CRM"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <PageHeader
          title="Webhooks"
          description="Catch leads from forms on your website. Create a webhook, paste its URL into your form, and every submission drops straight into your pipeline."
        />
        <span className="ml-auto">
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New webhook
          </Button>
        </span>
      </div>

      <HowItWorksCard />

      {webhooks.length === 0 ? (
        <EmptyState
          icon={<Webhook className="h-6 w-6" />}
          title="No webhooks yet"
          description="Create one to get a URL you can drop into your website's contact form."
        />
      ) : (
        <div className="space-y-3">
          {webhooks.map((w) => {
            const cfg = (w.config ?? {}) as WebhookConfig;
            return (
              <WebhookCard
                key={w.id}
                webhook={w}
                url={`${origin || "https://your-app"}/api/public/hooks/${w.token}`}
                pipeline={cfg.pipeline_id ? pipelineName.get(cfg.pipeline_id) : undefined}
                stage={cfg.stage_id ? stageName.get(cfg.stage_id) : undefined}
                source={cfg.source}
                onDelete={() => setToDelete(w)}
              />
            );
          })}
        </div>
      )}

      <NewWebhookModal
        open={creating}
        onClose={() => setCreating(false)}
        pipelines={pipelines}
        stages={stages}
        onCreated={() => router.refresh()}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete this webhook?"
        description="Any form still posting to its URL will start getting 404s and those leads won't come through."
      />
    </div>
  );
}

// ---- Help card -------------------------------------------------------------

function HowItWorksCard() {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-white">
          <Webhook className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">How it works</h3>
          <ol className="mt-2 space-y-1.5 text-sm text-slate-600">
            <li>
              <span className="font-semibold text-slate-800">1.</span> Create a
              webhook and pick which pipeline &amp; stage its leads should land in.
            </li>
            <li>
              <span className="font-semibold text-slate-800">2.</span> Copy its
              URL and set it as your website form&rsquo;s submit / POST address
              (works with a plain HTML form, or JSON from a script — Zapier and
              Make too).
            </li>
            <li>
              <span className="font-semibold text-slate-800">3.</span> Every
              submission becomes a lead on your board — instantly.
            </li>
          </ol>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Name your form fields like this
          </p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {FIELD_HINTS.map((f) => (
              <div
                key={f.field}
                className="flex items-baseline gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5"
              >
                <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
                  {f.field}
                </code>
                <span className="text-xs text-slate-500">{f.maps}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Any other fields you send are kept on the lead&rsquo;s notes, so
            nothing from the form is lost.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---- One webhook -----------------------------------------------------------

function WebhookCard({
  webhook,
  url,
  pipeline,
  stage,
  source,
  onDelete,
}: {
  webhook: WebhookEndpoint;
  url: string;
  pipeline?: string;
  stage?: string;
  source?: string;
  onDelete: () => void;
}) {
  const [showExample, setShowExample] = React.useState(false);
  const curl = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Nimal Perera","website":"https://nimalperera.lk","phone":"0712345678","message":"I need a website"}'`;

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-900">{webhook.name}</span>
        <Badge className="bg-primary-50 text-primary-700 ring-primary-200">
          {pipeline || "First pipeline"}
          <ArrowRight className="mx-1 inline h-3 w-3" />
          {stage || "First stage"}
        </Badge>
        {source && (
          <Badge className="bg-slate-100 text-slate-600 ring-slate-200">
            source: {source}
          </Badge>
        )}
        <span className="ml-auto text-xs text-slate-400">
          {webhook.hits} submission{webhook.hits === 1 ? "" : "s"}
          {webhook.last_hit_at &&
            ` · last ${formatDistanceToNow(new Date(webhook.last_hit_at), { addSuffix: true })}`}
        </span>
      </div>

      {/* URL */}
      <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-emerald-300">
          {url}
        </code>
        <CopyButton value={url} className="text-slate-400 hover:bg-white/10 hover:text-white" />
      </div>

      <div className="mt-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowExample((v) => !v)}
        >
          <Code2 className="h-4 w-4" />
          Example
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", showExample && "rotate-180")}
          />
        </Button>
        <button
          onClick={onDelete}
          className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
          aria-label="Delete webhook"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {showExample && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
          <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed text-emerald-300">
            {curl}
          </pre>
          <CopyButton value={curl} className="text-slate-400 hover:bg-white/10 hover:text-white" />
        </div>
      )}
    </div>
  );
}

// ---- Create modal ----------------------------------------------------------

function NewWebhookModal({
  open,
  onClose,
  pipelines,
  stages,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  pipelines: Pipeline[];
  stages: PipelineStage[];
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [pipelineId, setPipelineId] = React.useState("");
  const [stageId, setStageId] = React.useState("");
  const [source, setSource] = React.useState("website");
  const [submitting, setSubmitting] = React.useState(false);

  function reset() {
    setName("");
    setPipelineId("");
    setStageId("");
    setSource("website");
  }

  async function handleCreate() {
    setSubmitting(true);
    const config: Record<string, unknown> = {
      ...(pipelineId ? { pipeline_id: pipelineId } : {}),
      ...(stageId ? { stage_id: stageId } : {}),
      ...(source.trim() ? { source: source.trim() } : {}),
    };
    const res = await createWebhookEndpoint({
      name: name.trim() || "Website form",
      action: "create_lead",
      config,
    });
    setSubmitting(false);
    if (res.ok) {
      toast.success("Webhook created — copy its URL into your website form.");
      reset();
      onClose();
      onCreated();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New webhook"
      description="Leads posted to this URL land in the pipeline and stage you choose."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleCreate} loading={submitting}>
            Create webhook
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="Just for you — e.g. which site or form it's for.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Main website — contact form"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pipeline" hint="Where leads land.">
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
        <Field label="Source tag" hint="Stamped on each lead so you can filter by where it came from.">
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="website"
          />
        </Field>
      </div>
    </Modal>
  );
}
