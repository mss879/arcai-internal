"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  deleteDeliverable,
  setDeliverableVisibility,
  uploadDeliverable,
} from "@/app/(app)/projects/[id]/actions";

/**
 * The finished work, where the client can get it (0117).
 *
 * `projects.documents` was two URLs typed onto the project row, which is why
 * "send them the logo files" was still an email with an attachment and why
 * nobody could say what the client had actually been given.
 *
 * Nothing is visible to the client until somebody says so. A file lands in
 * the project first and is shared on purpose — uploading is not publishing.
 */

export type Deliverable = {
  id: string;
  title: string;
  version: number;
  sizeBytes: number | null;
  visibleToClient: boolean;
  createdAt: string;
};

function size(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DeliverablesCard({
  projectId,
  deliverables,
}: {
  projectId: string;
  deliverables: Deliverable[];
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    const form = new FormData();
    form.set("file", file);
    if (title.trim()) form.set("title", title.trim());
    const res = await uploadDeliverable(projectId, form);
    setBusy(false);
    if (res.ok) {
      setTitle("");
      if (inputRef.current) inputRef.current.value = "";
      toast.success("Uploaded. Tick 'share' when they should see it.");
      router.refresh();
    } else toast.error(res.error);
  }

  const shared = deliverables.filter((d) => d.visibleToClient).length;

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Deliverables</h3>
        <p className="text-xs text-slate-400">
          {deliverables.length === 0
            ? "Nothing yet"
            : `${shared} of ${deliverables.length} shared with the client`}
        </p>
      </div>

      <div className="mt-3 space-y-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What is it? (defaults to the filename)"
        />
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
          {busy && <Upload className="h-4 w-4 animate-pulse text-slate-400" />}
        </div>
        <p className="text-[11px] text-slate-400">
          Up to 10MB. Uploading a file with the same name makes it version 2 —
          the client sees one entry, not two.
        </p>
      </div>

      {deliverables.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-3">
          {deliverables.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-slate-800">{d.title}</span>
                {d.version > 1 && (
                  <span className="ml-1.5 text-xs text-slate-400">v{d.version}</span>
                )}
                {d.sizeBytes && (
                  <span className="ml-1.5 text-xs text-slate-400">
                    {size(d.sizeBytes)}
                  </span>
                )}
              </span>
              <button
                onClick={async () => {
                  const res = await setDeliverableVisibility(
                    d.id,
                    projectId,
                    !d.visibleToClient,
                  );
                  if (res.ok) router.refresh();
                  else toast.error(res.error);
                }}
                title={
                  d.visibleToClient
                    ? "The client can see this — hide it"
                    : "Share it with the client"
                }
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition",
                  d.visibleToClient
                    ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200",
                )}
              >
                {d.visibleToClient ? (
                  <>
                    <Eye className="h-3 w-3" /> Shared
                  </>
                ) : (
                  <>
                    <EyeOff className="h-3 w-3" /> Private
                  </>
                )}
              </button>
              <button
                onClick={async () => {
                  const res = await deleteDeliverable(d.id, projectId);
                  if (res.ok) router.refresh();
                  else toast.error(res.error);
                }}
                aria-label="Delete"
                className="shrink-0 rounded p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
