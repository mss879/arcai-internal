"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  RefreshCw,
  ScanSearch,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ResearchReportView } from "@/components/crm/research-report-view";
import {
  ResearchProgress,
  researchStartedAt,
} from "@/components/crm/research-progress";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";
import type { LeadResearch } from "@/lib/types";

import { requestLeadResearch, deleteLeadResearch } from "./actions";
import { useDriveResearch } from "./use-drive-research";

export type ResearchRow = LeadResearch & {
  lead: { id: string; title: string; company: string | null } | null;
};

const INPROGRESS = { className: "bg-sky-50 text-sky-600 ring-sky-200" };
const STATUS_META: Record<
  LeadResearch["status"],
  { label: string; className: string }
> = {
  pending: { label: "Queued", className: "bg-slate-100 text-slate-500 ring-slate-200" },
  running: { label: "Researching…", ...INPROGRESS },
  discovered: { label: "Analyzing site…", ...INPROGRESS },
  analyzed: { label: "Sizing up competitors…", ...INPROGRESS },
  audited: { label: "Writing dossier…", ...INPROGRESS },
  synthesizing: { label: "Writing dossier…", ...INPROGRESS },
  done: { label: "Ready", className: "bg-emerald-50 text-emerald-600 ring-emerald-200" },
  error: { label: "Failed", className: "bg-rose-50 text-rose-600 ring-rose-200" },
};

export function ResearchView({
  rows,
  configured,
  initialLeadId = null,
}: {
  rows: ResearchRow[];
  configured: boolean;
  /** From `?lead=<id>` — auto-opens that lead's report on load. */
  initialLeadId?: string | null;
}) {
  useRealtimeSyncTables(["lead_research"]);
  // Drive any in-progress report to completion while this page is open (local
  // dev has no per-minute cron; production also benefits as a faster nudge).
  useDriveResearch(
    rows.some((r) => r.status !== "done" && r.status !== "error"),
  );
  const router = useRouter();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prospect research"
        description="AI briefings on every prospect — company overview, competitors, pain points and call-ready talking points, gathered from LinkedIn, the web and recent news."
        actions={
          <Link
            href="/crm"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to pipeline
          </Link>
        }
      />

      {!configured && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Research isn&apos;t fully configured. Add a{" "}
          <code className="rounded bg-amber-100 px-1">FIRECRAWL_API_KEY</code>{" "}
          (web &amp; LinkedIn scraping) and an{" "}
          <code className="rounded bg-amber-100 px-1">OPENAI_API_KEY</code>{" "}
          (report writing) to your environment to enable full reports.
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<ScanSearch className="h-6 w-6" />}
          title="No research yet"
          description="Add a lead with a company name and a briefing is generated automatically. You can also run research from any lead's detail page."
          action={
            <Button onClick={() => router.push("/crm")}>Go to pipeline</Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <ResearchRowCard
              key={row.id}
              row={row}
              defaultOpen={
                !!initialLeadId &&
                row.lead?.id === initialLeadId &&
                row.status === "done"
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ResearchRowCard({
  row,
  defaultOpen = false,
}: {
  row: ResearchRow;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const [busy, setBusy] = React.useState<"run" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const meta = STATUS_META[row.status];
  const inProgress = row.status !== "done" && row.status !== "error";

  async function rerun() {
    if (!row.lead) return;
    setBusy("run");
    try {
      const res = await requestLeadResearch(row.lead.id);
      if (res.ok) {
        toast.success("Re-running research — it'll update shortly.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } catch {
      toast.error("Couldn't start research. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    const res = await deleteLeadResearch(row.id, row.lead?.id);
    setBusy(null);
    setConfirmDelete(false);
    if (res.ok) {
      toast.success("Report deleted.");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-3 p-4">
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={row.status !== "done"}
          className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-500">
            <ScanSearch className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-semibold text-slate-900">
                {row.company_name}
              </span>
              <Badge className={cn("shrink-0 ring-inset", meta.className)}>
                {inProgress && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                )}
                {meta.label}
              </Badge>
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
              {row.lead ? row.lead.title : "Lead removed"}
              <span>·</span>
              updated {formatDistanceToNow(new Date(row.updated_at), { addSuffix: true })}
            </span>
          </span>
          {row.status === "done" && (
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-slate-400 transition-transform",
                open && "rotate-180",
              )}
            />
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {row.lead && (
            <Link
              href={`/crm/lead/${row.lead.id}`}
              className="grid h-9 w-9 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-50 hover:text-slate-700"
              aria-label="Open lead"
            >
              <ExternalLink className="h-4 w-4" />
            </Link>
          )}
          {row.lead && (
            <Button variant="ghost" size="sm" onClick={rerun} loading={busy === "run"}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            className="grid h-9 w-9 place-items-center rounded-xl text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"
            aria-label="Delete report"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {inProgress && (
        <div className="border-t border-slate-100 px-4 pb-4 pt-3">
          <ResearchProgress
            status={row.status}
            startedAt={researchStartedAt(row)}
          />
        </div>
      )}

      {row.status === "error" && (
        <p className="border-t border-slate-100 bg-rose-50/50 px-4 py-2.5 text-sm text-rose-600">
          {row.error || "Research failed. Try re-running."}
        </p>
      )}

      {open && row.status === "done" && (
        <div className="border-t border-slate-100 p-4">
          <ResearchReportView research={row} />
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title="Delete this research report?"
        description="The briefing is removed. You can regenerate it later from the lead."
      />
    </div>
  );
}
