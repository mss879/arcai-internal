"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Download, History, Trash2 } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import type { ContentGeneration } from "@/lib/types";

import { deleteGeneration } from "./actions";

async function downloadImage(url: string, filename: string) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function HistoryTab({
  generations,
}: {
  generations: ContentGeneration[];
}) {
  const router = useRouter();
  const [toDelete, setToDelete] = React.useState<ContentGeneration | null>(null);

  if (generations.length === 0) {
    return (
      <EmptyState
        icon={<History className="h-6 w-6" />}
        title="No generations yet"
        description="Images you create in the Generate tab are saved here."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {generations.map((g) => (
          <div
            key={g.id}
            className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]"
          >
            <div className="relative aspect-square bg-slate-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={g.image_url}
                alt={g.prompt}
                className="h-full w-full object-cover"
              />
              <div className="absolute right-2 top-2 flex gap-1.5 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={() =>
                    downloadImage(g.image_url, `arc-${g.id.slice(0, 8)}.png`)
                  }
                  aria-label="Download"
                  className="grid h-8 w-8 place-items-center rounded-lg bg-white/85 text-slate-600 backdrop-blur transition hover:text-primary-600"
                >
                  <Download className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setToDelete(g)}
                  aria-label="Delete"
                  className="grid h-8 w-8 place-items-center rounded-lg bg-white/85 text-slate-600 backdrop-blur transition hover:text-rose-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="absolute left-2 top-2 flex gap-1">
                <span className="rounded-md bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                  {g.image_size}
                </span>
                <span className="rounded-md bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                  {g.aspect_ratio}
                </span>
              </div>
            </div>
            <div className="flex flex-1 flex-col p-3">
              <p className="line-clamp-2 text-xs text-slate-600" title={g.prompt}>
                {g.prompt}
              </p>
              <p className="mt-2 text-[11px] text-slate-400">
                {formatDistanceToNow(new Date(g.created_at), {
                  addSuffix: true,
                })}
              </p>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete generation"
        description="Remove this image from your history? This can't be undone."
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteGeneration(toDelete.id, toDelete.image_path);
          if (res.ok) {
            toast.success("Deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}
