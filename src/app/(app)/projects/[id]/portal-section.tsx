"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Link as LinkIcon,
  Copy,
  Check,
  Plus,
  Trash2,
  CalendarDays,
  FileText,
  RefreshCw,
  ExternalLink,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import type { ProjectDocumentRequest } from "@/lib/types";
import {
  createDocumentRequest,
  deleteDocumentRequest,
  regenerateShareToken,
} from "./actions";

export function PortalSection({
  projectId,
  shareToken,
  requests = [],
  isProjectCompleted = false,
}: {
  projectId: string;
  shareToken: string;
  requests: ProjectDocumentRequest[];
  isProjectCompleted?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [regenerating, setRegenerating] = React.useState(false);

  const portalUrl = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/public/project/${shareToken}`;
  }, [shareToken]);

  function copyLink() {
    navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    toast.success("Client portal link copied!");
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleAdd() {
    if (!title.trim()) {
      toast.error("Request title is required.");
      return;
    }
    setLoading(true);
    const res = await createDocumentRequest(projectId, title, desc);
    setLoading(false);
    if (res.ok) {
      toast.success("Document requested!");
      setTitle("");
      setDesc("");
    } else {
      toast.error(res.error);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this request from the timeline?")) return;
    const res = await deleteDocumentRequest(id, projectId);
    if (res.ok) {
      toast.success("Request deleted");
    } else {
      toast.error(res.error);
    }
  }

  async function handleRegenerate() {
    if (
      !confirm(
        "Warning: Regenerating the token will immediately invalidate the current sharing link. Continue?"
      )
    )
      return;
    setRegenerating(true);
    const res = await regenerateShareToken(projectId);
    setRegenerating(false);
    if (res.ok) {
      toast.success("New portal link generated!");
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="space-y-6">
      {/* Share Link Card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <LinkIcon className="h-5 w-5 text-primary-600" />
          <h3 className="text-sm font-semibold text-slate-800">Public Client Portal</h3>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Generate a unique secret URL to share with the client. The client can view payments, 
          balance due, and upload logo or company profile resources directly into the timeline.
        </p>

        <div className="flex gap-2 flex-col sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <input
              type="text"
              readOnly
              value={portalUrl}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 focus:outline-none select-all pr-10"
            />
            <button
              onClick={copyLink}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 transition"
              title="Copy Link"
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>

          <div className="flex gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerate}
              disabled={regenerating || isProjectCompleted}
              className="text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${regenerating && "animate-spin"}`} />
              Regen Token
            </Button>
            <a href={portalUrl} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="outline" className="text-xs">
                <ExternalLink className="h-3.5 w-3.5 mr-1" />
                Open
              </Button>
            </a>
          </div>
        </div>
      </div>

      {/* Document Requests Timeline */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-slate-400" />
          Resources Timeline Request
        </h3>

        {requests.length === 0 ? (
          <p className="text-xs text-slate-400 py-6 text-center">
            No document requests created for this project yet. Use the form below to request assets from the client.
          </p>
        ) : (
          <div className="relative border-l border-slate-200 ml-3 pl-6 space-y-6">
            {requests.map((req) => (
              <div key={req.id} className="relative">
                {/* Timeline Dot */}
                <span className={`absolute -left-[31px] top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 bg-white transition ${
                  req.status === "submitted" 
                    ? "border-emerald-500 bg-emerald-500" 
                    : "border-slate-300"
                }`}>
                  {req.status === "submitted" && (
                    <Check className="h-2 w-2 text-white" strokeWidth={4} />
                  )}
                </span>

                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-800">{req.title}</h4>
                    {req.description && (
                      <p className="text-xs text-slate-500 mt-0.5">{req.description}</p>
                    )}

                    {req.status === "submitted" ? (
                      <div className="mt-2 inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-2 py-1 border border-emerald-100 text-xs text-emerald-800">
                        <FileText className="h-3.5 w-3.5 text-emerald-600" />
                        <a 
                          href={req.file_url!} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="font-semibold underline hover:text-emerald-900 truncate max-w-[200px]"
                        >
                          {req.file_name}
                        </a>
                        <span className="text-[10px] text-emerald-500/80">
                          {req.submitted_at ? ` · ${new Date(req.submitted_at).toLocaleDateString()}` : ""}
                        </span>
                      </div>
                    ) : (
                      <span className="mt-2 inline-block rounded-md bg-amber-50 px-1.5 py-0.5 border border-amber-100 text-[10px] font-semibold text-amber-700 uppercase">
                        Waiting for Client
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => handleDelete(req.id)}
                    className="p-1 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-rose-600 transition"
                    title="Remove from timeline"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add Request Form */}
        <div className="border-t border-slate-100 pt-5 mt-5 space-y-4">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Request a Document</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Document Title" required>
              <Input
                placeholder="e.g. Logo Vector, Pitch Deck PDF"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isProjectCompleted}
              />
            </Field>
            <Field label="Description (Optional)">
              <Input
                placeholder="Please upload SVG format or PDF under 10MB"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                disabled={isProjectCompleted}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={loading || isProjectCompleted}
              loading={loading}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add to Timeline
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
