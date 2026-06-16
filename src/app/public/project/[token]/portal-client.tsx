"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Wallet,
  Clock,
  Check,
  Upload,
  CalendarDays,
  FileText,
  Loader2,
  FolderOpen,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Project, ProjectDocumentRequest } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";
import { uploadPortalFile } from "./actions";

export function PortalClient({
  token,
  project,
  initialRequests,
}: {
  token: string;
  project: Project;
  initialRequests: ProjectDocumentRequest[];
}) {
  const [requests, setRequests] = React.useState(initialRequests);
  const [uploadingId, setUploadingId] = React.useState<string | null>(null);
  const fileInputs = React.useRef<{ [key: string]: HTMLInputElement | null }>({});

  const balanceDue = React.useMemo(() => {
    return Math.max(
      0,
      Number(project.total_value || 0) - Number(project.deposit_paid || 0)
    );
  }, [project]);

  async function handleFileChange(requestId: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingId(requestId);
    const formData = new FormData();
    formData.append("file", file);

    const res = await uploadPortalFile(token, requestId, formData);
    setUploadingId(null);

    if (res.ok) {
      toast.success(`File "${file.name}" uploaded successfully!`);
      // Update local state to show submitted
      setRequests((prev) =>
        prev.map((r) =>
          r.id === requestId
            ? {
                ...r,
                status: "submitted",
                file_name: file.name,
                file_url: URL.createObjectURL(file), // temp preview, will refresh on reload
                submitted_at: new Date().toISOString(),
              }
            : r
        )
      );
    } else {
      toast.error(res.error);
    }
  }

  function triggerFileInput(requestId: string) {
    fileInputs.current[requestId]?.click();
  }

  const isCompleted = project.status === "completed";

  return (
    <div className="space-y-6 animate-float-in">
      {/* Wallet Financials */}
      <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary-500" />
          Project Wallet Info
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-slate-100 bg-white/50 p-4 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Project Value</p>
            <p className="text-2xl font-black text-slate-800 mt-2">
              {formatCurrency(Number(project.total_value) || 0, project.currency)}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-white/50 p-4 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Deposit Paid</p>
            <p className="text-2xl font-black text-emerald-600 mt-2">
              {formatCurrency(Number(project.deposit_paid) || 0, project.currency)}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-white/50 p-4 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Balance Due</p>
            <p className="text-2xl font-black text-amber-600 mt-2">
              {formatCurrency(balanceDue, project.currency)}
            </p>
          </div>
        </div>
      </div>

      {/* Timeline Request */}
      <div className="rounded-3xl border border-white/30 bg-white/70 p-6 shadow-lg backdrop-blur-xl saturate-150">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-6 flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-slate-400" />
          Document Request Timeline
        </h3>

        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <FolderOpen className="h-10 w-10 text-slate-300 mb-2" />
            <p className="text-sm font-medium text-slate-400">No requests in timeline</p>
            <p className="text-xs text-slate-300">Your project administrator hasn't requested any files yet.</p>
          </div>
        ) : (
          <div className="relative border-l border-slate-200 ml-4 pl-8 space-y-8">
            {requests.map((req) => (
              <div key={req.id} className="relative">
                {/* Timeline node icon */}
                <span className={`absolute -left-[41px] top-1 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-white shadow-sm transition-all duration-300 ${
                  req.status === "submitted"
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-slate-300 text-slate-400"
                }`}>
                  {req.status === "submitted" ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : (
                    <Clock className="h-3.5 w-3.5" />
                  )}
                </span>

                <div className="rounded-2xl border border-slate-100 bg-white/50 p-5 shadow-sm hover:shadow-md transition-all duration-300">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">{req.title}</h4>
                      {req.description && (
                        <p className="text-xs text-slate-500 mt-1">{req.description}</p>
                      )}

                      {req.status === "submitted" && (
                        <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-2.5 py-1 border border-emerald-100 text-xs text-emerald-800">
                          <FileText className="h-3.5 w-3.5 text-emerald-600" />
                          <span className="font-semibold truncate max-w-[200px]">{req.file_name}</span>
                          <span className="text-[10px] text-emerald-500/80">
                            {req.submitted_at ? ` · Uploaded ${new Date(req.submitted_at).toLocaleDateString()}` : ""}
                          </span>
                        </div>
                      )}
                    </div>

                    <div>
                      {req.status !== "submitted" && (
                        <>
                          <input
                            type="file"
                            ref={(el) => {
                              fileInputs.current[req.id] = el;
                            }}
                            onChange={(e) => handleFileChange(req.id, e)}
                            className="hidden"
                            accept="image/*,application/pdf"
                            disabled={isCompleted || uploadingId === req.id}
                          />
                          <Button
                            size="sm"
                            onClick={() => triggerFileInput(req.id)}
                            disabled={isCompleted || uploadingId === req.id}
                            className="text-xs shrink-0"
                          >
                            {uploadingId === req.id ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                Uploading...
                              </>
                            ) : (
                              <>
                                <Upload className="h-3.5 w-3.5 mr-1.5" />
                                Upload Resource
                              </>
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
