"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Download, ScrollText, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { money } from "@/lib/proposal";
import type { Proposal } from "@/lib/types";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

import { deleteProposal } from "./actions";
import { downloadProposalPdf } from "./download-pdf";
import { ProposalDocument } from "./proposal-document";

export function PastProposals({ proposals }: { proposals: Proposal[] }) {
  useRealtimeSync("proposals");
  const router = useRouter();
  const [viewing, setViewing] = React.useState<Proposal | null>(null);
  const [toDelete, setToDelete] = React.useState<Proposal | null>(null);
  const [downloading, setDownloading] = React.useState(false);

  if (proposals.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="h-6 w-6" />}
        title="No saved proposals yet"
        description="Create a proposal and click Download — it'll be saved here automatically."
      />
    );
  }

  const handleDelete = async () => {
    if (!toDelete) return;
    const res = await deleteProposal(toDelete.id);
    if (res.ok) {
      toast.success("Proposal deleted.");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  };

  const handleDownload = async (p: Proposal) => {
    setDownloading(true);
    try {
      await downloadProposalPdf({
        client_name: p.client_name,
        project_name: p.project_name,
        proposal_date: p.proposal_date,
        selection: p.selection,
        content: p.content,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't download the PDF.",
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Project</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {proposals.map((p) => (
              <tr
                key={p.id}
                className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60"
              >
                <td className="px-4 py-3 font-semibold text-slate-900">
                  {p.client_name || "—"}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {p.project_name || "—"}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {fmtDate(p.proposal_date)}
                </td>
                <td className="px-4 py-3 text-right font-medium text-slate-900">
                  {money(Number(p.grand_total))}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setViewing(p)}
                    >
                      <Download className="h-4 w-4" />
                      View
                    </Button>
                    <button
                      onClick={() => setToDelete(p)}
                      aria-label="Delete proposal"
                      className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `Proposal — ${viewing.client_name}` : ""}
        size="xl"
      >
        {viewing && (
          <div className="space-y-4">
            <div className="no-print flex justify-end">
              <Button onClick={() => handleDownload(viewing)} loading={downloading}>
                <Download className="h-4 w-4" />
                Download PDF
              </Button>
            </div>
            <div className="overflow-x-auto">
              <ProposalDocument
                clientName={viewing.client_name}
                projectName={viewing.project_name}
                displayDate={fmtDate(viewing.proposal_date)}
                selection={viewing.selection}
                content={viewing.content}
              />
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={handleDelete}
        title="Delete proposal?"
        description={
          toDelete
            ? `The proposal for ${toDelete.client_name || "this client"} will be removed. This cannot be undone.`
            : undefined
        }
      />
    </div>
  );
}

function fmtDate(d: string): string {
  if (!d) return "";
  try {
    return format(new Date(d), "dd MMM, yyyy");
  } catch {
    return d;
  }
}
