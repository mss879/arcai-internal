"use client";

import * as React from "react";
import { Check, Clock, FileDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DeclineCard,
  SignAndAccept,
} from "@/components/public/sign-and-accept";
import type { Pricing } from "@/lib/proposal";
import { cn, formatCurrency } from "@/lib/utils";

import { acceptProposal, declineProposal } from "./actions";

/**
 * The client's view of a proposal, and the place they say yes to it.
 *
 * Deliberately not the PDF. The PDF is the document of record and one tap
 * away; this is the page that has to work on a phone with one hand, so it
 * shows what they are agreeing to and the signature box, and nothing else.
 *
 * Every field here is hand-picked by the server — a proposal row carries
 * internal selection data and a signature, and none of that belongs on a page
 * anyone with the link can open.
 */

export type PublicProposalView = {
  token: string;
  projectName: string;
  clientName: string;
  proposalDate: string;
  currency: string;
  status: string;
  declinedReason: string | null;
  signedName: string | null;
  pricing: Pricing;
  /** Section headings and their prose, in order. */
  sections: { title: string; body: string }[];
};

export function PublicProposal({
  view,
  company,
}: {
  view: PublicProposalView;
  company: {
    name: string;
    phones: string;
    email: string;
    website: string;
    addressLines: string[];
  };
}) {
  const [status, setStatus] = React.useState(view.status);
  const [showDecline, setShowDecline] = React.useState(false);

  const money = (n: number) => formatCurrency(n, view.currency);
  const { lineItems, oneTimeTotal, monthlyTotal, recurringNotes } = view.pricing;

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
          <div className="bg-gradient-to-br from-primary-500 to-primary-700 px-6 py-6 text-white sm:px-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-lg font-bold tracking-tight">{company.name}</p>
                <p className="mt-0.5 text-xs text-white/70">
                  {company.addressLines.join(" · ")}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wider text-white/70">Proposal</p>
                <p className="text-lg font-bold">{view.projectName}</p>
              </div>
            </div>
          </div>

          <div className="space-y-6 px-6 py-6 sm:px-10 sm:py-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Prepared for
                </p>
                <p className="mt-1 text-base font-semibold text-slate-900">
                  {view.clientName}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Date
                </p>
                <p className="mt-1 text-sm text-slate-700">{view.proposalDate}</p>
              </div>
            </div>

            {status === "accepted" && (
              <div className="flex items-start gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Signed{view.signedName ? ` by ${view.signedName}` : ""} — thank you.
                  We&apos;ll be in touch to get started.
                </span>
              </div>
            )}
            {status === "declined" && (
              <div className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-600">
                This proposal was declined
                {view.declinedReason ? ` — “${view.declinedReason}”` : ""}.
              </div>
            )}

            {/* What they're agreeing to */}
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                What&apos;s included
              </p>
              <ul className="mt-2 divide-y divide-slate-100">
                {lineItems.map((line, i) => (
                  <li key={i} className="flex items-start justify-between gap-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">{line.label}</p>
                      {line.features && line.features.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {line.features.map((f, j) => (
                            <li key={j} className="text-xs text-slate-500">
                              · {f}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <span className="shrink-0 text-right text-sm">
                      {line.original && line.original > line.amount && (
                        <span className="mr-1.5 text-xs text-slate-400 line-through">
                          {money(line.original)}
                        </span>
                      )}
                      <span className="font-semibold text-slate-900">
                        {money(line.amount)}
                      </span>
                      {line.recurrence && line.recurrence !== "one_time" && (
                        <span className="block text-[11px] text-slate-400">
                          per {line.recurrence === "monthly" ? "month" : "year"}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-center justify-between border-t-2 border-slate-900 pt-3">
                <span className="text-sm font-semibold text-slate-900">Total</span>
                <span className="text-lg font-bold text-slate-900">
                  {money(oneTimeTotal)}
                </span>
              </div>
              {monthlyTotal ? (
                <div className="mt-1 flex items-center justify-between text-sm text-slate-500">
                  <span>Then, monthly</span>
                  <span>{money(monthlyTotal)}</span>
                </div>
              ) : null}
              {recurringNotes.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {recurringNotes.map((n, i) => (
                    <li key={i} className="text-xs text-slate-400">
                      {n}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {view.sections.length > 0 && (
              <div className="space-y-4 border-t border-slate-100 pt-5">
                {view.sections.map((s, i) => (
                  <div key={i}>
                    <h3 className="text-sm font-semibold text-slate-900">{s.title}</h3>
                    <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600">
                      {s.body}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <a
              href={`/api/public/proposal/${view.token}/pdf`}
              className={cn(
                "inline-flex items-center gap-1.5 text-sm font-medium",
                "text-primary-600 hover:text-primary-700",
              )}
            >
              <FileDown className="h-4 w-4" />
              Download the full proposal
            </a>
          </div>
        </div>

        {status !== "accepted" && status !== "declined" && (
          showDecline ? (
            <DeclineCard
              noun="proposal"
              onBack={() => setShowDecline(false)}
              onDecline={async (reason) => {
                const res = await declineProposal({ token: view.token, reason });
                if (res.ok) setStatus("declined");
                return res;
              }}
            />
          ) : (
            <SignAndAccept
              defaultName={view.clientName}
              noun="proposal"
              acceptLabel="Accept proposal"
              onDeclineClick={() => setShowDecline(true)}
              onAccept={async ({ signedName, signatureData }) => {
                const res = await acceptProposal({
                  token: view.token,
                  signedName,
                  signatureData,
                });
                if (res.ok) setStatus("accepted");
                return res;
              }}
            />
          )
        )}

        <p className="flex items-center justify-center gap-1.5 pb-6 text-center text-xs text-slate-400">
          <Clock className="h-3 w-3" />
          {company.name} · {company.email} · {company.phones}
        </p>
      </div>
    </div>
  );
}
