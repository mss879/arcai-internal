"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle2,
  FileText,
  ImageIcon,
  Link2,
  MessageCircle,
  Paperclip,
  Send,
  Undo2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { ASSET_CATEGORY_LABELS } from "@/lib/constants";
import type { ProjectDocumentRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

import { chaseAssetNow, fileWaMediaToAsset, setAssetStatus } from "./actions";
import type { DeliveryProject, WaMediaRow } from "./types";

const STATUS_META: Record<string, { label: string; badge: string }> = {
  pending: { label: "Pending", badge: "bg-amber-50 text-amber-600 ring-amber-200" },
  submitted: {
    label: "Received",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  },
  na: { label: "N/A", badge: "bg-slate-100 text-slate-500 ring-slate-200" },
};

export function AssetsTab({
  projects,
  requests,
  unfiledMedia,
}: {
  projects: DeliveryProject[];
  requests: ProjectDocumentRequest[];
  unfiledMedia: WaMediaRow[];
}) {
  const router = useRouter();
  const [projectFilter, setProjectFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [chasing, setChasing] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const projectById = React.useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  // Only projects that actually have a checklist matter here.
  const projectsWithItems = React.useMemo(() => {
    const ids = new Set(requests.map((r) => r.project_id));
    return projects.filter((p) => ids.has(p.id));
  }, [projects, requests]);

  const filtered = requests.filter(
    (r) =>
      (!projectFilter || r.project_id === projectFilter) &&
      (!statusFilter || r.status === statusFilter),
  );

  async function handleChase(projectId: string) {
    setChasing(projectId);
    const res = await chaseAssetNow(projectId);
    setChasing(null);
    if (res.ok) {
      toast.success("Nudge sent on WhatsApp.");
      router.refresh();
    } else toast.error(res.error);
  }

  async function handleStatus(id: string, status: "pending" | "na") {
    setBusy(id);
    const res = await setAssetStatus(id, status);
    setBusy(null);
    if (res.ok) {
      toast.success(status === "na" ? "Marked not applicable." : "Reopened.");
      router.refresh();
    } else toast.error(res.error);
  }

  function portalUrl(projectId: string): string | null {
    const token = projectById.get(projectId)?.share_token;
    if (!token || typeof window === "undefined") return null;
    return `${window.location.origin}/public/project/${token}`;
  }

  return (
    <div className="space-y-6">
      {unfiledMedia.length > 0 && (
        <FilingTray
          media={unfiledMedia}
          projects={projectsWithItems}
          requests={requests}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="h-9 w-56 text-xs"
        >
          <option value="">All projects</option>
          {projectsWithItems.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 w-40 text-xs"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="submitted">Received</option>
          <option value="na">N/A</option>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Paperclip className="h-6 w-6" />}
          title="No checklist items"
          description="Start onboarding on a project (Board tab) to seed its asset checklist, or add requests from the project's portal section."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3.5 font-medium">Item</th>
                <th className="px-5 py-3.5 font-medium">Project</th>
                <th className="px-5 py-3.5 font-medium">Status</th>
                <th className="px-5 py-3.5 font-medium">File</th>
                <th className="px-5 py-3.5 font-medium">Chased</th>
                <th className="px-5 py-3.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const project = projectById.get(r.project_id);
                const status = STATUS_META[r.status] ?? STATUS_META.pending;
                return (
                  <tr key={r.id} className="group border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-slate-800">
                        {r.title}
                        {!r.required && (
                          <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                            optional
                          </span>
                        )}
                      </div>
                      {r.category && (
                        <span className="text-[11px] text-slate-400">
                          {ASSET_CATEGORY_LABELS[r.category] ?? r.category}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {project?.name ?? "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge className={status.badge}>
                        {r.source === "whatsapp" && r.status === "submitted" && (
                          <MessageCircle className="h-3 w-3" />
                        )}
                        {status.label}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5">
                      {r.file_url ? (
                        <a
                          href={r.file_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-44 items-center gap-1 truncate text-primary-600 hover:underline"
                        >
                          <Link2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{r.file_name ?? "file"}</span>
                        </a>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-400">
                      {r.chase_count > 0
                        ? `${r.chase_count}× · ${r.last_chased_at ? new Date(r.last_chased_at).toLocaleDateString() : ""}`
                        : "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {r.status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleChase(r.project_id)}
                              loading={chasing === r.project_id}
                              title="Send a WhatsApp nudge listing this project's missing items"
                            >
                              <Send className="h-3.5 w-3.5" />
                              Chase
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleStatus(r.id, "na")}
                              loading={busy === r.id}
                              title="Client doesn't have this — stop it blocking completion"
                            >
                              N/A
                            </Button>
                          </>
                        )}
                        {r.status === "na" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleStatus(r.id, "pending")}
                            loading={busy === r.id}
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                            Reopen
                          </Button>
                        )}
                        {portalUrl(r.project_id) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              navigator.clipboard.writeText(portalUrl(r.project_id)!);
                              toast.success("Portal link copied.");
                            }}
                            title="Copy the client upload page link"
                          >
                            <Link2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Client files that arrived on WhatsApp but aren't attached to any
 * checklist item yet — one click files them where they belong. */
function FilingTray({
  media,
  projects,
  requests,
}: {
  media: WaMediaRow[];
  projects: DeliveryProject[];
  requests: ProjectDocumentRequest[];
}) {
  const router = useRouter();
  const [choice, setChoice] = React.useState<Record<string, string>>({});
  const [filing, setFiling] = React.useState<string | null>(null);

  async function handleFile(mediaId: string) {
    const requestId = choice[mediaId];
    if (!requestId) {
      toast.error("Pick a checklist item first.");
      return;
    }
    setFiling(mediaId);
    const res = await fileWaMediaToAsset(requestId, mediaId);
    setFiling(null);
    if (res.ok) {
      toast.success("Filed.");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-primary-200 bg-primary-50/40 p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <MessageCircle className="h-4 w-4 text-primary-500" />
        Received on WhatsApp — awaiting filing
      </h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Files clients sent in chat that aren&apos;t attached to a checklist item yet.
        The agent files most of them itself — these are the strays.
      </p>
      <div className="mt-4 space-y-2">
        {media.slice(0, 8).map((m) => {
          const meta = (m.meta ?? {}) as {
            image_url?: string;
            document_url?: string;
            filename?: string;
          };
          const who =
            m.contact?.display_name || m.contact?.profile_name || m.contact?.wa_id || "Unknown";
          return (
            <div
              key={m.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5"
            >
              {m.message_type === "image" ? (
                <ImageIcon className="h-4 w-4 shrink-0 text-slate-400" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-700">
                  {who} · {new Date(m.created_at).toLocaleDateString()}
                </p>
                <p className="truncate text-xs text-slate-400">{m.body}</p>
              </div>
              <a
                href={meta.image_url ?? meta.document_url ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary-600 hover:underline"
              >
                view
              </a>
              <Select
                value={choice[m.id] ?? ""}
                onChange={(e) => setChoice((c) => ({ ...c, [m.id]: e.target.value }))}
                className={cn("h-8 w-64 text-xs")}
              >
                <option value="">File under…</option>
                {projects.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {requests
                      .filter((r) => r.project_id === p.id && r.status === "pending")
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.title}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
              <Button
                size="sm"
                onClick={() => handleFile(m.id)}
                loading={filing === m.id}
                disabled={!choice[m.id]}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                File
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
