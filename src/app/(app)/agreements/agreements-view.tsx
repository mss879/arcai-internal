"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileDown, FilePlus2, FileSignature, History, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";

import { agreementPdfUrl, sendAgreement, voidAgreement } from "./actions";
import { AgreementEditor } from "./agreement-editor";

/**
 * Contracts and NDAs — written here, signed on a link.
 *
 * Before this the agency's contracts lived in a Google Doc and a chase: a PDF
 * was emailed, printed, signed with a pen, photographed and sent back, and
 * nobody could say from the CRM whether a given project had one.
 *
 * Shaped like /proposals — a Write tab holding the editor and its live PDF
 * preview, and a list tab for everything raised so far — because they are the
 * same job, done twice, and the contract is the one that gets signed.
 */

export type AgreementRow = {
  id: string;
  kind: string;
  title: string;
  bodyMd: string;
  status: string;
  shareToken: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  proposalId: string | null;
  signerEmail: string | null;
  signedName: string | null;
  signedAt: string | null;
  sentAt: string | null;
  hasPdf: boolean;
  createdAt: string;
};

export type Template = { id: string; name: string; kind: string; body_md: string };

/** Links the editor opens with, when raised from a project or a proposal. */
export type AgreementPrefill = {
  clientId: string | null;
  projectId: string | null;
  proposalId: string | null;
  title: string | null;
};

const STATUS: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  sent: { label: "Sent", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  viewed: { label: "Opened", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  signed: {
    label: "Signed",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  declined: { label: "Declined", className: "bg-rose-50 text-rose-600 ring-rose-200" },
};

function shareUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/a/${token}`;
}

export function AgreementsView({
  agreements,
  templates,
  clients,
  prefill = null,
}: {
  agreements: AgreementRow[];
  templates: Template[];
  clients: { id: string; name: string }[];
  prefill?: AgreementPrefill | null;
}) {
  useRealtimeSync("agreements");
  const router = useRouter();
  // Arriving with `?new=1` lands straight in the editor, links already made.
  const [tab, setTab] = React.useState<"write" | "all">(
    prefill || agreements.length === 0 ? "write" : "all",
  );
  const [editing, setEditing] = React.useState<AgreementRow | null>(null);

  async function download(id: string) {
    const url = await agreementPdfUrl(id);
    if (url) window.open(url, "_blank");
    else toast.error("No signed copy filed for this one yet.");
  }

  async function send(row: AgreementRow) {
    const to = row.signerEmail?.trim();
    if (!to) {
      toast.error("Add the signer's email first — open it and save one.");
      return;
    }
    const res = await sendAgreement(row.id, to, shareUrl(row.shareToken));
    if (res.ok) {
      toast.success(`Sent to ${to}.`);
      router.refresh();
    } else toast.error(res.error);
  }

  async function withdraw(id: string) {
    const res = await voidAgreement(id);
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton
          active={tab === "write"}
          onClick={() => setTab("write")}
          icon={<FilePlus2 className="h-4 w-4" />}
        >
          {editing ? "Editing" : "Write"}
        </TabButton>
        <TabButton
          active={tab === "all"}
          onClick={() => setTab("all")}
          icon={<History className="h-4 w-4" />}
        >
          All agreements
          {agreements.length > 0 && (
            <span
              className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                tab === "all" ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
              )}
            >
              {agreements.length}
            </span>
          )}
        </TabButton>
      </div>

      {tab === "write" ? (
        <AgreementEditor
          // Remount on switch: the editor reads the row once, at mount, so the
          // form state and the agreement it belongs to can never drift.
          key={editing?.id ?? "new"}
          agreement={editing}
          templates={templates}
          clients={clients}
          prefill={editing ? null : prefill}
          onExitEdit={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setTab("all");
          }}
        />
      ) : agreements.length === 0 ? (
        <EmptyState
          icon={<FileSignature className="h-6 w-6" />}
          title="No agreements yet"
          description="Write one here and send the client a link — they read it and sign it in the browser."
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setTab("write");
              }}
            >
              <FilePlus2 className="h-4 w-4" /> New agreement
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/70 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Agreement</th>
                <th className="px-4 py-3 font-medium">With</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((a) => {
                const meta = STATUS[a.status] ?? STATUS.draft;
                return (
                  <tr
                    key={a.id}
                    className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60"
                  >
                    <td className="px-4 py-3">
                      <button
                        onClick={() => {
                          setEditing(a);
                          setTab("write");
                        }}
                        className="text-left font-semibold text-slate-900 hover:text-primary-600"
                      >
                        {a.title}
                      </button>
                      <span className="ml-2 text-xs uppercase text-slate-400">
                        {a.kind}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {a.clientName ?? a.signerEmail ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={meta.className}>{meta.label}</Badge>
                      {a.signedName && (
                        <span className="ml-2 text-xs text-slate-400">
                          by {a.signedName}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <CopyButton
                          value={shareUrl(a.shareToken)}
                          label="Copy the signing link"
                        />
                        {a.status !== "signed" && (
                          <Button size="sm" variant="ghost" onClick={() => send(a)}>
                            <Send className="h-4 w-4" />
                            {a.sentAt ? "Resend" : "Send"}
                          </Button>
                        )}
                        {a.hasPdf && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => download(a.id)}
                          >
                            <FileDown className="h-4 w-4" /> Signed copy
                          </Button>
                        )}
                        {a.status !== "signed" && (
                          <button
                            onClick={() => withdraw(a.id)}
                            aria-label="Withdraw"
                            className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
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

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active ? "bg-primary-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
