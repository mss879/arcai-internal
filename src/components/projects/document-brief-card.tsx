"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, FileSearch, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DocumentBrief } from "@/lib/document-brief";
import { cn, formatCurrency } from "@/lib/utils";

import { readDocuments } from "@/app/(app)/projects/ai-actions";

/**
 * What the project's own documents say (0124) — the summary of the proposal
 * and the pricing off the invoice, on the project page, without anyone
 * typing them in.
 *
 * Sits under the chain card: the chain says where the job came from, this
 * says what was agreed and for how much. Every figure names its source so a
 * person can check it against the PDF, and the warnings are the model's and
 * the parser's doubts, shown rather than swallowed.
 */
export function DocumentBriefCard({
  projectId,
  brief,
  readAt,
  currency,
  documents,
}: {
  projectId: string;
  brief: DocumentBrief | null;
  readAt: string | null;
  currency: string;
  /** What is attached, so the empty state can say what to attach. */
  documents: { proposal: string | null; invoice: string | null; crmProposal: boolean };
}) {
  const router = useRouter();
  const [reading, setReading] = React.useState(false);
  const [showTerms, setShowTerms] = React.useState(false);

  const hasDocs = Boolean(documents.proposal || documents.invoice || documents.crmProposal);

  async function read() {
    setReading(true);
    const res = await readDocuments(projectId);
    setReading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const filled = [
      res.wrote.totalValue ? `value ${formatCurrency(res.wrote.totalValue, currency)}` : null,
      res.wrote.depositPercent != null ? `${res.wrote.depositPercent}% deposit` : null,
    ].filter(Boolean);
    toast.success(filled.length ? `Read — ${filled.join(", ")} filled in.` : "Read — nothing new to fill in.");
    router.refresh();
  }

  const pricing = brief?.pricing ?? null;
  const proposal = brief?.proposal ?? null;
  const sourceLabel =
    pricing?.from === "invoice" || pricing?.from === "invoice_pdf"
      ? `Invoice${pricing.invoiceNumber ? ` ${pricing.invoiceNumber}` : ""}${
          pricing.invoiceDate ? ` · ${format(new Date(`${pricing.invoiceDate}T12:00:00`), "d MMM yyyy")}` : ""
        }`
      : pricing?.from
        ? "the proposal's terms"
        : null;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
          <FileSearch className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">From the proposal &amp; invoice</h2>
          <p className="text-xs text-slate-400">
            {readAt
              ? `Read ${format(new Date(readAt), "d MMM yyyy, HH:mm")} — the value and deposit share come from here, not the form.`
              : "Read off the attached documents — nothing here is typed in by hand."}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={read} loading={reading} disabled={!hasDocs}>
          <RefreshCw className="h-4 w-4" /> {brief ? "Read again" : "Read documents"}
        </Button>
      </div>

      {!brief ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          {hasDocs
            ? "Press Read documents to pull the pricing and scope out of what's attached."
            : "Attach the proposal and the invoice under Edit project, and they'll be read from here."}
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {/* ---- Pricing, off the invoice ---- */}
          <div className="px-5 py-4">
            <div className="grid grid-cols-3 gap-4">
              <Figure label="Project value" value={pricing?.total ? formatCurrency(pricing.total, pricing.currency ?? currency) : "—"} />
              <Figure
                label={pricing?.depositPercent != null ? `Deposit · ${pricing.depositPercent}%` : "Deposit"}
                value={pricing?.depositAmount ? formatCurrency(pricing.depositAmount, pricing.currency ?? currency) : "—"}
                tone="amber"
              />
              <Figure
                label="Balance on completion"
                value={pricing?.balanceAmount != null ? formatCurrency(pricing.balanceAmount, pricing.currency ?? currency) : "—"}
              />
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              {sourceLabel ? `From ${sourceLabel}.` : "No pricing was found in the documents."}
              {pricing?.termsLine ? ` “${pricing.termsLine}”` : ""}
            </p>
          </div>

          {/* ---- Doubts, before the scope ---- */}
          {brief.warnings.length > 0 && (
            <ul className="space-y-1.5 bg-amber-50/60 px-5 py-3">
              {brief.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}

          {/* ---- Scope, off the proposal ---- */}
          {proposal && (
            <div className="space-y-4 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">{proposal.title ?? "Proposal"}</p>
                {proposal.packageLabel && (
                  <Badge className="bg-indigo-50 text-indigo-700 ring-indigo-200">{proposal.packageLabel}</Badge>
                )}
                {proposal.confidence === "low" && (
                  <Badge className="bg-amber-50 text-amber-700 ring-amber-200">check this</Badge>
                )}
              </div>
              {proposal.summary && (
                <p className="text-sm leading-relaxed text-slate-600">{proposal.summary}</p>
              )}

              {proposal.deliverables.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">What&apos;s included</p>
                  <ul className="mt-1.5 grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {proposal.deliverables.slice(0, 10).map((d, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                  {proposal.deliverables.length > 10 && (
                    <p className="mt-1 text-[11px] text-slate-400">+{proposal.deliverables.length - 10} more in the proposal</p>
                  )}
                </div>
              )}

              {proposal.timeline.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Timeline</p>
                  <ol className="mt-1.5 flex flex-wrap gap-1.5">
                    {proposal.timeline.map((s, i) => (
                      <li key={i} className="rounded-lg bg-slate-50 px-2 py-1 text-[11px] text-slate-600 ring-1 ring-slate-200">
                        <span className="font-semibold text-slate-800">{i + 1}.</span> {s.title}
                        {s.duration && <span className="text-slate-400"> · {s.duration}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {proposal.exclusions.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Assumptions &amp; exclusions</p>
                  <ul className="mt-1.5 space-y-1">
                    {proposal.exclusions.slice(0, 6).map((x, i) => (
                      <li key={i} className="text-xs text-slate-500">— {x}</li>
                    ))}
                  </ul>
                </div>
              )}

              {proposal.paymentTerms.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowTerms((v) => !v)}
                    className="text-xs font-medium text-primary-600 hover:underline"
                  >
                    {showTerms ? "Hide" : "Show"} payment terms as written
                  </button>
                  <ul className={cn("mt-1.5 space-y-1", !showTerms && "hidden")}>
                    {proposal.paymentTerms.map((t, i) => (
                      <li key={i} className="text-xs text-slate-500">• {t}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p className="px-5 py-3 text-[11px] text-slate-400">
            Figures are written to the project when read; adjust them under{" "}
            <Link href={`/projects/${projectId}?tab=money`} className="text-primary-600 hover:underline">
              Money → settings
            </Link>{" "}
            if the documents are wrong.
          </p>
        </div>
      )}
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "amber" }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "amber" ? "text-amber-600" : "text-slate-900")}>
        {value}
      </p>
    </div>
  );
}
