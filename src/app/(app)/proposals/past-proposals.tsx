"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Download,
  FileSignature,
  FolderKanban,
  Link2,
  Mail,
  Pencil,
  ScrollText,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { buildPricing, money } from "@/lib/proposal";
import type { Proposal } from "@/lib/types";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";

import { deleteProposal } from "./actions";
import { downloadProposalPdf } from "./download-pdf";
import { ProposalPdfFrame } from "./proposal-pdf-frame";
import { ComposeEmailModal } from "@/components/email/compose-email-modal";
import { firstNameOf } from "@/lib/email-templates";

/**
 * 0117 — raise the contract behind an accepted proposal, already linked to
 * it and to the client, so the agreement page needs nothing re-found.
 */
function agreementHref(p: Proposal): string {
  const params = new URLSearchParams({
    new: "1",
    proposal: p.id,
    title: `${p.project_name} — services agreement`,
  });
  if (p.client_id) params.set("client", p.client_id);
  return `/agreements?${params.toString()}`;
}

/** Where the client signs. Absolute, because it gets pasted into a message. */
function shareUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/p/${token}`;
}

/**
 * 0117 — what the client has done with it.
 *
 * A proposal used to have no state at all: the list showed everything ever
 * created, identically, whether it had been opened, signed or forgotten.
 */
function ProposalStatusBadge({ proposal }: { proposal: Proposal }) {
  const meta: Record<string, { label: string; className: string }> = {
    draft: { label: "Draft", className: "bg-slate-100 text-slate-600 ring-slate-200" },
    sent: { label: "Sent", className: "bg-sky-50 text-sky-700 ring-sky-200" },
    viewed: { label: "Opened", className: "bg-amber-50 text-amber-700 ring-amber-200" },
    accepted: {
      label: "Signed",
      className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
    declined: { label: "Declined", className: "bg-rose-50 text-rose-600 ring-rose-200" },
  };
  const status = meta[proposal.status] ?? meta.draft;
  return <Badge className={status.className}>{status.label}</Badge>;
}

export function PastProposals({
  proposals,
  onEdit,
}: {
  proposals: Proposal[];
  /** Reopen a saved proposal in the generator. */
  onEdit: (p: Proposal) => void;
}) {
  useRealtimeSync("proposals");
  const router = useRouter();
  const [viewing, setViewing] = React.useState<Proposal | null>(null);
  const [toDelete, setToDelete] = React.useState<Proposal | null>(null);
  const [downloading, setDownloading] = React.useState(false);
  const [emailing, setEmailing] = React.useState<Proposal | null>(null);

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
                  <Recurring proposal={p} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <ProposalStatusBadge proposal={p} />
                    {p.share_token && (
                      <CopyButton
                        value={shareUrl(p.share_token)}
                        label="Copy the signing link"
                      />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setViewing(p)}
                    >
                      <Download className="h-4 w-4" />
                      View
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEmailing(p)}>
                      <Mail className="h-4 w-4" />
                      Email
                    </Button>
                    <Link href={agreementHref(p)}>
                      <Button size="sm" variant="ghost" title="Raise the contract behind this proposal">
                        <FileSignature className="h-4 w-4" />
                        Agreement
                      </Button>
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => onEdit(p)}>
                      <Pencil className="h-4 w-4" />
                      Edit
                    </Button>
                    {/* 0112 — the proposal starts the project, prefilled. */}
                    {p.project_id ? (
                      <Link href={`/projects/${p.project_id}`}>
                        <Button size="sm" variant="ghost">
                          <FolderKanban className="h-4 w-4" />
                          Open project
                        </Button>
                      </Link>
                    ) : (
                      <Link href={`/projects?new=1&proposal=${p.id}`}>
                        <Button size="sm" variant="ghost">
                          <FolderKanban className="h-4 w-4" />
                          Start project
                        </Button>
                      </Link>
                    )}
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

      {/* Email a saved proposal — the same PDF the Download button produces. */}
      <ComposeEmailModal
        open={!!emailing}
        onClose={() => setEmailing(null)}
        title={emailing ? `Email the ${emailing.project_name} proposal` : "Email proposal"}
        subject={emailing ? `Proposal — ${emailing.project_name}` : ""}
        body={
          emailing
            ? `Hi ${firstNameOf(emailing.client_name) || "there"},\nOur proposal for ${emailing.project_name} is attached.\nHappy to walk you through it whenever suits.`
            : ""
        }
        links={{
          clientId: emailing?.client_id ?? null,
          leadId: emailing?.lead_id ?? null,
          projectId: emailing?.project_id ?? null,
          proposalId: emailing?.id ?? null,
        }}
        attachProposalId={emailing?.id ?? null}
        attachmentLabel="Proposal attached as a PDF"
        cta={
          emailing?.share_token
            ? {
                href: shareUrl(emailing.share_token),
                label: "Read & sign the proposal",
              }
            : null
        }
        onSent={() => router.refresh()}
      />

      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `Proposal — ${viewing.client_name}` : ""}
        size="xl"
      >
        {viewing && (
          <div className="space-y-4">
            <div className="no-print flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  const p = viewing;
                  setViewing(null);
                  onEdit(p);
                }}
              >
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
              <Button onClick={() => handleDownload(viewing)} loading={downloading}>
                <Download className="h-4 w-4" />
                Download PDF
              </Button>
            </div>
            <ProposalPdfFrame
              className="h-[72vh]"
              debounceMs={0}
              payload={{
                client_name: viewing.client_name,
                project_name: viewing.project_name,
                proposal_date: viewing.proposal_date,
                selection: viewing.selection,
                content: viewing.content,
              }}
            />
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

/**
 * What this proposal is worth every month, printed under the one-time total.
 *
 * `grand_total` is the ONE-TIME money — the figure Finance reads as cash now —
 * so a proposal carrying a monthly retainer is worth more than the number in
 * this column, every month, and showing only that number would understate it.
 * Re-priced from the stored selection exactly as the PDF does; a legacy
 * proposal can't produce a recurring line, so nothing prints for one.
 */
function Recurring({ proposal }: { proposal: Proposal }) {
  const pricing = React.useMemo(() => {
    try {
      return buildPricing(proposal.selection);
    } catch {
      // A malformed stored selection must cost this one row its subtitle, not
      // take the whole table down.
      return null;
    }
  }, [proposal.selection]);

  const monthly = pricing?.monthlyTotal ?? 0;
  const yearly = pricing?.yearlyTotal ?? 0;
  if (monthly <= 0 && yearly <= 0) return null;

  return (
    <span className="block text-[11px] font-normal text-slate-400">
      {monthly > 0 && `+ ${money(monthly)}/month`}
      {monthly > 0 && yearly > 0 && " · "}
      {yearly > 0 && `+ ${money(yearly)}/year`}
    </span>
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
