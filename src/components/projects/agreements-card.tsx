"use client";

import * as React from "react";
import Link from "next/link";
import { FileSignature, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * The project's contracts, and the door to raising one (0117).
 *
 * An agreement without a project link is a document somebody has to go and
 * find; from here the new one arrives already tied to this project and its
 * client, which is the whole point of the link.
 */

export type ProjectAgreement = {
  id: string;
  kind: string;
  title: string;
  status: string;
  shareToken: string;
  signedAt: string | null;
};

const STATUS: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  sent: { label: "Sent", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  viewed: { label: "Opened", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  signed: { label: "Signed", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  declined: { label: "Declined", className: "bg-rose-50 text-rose-600 ring-rose-200" },
};

export function AgreementsCard({
  projectId,
  projectName,
  clientId,
  agreements,
}: {
  projectId: string;
  projectName: string;
  clientId: string | null;
  agreements: ProjectAgreement[];
}) {
  const params = new URLSearchParams({ new: "1", project: projectId });
  if (clientId) params.set("client", clientId);
  params.set("title", `${projectName} — services agreement`);
  const newHref = `/agreements?${params.toString()}`;

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <FileSignature className="h-4 w-4 text-primary-500" />
          Agreements
        </h3>
        <Link
          href={newHref}
          className="inline-flex items-center gap-1 rounded-lg bg-primary-50 px-2.5 py-1.5 text-xs font-semibold text-primary-700 transition hover:bg-primary-100"
        >
          <Plus className="h-3.5 w-3.5" /> New agreement
        </Link>
      </div>

      {agreements.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No contract, scope of work or NDA on this project yet.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {agreements.map((a) => {
            const status = STATUS[a.status] ?? STATUS.draft;
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{a.title}</p>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    {a.kind}
                    {a.signedAt
                      ? ` · signed ${new Date(a.signedAt).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge className={status.className}>{status.label}</Badge>
                  {a.status !== "signed" && a.status !== "declined" && (
                    <CopyButton
                      value={`${origin}/a/${a.shareToken}`}
                      label="Copy the signing link"
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
