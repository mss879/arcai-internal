"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { ArchiveRestore, ArrowLeft, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatCurrency } from "@/lib/utils";
import type { Lead } from "@/lib/types";

import { deleteLead, restoreLead } from "../actions";

export function TrashView({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [toDelete, setToDelete] = React.useState<Lead | null>(null);

  async function handleRestore(lead: Lead) {
    const res = await restoreLead(lead.id);
    if (res.ok) {
      toast.success(`"${lead.title}" restored to the board.`);
      router.refresh();
    } else toast.error(res.error);
  }

  async function handleDelete() {
    if (!toDelete) return;
    const res = await deleteLead(toDelete.id);
    if (res.ok) {
      toast.success("Deleted forever.");
      router.refresh();
    } else toast.error(res.error);
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
          title="Trash"
          description="Trashed leads keep their full history. Restore them any time, or delete forever."
        />
      </div>

      {leads.length === 0 ? (
        <EmptyState
          icon={<Trash2 className="h-6 w-6" />}
          title="Trash is empty"
          description="Leads you trash from the board or a lead page land here."
        />
      ) : (
        <div className="space-y-2">
          {leads.map((lead) => (
            <div
              key={lead.id}
              className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-[var(--shadow-card)]"
            >
              <span className="text-sm font-medium text-slate-700">{lead.title}</span>
              {lead.value != null && (
                <span className="text-xs text-slate-400">
                  {formatCurrency(Number(lead.value), lead.currency)}
                </span>
              )}
              {lead.deleted_at && (
                <span className="text-xs text-slate-400">
                  · trashed {formatDistanceToNow(new Date(lead.deleted_at), { addSuffix: true })}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={() => handleRestore(lead)}>
                  <ArchiveRestore className="h-3.5 w-3.5" />
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-rose-600 hover:bg-rose-50"
                  onClick={() => setToDelete(lead)}
                >
                  Delete forever
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title={`Permanently delete "${toDelete?.title}"?`}
        description="Its timeline, tasks and history go with it. This cannot be undone."
      />
    </div>
  );
}
