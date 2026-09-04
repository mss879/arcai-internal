"use client";

import * as React from "react";
import { Check } from "lucide-react";

import {
  DeclineCard,
  SignAndAccept,
} from "@/components/public/sign-and-accept";

import { declineAgreement, signAgreement } from "./actions";

/**
 * What the client reads before they sign.
 *
 * `bodyHtml` arrives already escaped and rendered by the server's Markdown
 * parser — the only place in this app that sets HTML from stored text, and
 * the reason that parser has no HTML passthrough at all.
 */
export function PublicAgreement({
  token,
  kind,
  title,
  bodyHtml,
  status: initialStatus,
  clientName,
  signedName,
  signedAt,
  declinedReason,
  date,
  company,
}: {
  token: string;
  kind: string;
  title: string;
  bodyHtml: string;
  status: string;
  clientName: string;
  signedName: string | null;
  signedAt: string | null;
  declinedReason: string | null;
  date: string;
  company: { name: string; phones: string; email: string; addressLines: string[] };
}) {
  const [status, setStatus] = React.useState(initialStatus);
  const [showDecline, setShowDecline] = React.useState(false);

  const noun =
    kind === "nda" ? "NDA" : kind === "sow" ? "scope of work" : "agreement";

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 px-6 py-6 text-white sm:px-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-lg font-bold tracking-tight">{company.name}</p>
                <p className="mt-0.5 text-xs text-white/60">
                  {company.addressLines.join(" · ")}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-wider text-white/60">{kind}</p>
                <p className="text-lg font-bold">{title}</p>
              </div>
            </div>
          </div>

          <div className="space-y-5 px-6 py-6 sm:px-10 sm:py-8">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Between
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  {company.name} and {clientName || "the Client"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Dated
                </p>
                <p className="mt-1 text-sm text-slate-700">{date}</p>
              </div>
            </div>

            {status === "signed" && (
              <div className="flex items-start gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Signed{signedName ? ` by ${signedName}` : ""}
                  {signedAt ? ` on ${new Date(signedAt).toLocaleDateString()}` : ""}. A
                  copy has been filed for both parties.
                </span>
              </div>
            )}
            {status === "declined" && (
              <div className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-600">
                This {noun} was declined
                {declinedReason ? ` — “${declinedReason}”` : ""}.
              </div>
            )}

            <article
              className="prose-agreement text-sm leading-relaxed text-slate-700 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-base [&_h1]:font-bold [&_h1]:text-slate-900 [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:text-slate-900 [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-slate-200 [&_li]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          </div>
        </div>

        {status !== "signed" && status !== "declined" && (
          showDecline ? (
            <DeclineCard
              noun={noun}
              onBack={() => setShowDecline(false)}
              onDecline={async (reason) => {
                const res = await declineAgreement({ token, reason });
                if (res.ok) setStatus("declined");
                return res;
              }}
            />
          ) : (
            <SignAndAccept
              defaultName={clientName}
              noun={noun}
              acceptLabel={`Sign the ${noun}`}
              onDeclineClick={() => setShowDecline(true)}
              onAccept={async ({ signedName: name, signatureData }) => {
                const res = await signAgreement({
                  token,
                  signedName: name,
                  signatureData,
                });
                if (res.ok) setStatus("signed");
                return res;
              }}
            />
          )
        )}

        <p className="pb-6 text-center text-xs text-slate-400">
          {company.name} · {company.email} · {company.phones}
        </p>
      </div>
    </div>
  );
}
