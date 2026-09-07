"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Globe, MessageSquare, Plus, Search, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { AI_STATUS_META, hostOf, usd } from "@/lib/ai-projects/format";
import type { AiProjectStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

import { createAiProject } from "./actions";

export type AiProjectCard = {
  id: string;
  name: string;
  status: AiProjectStatus;
  websiteUrl: string | null;
  agentName: string;
  model: string;
  avatarUrl: string | null;
  primaryColor: string;
  currency: "USD" | "LKR";
  lastCrawlAt: string | null;
  createdAt: string;
  clientName: string | null;
  monthCostUsd: number;
  monthConversations: number;
  monthMessages: number;
};

export type ClientOption = { id: string; label: string };

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "active", label: "Live" },
  { value: "draft", label: "Draft" },
  { value: "paused", label: "Paused" },
  { value: "archived", label: "Archived" },
];

export function AiProjectsView({
  projects,
  clients,
  initialStatus,
  periodLabelText,
}: {
  projects: AiProjectCard[];
  clients: ClientOption[];
  initialStatus: string;
  periodLabelText: string;
}) {
  useRealtimeSync("ai_projects");
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState(initialStatus);
  const [creating, setCreating] = React.useState(false);

  const shown = projects.filter((p) => {
    if (status && p.status !== status) return false;
    // Archived projects stay out of "All" — they are kept for the ledger, not the list.
    if (!status && p.status === "archived") return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.clientName ?? "").toLowerCase().includes(q) ||
      (hostOf(p.websiteUrl) ?? "").toLowerCase().includes(q)
    );
  });

  const totalCost = projects.filter((p) => p.status !== "archived").reduce((s, p) => s + p.monthCostUsd, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Projects"
        description={`Hosted website agents, one per client. ${periodLabelText} so far: ${usd(totalCost)} of model usage across ${projects.filter((p) => p.status === "active").length} live agent${projects.filter((p) => p.status === "active").length === 1 ? "" : "s"}.`}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New project
          </Button>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects…" className="pl-9" />
        </div>
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatus(f.value)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                status === f.value ? "bg-primary-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={<Bot className="h-6 w-6" />}
          title={projects.length ? "No matching projects" : "No AI projects yet"}
          description={
            projects.length
              ? "Try another search or status."
              : "Create a project for a client, teach it their business, customise the agent, then drop one line of code on their website."
          }
          action={
            !projects.length && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New project
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => {
            const meta = AI_STATUS_META[p.status];
            const host = hostOf(p.websiteUrl);
            return (
              <Link
                key={p.id}
                href={`/ai-projects/${p.id}`}
                className="group rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-lift)]"
              >
                <div className="flex items-start gap-3">
                  <span
                    className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-2xl text-white"
                    style={{ backgroundColor: p.primaryColor || "#f97316" }}
                  >
                    {p.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.avatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Bot className="h-5 w-5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate text-base font-semibold text-slate-900 group-hover:text-primary-700">
                        {p.name}
                      </h3>
                      <Badge className={meta.className} dot={meta.dot}>
                        {meta.label}
                      </Badge>
                    </div>
                    <p className="truncate text-sm text-slate-500">
                      {p.clientName ?? "No client linked"}
                      {host ? ` · ${host}` : ""}
                    </p>
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <dt className="flex items-center gap-1 text-slate-400">
                      <Wallet className="h-3 w-3" /> This month
                    </dt>
                    <dd className="mt-0.5 font-semibold text-slate-900">{usd(p.monthCostUsd)}</dd>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <dt className="flex items-center gap-1 text-slate-400">
                      <MessageSquare className="h-3 w-3" /> Chats
                    </dt>
                    <dd className="mt-0.5 font-semibold text-slate-900">{p.monthConversations}</dd>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2">
                    <dt className="flex items-center gap-1 text-slate-400">
                      <Globe className="h-3 w-3" /> Crawl
                    </dt>
                    <dd className="mt-0.5 truncate font-semibold text-slate-900">
                      {p.lastCrawlAt ? new Date(p.lastCrawlAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 truncate text-xs text-slate-400">
                  {p.agentName} · {p.model}
                </p>
              </Link>
            );
          })}
        </div>
      )}

      <NewProjectModal
        open={creating}
        onClose={() => setCreating(false)}
        clients={clients}
        onCreated={(id) => {
          setCreating(false);
          router.push(`/ai-projects/${id}`);
        }}
      />
    </div>
  );
}

function NewProjectModal({
  open,
  onClose,
  clients,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  clients: ClientOption[];
  onCreated: (id: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [websiteUrl, setWebsiteUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await createAiProject({ name, clientId: clientId || null, websiteUrl });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Project created — it starts as a draft.");
      setName("");
      setClientId("");
      setWebsiteUrl("");
      onCreated(res.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New AI project"
      description="One project per client business. You can change everything later."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="new-ai-project" loading={saving}>
            Create project
          </Button>
        </>
      }
    >
      <form id="new-ai-project" onSubmit={submit} className="space-y-4">
        <Field label="Project name" required hint="Usually the client's business name.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Silverline Dental" autoFocus />
        </Field>
        <Field label="Client" hint="Links invoices, the statement and the portal to this client.">
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">No client yet</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Website" hint="The site the widget will live on; also what the crawler reads.">
          <Input value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://www.example.com" />
        </Field>
      </form>
    </Modal>
  );
}
