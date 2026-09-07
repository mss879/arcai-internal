"use client";

import * as React from "react";
import { toast } from "sonner";
import { FileText, FileUp, Globe, Link2, RefreshCw, Search, Trash2, Type, XCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { summariseCrawl, isActiveCrawl, type CrawlPhase } from "@/lib/ai-projects/crawl-core";
import { compact, shortDate, shortDateTime } from "@/lib/ai-projects/format";
import type { AiKbSourceKind, AiKbSourceStatus } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

import { cancelCrawl, startCrawl } from "./crawl-actions";
import { addTextSource, addUrlSource, deleteKbSource, reindexKbSource, testRetrieval, updateCrawlSchedule, uploadKbFile, type RetrievalHit } from "./kb-actions";

export type SourceRow = {
  id: string;
  kind: AiKbSourceKind;
  title: string;
  url: string | null;
  status: AiKbSourceStatus;
  error: string | null;
  chunks: number;
  sizeBytes: number | null;
  updatedAt: string;
};

export type CrawlJobRow = {
  id: string;
  status: CrawlPhase;
  triggeredBy: string;
  pages_seen: number;
  pages_changed: number;
  pages_unchanged: number;
  pages_stale: number;
  chunks_written: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  errors: string[];
};

export type KnowledgePanelData = {
  projectId: string;
  websiteUrl: string | null;
  firecrawlConfigured: boolean;
  crawlIntervalDays: number | null;
  nextCrawlAt: string | null;
  lastCrawlAt: string | null;
  job: CrawlJobRow | null;
  sources: SourceRow[];
};

const STATUS_META: Record<AiKbSourceStatus, { label: string; className: string; dot: string }> = {
  pending: { label: "Queued", className: "bg-amber-50 text-amber-700 ring-amber-200", dot: "bg-amber-500" },
  processing: { label: "Indexing", className: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500 animate-pulse" },
  ready: { label: "Ready", className: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500" },
  stale: { label: "Gone from site", className: "bg-slate-100 text-slate-500 ring-slate-200", dot: "bg-slate-400" },
};

const KIND_ICON: Record<AiKbSourceKind, React.ReactNode> = {
  text: <Type className="h-4 w-4" />,
  file: <FileText className="h-4 w-4" />,
  url: <Link2 className="h-4 w-4" />,
  crawl: <Globe className="h-4 w-4" />,
};

function report(res: { ok: true; complete: boolean; chunks: number } | { ok: false; error: string }, what: string) {
  if (!res.ok) return void toast.error(res.error);
  if (res.complete) toast.success(`${what} indexed — ${res.chunks} chunk${res.chunks === 1 ? "" : "s"}.`);
  else toast.success(`${what} saved — indexing continues in the background.`);
}

export function KnowledgePanel({ data }: { data: KnowledgePanelData }) {
  useRealtimeSyncTables(["ai_kb_sources", "ai_crawl_jobs"]);
  const [modal, setModal] = React.useState<"text" | "file" | "url" | null>(null);
  const [toDelete, setToDelete] = React.useState<SourceRow | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [crawlBusy, setCrawlBusy] = React.useState(false);

  const ready = data.sources.filter((s) => s.status === "ready");
  const chunks = data.sources.reduce((n, s) => n + s.chunks, 0);
  const jobActive = data.job ? isActiveCrawl(data.job.status) : false;

  async function reindex(s: SourceRow) {
    setBusy(s.id);
    try {
      report(await reindexKbSource(data.projectId, s.id), s.title);
    } finally {
      setBusy(null);
    }
  }

  async function crawlNow() {
    setCrawlBusy(true);
    try {
      const res = await startCrawl(data.projectId);
      if (res.ok) toast.success("Crawl started — progress shows below.");
      else toast.error(res.error);
    } finally {
      setCrawlBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setModal("text")}>
          <Type className="h-4 w-4" /> Paste text
        </Button>
        <Button variant="outline" onClick={() => setModal("file")}>
          <FileUp className="h-4 w-4" /> Upload file
        </Button>
        <Button variant="outline" onClick={() => setModal("url")} disabled={!data.firecrawlConfigured}>
          <Link2 className="h-4 w-4" /> Add a web page
        </Button>
        <span className="ml-auto text-sm text-slate-500">
          {ready.length} ready source{ready.length === 1 ? "" : "s"} · {compact(chunks)} chunks
        </span>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-slate-400" /> Website crawl
            </CardTitle>
            <CardDescription>
              {data.websiteUrl
                ? `Reads every page of ${data.websiteUrl} and keeps the agent current. Unchanged pages cost nothing to re-crawl.`
                : "Set the project's website on the Overview tab to crawl it."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {jobActive && data.job ? (
              <Button variant="outline" size="sm" onClick={async () => {
                const res = await cancelCrawl(data.projectId, data.job!.id);
                if (res.ok) toast.success("Crawl cancelled");
                else toast.error(res.error);
              }}>
                <XCircle className="h-4 w-4" /> Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={crawlNow} loading={crawlBusy} disabled={!data.websiteUrl || !data.firecrawlConfigured}>
                <RefreshCw className="h-4 w-4" /> Crawl now
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
          <div>
            {!data.firecrawlConfigured && (
              <Alert variant="error" className="mb-3">Crawling and page reading need FIRECRAWL_API_KEY set on the server.</Alert>
            )}
            {data.job ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={jobActive ? "bg-sky-50 text-sky-700 ring-sky-200" : data.job.status === "completed" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-rose-50 text-rose-700 ring-rose-200"} dot={jobActive ? "bg-sky-500 animate-pulse" : undefined}>
                    {data.job.status}
                  </Badge>
                  <span className="text-slate-700">{summariseCrawl(data.job)}</span>
                  <span className="ml-auto text-xs text-slate-400">
                    {data.job.triggeredBy === "schedule" ? "Scheduled" : "Manual"} · started {shortDateTime(data.job.startedAt)}
                    {data.job.finishedAt ? ` · finished ${shortDateTime(data.job.finishedAt)}` : ""}
                  </span>
                </div>
                {data.job.error && <p className="mt-2 text-xs text-rose-600">{data.job.error}</p>}
                {data.job.errors.length > 0 && !data.job.error && (
                  <p className="mt-2 text-xs text-amber-700">{data.job.errors.length} page{data.job.errors.length === 1 ? "" : "s"} could not be read.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No crawl yet. Last crawl: {shortDate(data.lastCrawlAt)}.</p>
            )}
          </div>
          <Field label="Schedule" hint={data.crawlIntervalDays ? `Next: ${shortDateTime(data.nextCrawlAt)}` : "Only when you press Crawl now."}>
            <Select
              value={String(data.crawlIntervalDays ?? 0)}
              onChange={async (e) => {
                const res = await updateCrawlSchedule(data.projectId, Number(e.target.value));
                if (res.ok) toast.success("Schedule saved");
                else toast.error(res.error);
              }}
              disabled={!data.websiteUrl}
            >
              <option value="0">Manual only</option>
              <option value="7">Every week</option>
              <option value="14">Every two weeks</option>
            </Select>
          </Field>
        </CardContent>
      </Card>

      {data.sources.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="Nothing to answer from yet"
          description="Paste the business's key facts, upload their brochure or price list as a PDF, add a page, or crawl their whole site."
          action={
            <Button onClick={() => setModal("text")}>
              <Type className="h-4 w-4" /> Paste text
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3 font-semibold">Source</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="hidden px-5 py-3 font-semibold md:table-cell">Chunks</th>
                <th className="hidden px-5 py-3 font-semibold lg:table-cell">Updated</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => {
                const meta = STATUS_META[s.status];
                return (
                  <tr key={s.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-5 py-3">
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 text-slate-400">{KIND_ICON[s.kind]}</span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900">{s.title}</p>
                          <p className="truncate text-xs text-slate-400">
                            {s.url ? (
                              <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                {s.url}
                              </a>
                            ) : s.kind === "file" ? formatBytes(s.sizeBytes) : "Pasted text"}
                          </p>
                          {s.error && <p className="mt-1 text-xs text-rose-600">{s.error}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <Badge className={meta.className} dot={meta.dot}>
                        {meta.label}
                      </Badge>
                    </td>
                    <td className="hidden px-5 py-3 text-slate-600 md:table-cell">{s.chunks}</td>
                    <td className="hidden px-5 py-3 text-slate-500 lg:table-cell">{shortDateTime(s.updatedAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() => reindex(s)}
                          disabled={busy === s.id || s.status === "processing"}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
                          aria-label="Re-index"
                          title={s.url ? "Re-read the page and re-index" : "Re-index"}
                        >
                          <RefreshCw className={busy === s.id ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setToDelete(s)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          aria-label="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <TestRetrieval projectId={data.projectId} disabled={ready.length === 0} />

      <AddTextModal open={modal === "text"} onClose={() => setModal(null)} projectId={data.projectId} />
      <AddFileModal open={modal === "file"} onClose={() => setModal(null)} projectId={data.projectId} />
      <AddUrlModal open={modal === "url"} onClose={() => setModal(null)} projectId={data.projectId} />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Remove this source?"
        description="The agent stops answering from it immediately."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteKbSource(data.projectId, toDelete.id);
          if (res.ok) toast.success("Removed");
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

function TestRetrieval({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<RetrievalHit[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await testRetrieval(projectId, q);
      if (!res.ok) return void toast.error(res.error);
      if (res.error) toast.error(res.error);
      setHits(res.hits);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-4 w-4 text-slate-400" /> Test what the agent finds
          </CardTitle>
          <CardDescription>Ask as a visitor would. These are the passages the agent would be handed; if the right one isn&apos;t here, add or rewrite a source.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={run} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="How much is a consultation?" disabled={disabled} />
          <Button type="submit" loading={busy} disabled={disabled || !q.trim()}>
            Search
          </Button>
        </form>
        {hits && (
          <ul className="mt-4 space-y-2">
            {hits.length === 0 && <li className="text-sm text-slate-500">Nothing scored above the threshold. The agent would say it doesn&apos;t know.</li>}
            {hits.map((h, i) => (
              <li key={i} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-700">
                    {i + 1}. {h.title}
                  </span>
                  <span className="text-slate-400">{h.similarity}% match</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{h.excerpt}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AddTextModal({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const [title, setTitle] = React.useState("");
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Paste text" description="Facts in the business's own words: services, prices, hours, policies, FAQs." size="lg"
      footer={<><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="add-text" loading={saving}>Add and index</Button></>}>
      <form id="add-text" className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setSaving(true);
        try {
          const res = await addTextSource(projectId, { title, text });
          report(res, title || "Text");
          if (res.ok) { setTitle(""); setText(""); onClose(); }
        } finally { setSaving(false); }
      }}>
        <Field label="Title" required><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Opening hours and location" /></Field>
        <Field label="Text" required hint={`${text.length.toLocaleString("en-US")} characters. Headings (# Like this) help the agent cite the right part.`}>
          <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]" />
        </Field>
      </form>
    </Modal>
  );
}

function AddFileModal({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const [title, setTitle] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [saving, setSaving] = React.useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Upload a file" description="Text, Markdown, CSV, HTML, PDF (with real text, not scans) or an image the model will describe. Up to 10 MB."
      footer={<><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="add-file" loading={saving} disabled={!file}>Upload and index</Button></>}>
      <form id="add-file" className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); if (!file) return; setSaving(true);
        try {
          const fd = new FormData(); fd.append("file", file); fd.append("title", title);
          const res = await uploadKbFile(projectId, fd);
          report(res, title || file.name);
          if (res.ok) { setTitle(""); setFile(null); onClose(); }
        } finally { setSaving(false); }
      }}>
        <Field label="File" required>
          <input type="file" accept=".txt,.md,.markdown,.csv,.html,.htm,.pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-700 hover:file:bg-primary-100" />
        </Field>
        <Field label="Title" hint="Defaults to the file name."><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Price list 2026" /></Field>
      </form>
    </Modal>
  );
}

function AddUrlModal({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const [url, setUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Add a web page" description="One page, read now. For the whole site, use the crawl above." size="sm"
      footer={<><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="add-url" loading={saving}>Read and index</Button></>}>
      <form id="add-url" className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setSaving(true);
        try {
          const res = await addUrlSource(projectId, { url });
          report(res, url);
          if (res.ok) { setUrl(""); onClose(); }
        } finally { setSaving(false); }
      }}>
        <Field label="Page address" required><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example.com/pricing" /></Field>
      </form>
    </Modal>
  );
}
