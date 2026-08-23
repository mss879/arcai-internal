"use client";

/**
 * "The money's in the bank" — the one button (0093).
 *
 * Recording a deposit and confirming one are different acts. The figure gets
 * typed in when the client says they've paid; this is pressed after someone
 * has actually looked at the bank. Pressing it raises the stamped invoice and
 * texts the client its link, and it can only be pressed once.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Copy,
  ExternalLink,
  Landmark,
  Send,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";

import {
  confirmDeposit,
  resendDepositInvoice,
} from "@/app/(app)/projects/deposit-actions";

export function DepositConfirmCard({
  projectId,
  currency,
  received,
  totalValue,
  clientName,
  clientPhone,
  confirmedAt,
  invoiceNumber,
  invoiceLink,
  lastSentAt,
}: {
  projectId: string;
  currency: string;
  /** What the project has actually taken in so far. */
  received: number;
  totalValue: number;
  clientName: string | null;
  clientPhone: string | null;
  confirmedAt: string | null;
  invoiceNumber: string | null;
  invoiceLink: string | null;
  lastSentAt: string | null;
}) {
  const router = useRouter();
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [result, setResult] = React.useState<{
    invoiceNumber: string;
    link: string | null;
    smsError: string | null;
  } | null>(null);

  const canText = Boolean(clientPhone);

  async function run() {
    setBusy(true);
    const res = await confirmDeposit(projectId);
    setBusy(false);

    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setAsking(false);
    setResult(res);
    if (res.smsError) {
      // The invoice exists either way — say what happened, don't bury it.
      toast.warning(`Invoice ${res.invoiceNumber} raised, but the text didn't go`);
    } else {
      toast.success(`Invoice ${res.invoiceNumber} sent to ${clientName ?? "the client"}`);
    }
    router.refresh();
  }

  async function resend() {
    setBusy(true);
    const res = await resendDepositInvoice(projectId);
    setBusy(false);
    if (res.ok) {
      toast.success("Link sent again");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  function copy(link: string) {
    navigator.clipboard.writeText(link);
    setCopied(true);
    toast.success("Link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  // ---- Already confirmed -------------------------------------------------
  if (confirmedAt) {
    const link = result?.link ?? invoiceLink;
    return (
      <section className="rounded-2xl border border-emerald-200/70 bg-emerald-50/50 p-5 shadow-[var(--shadow-card)]">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-600">
            <BadgeCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-emerald-900">
              Deposit confirmed
            </h2>
            <p className="mt-0.5 text-xs text-emerald-800/80">
              {invoiceNumber ? `Invoice ${invoiceNumber} · ` : ""}
              stamped DEPOSIT PAID on{" "}
              {format(new Date(confirmedAt), "d MMM yyyy")}
              {lastSentAt
                ? ` · link sent ${format(new Date(lastSentAt), "d MMM")}`
                : ""}
            </p>

            {link && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-white/80 px-2.5 py-1.5 text-[11px] text-slate-600 ring-1 ring-emerald-200">
                  {link}
                </code>
                <button
                  type="button"
                  onClick={() => copy(link)}
                  title="Copy the client's link"
                  className="grid h-8 w-8 place-items-center rounded-lg text-emerald-700 transition hover:bg-white"
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  title="Open what the client sees"
                  className="grid h-8 w-8 place-items-center rounded-lg text-emerald-700 transition hover:bg-white"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}

            {result?.smsError && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {result.smsError} Copy the link above and send it yourself.
              </p>
            )}

            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={resend}
                loading={busy}
                disabled={!canText}
                title={
                  canText
                    ? undefined
                    : "No phone number on the client record"
                }
              >
                <Send className="h-3.5 w-3.5" /> Send again
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // ---- Not yet confirmed -------------------------------------------------
  const nothingIn = received <= 0;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-500">
          <Landmark className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">
            Confirm the deposit
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {nothingIn
              ? "Record the deposit on the project first — there's nothing to confirm yet."
              : "Check the money is actually in the bank, then confirm. That raises the stamped invoice and texts the client its link."}
          </p>

          {!nothingIn && (
            <p className="mt-3 text-2xl font-bold tabular-nums text-slate-900">
              {formatCurrency(received, currency)}
              {totalValue > 0 && (
                <span className="ml-2 text-xs font-medium text-slate-400">
                  of {formatCurrency(totalValue, currency)}
                </span>
              )}
            </p>
          )}

          <div className="mt-3">
            <Button onClick={() => setAsking(true)} disabled={nothingIn}>
              <BadgeCheck className="h-4 w-4" /> Confirm
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Confirm the deposit has landed"
        description="Only press this once you've seen the money in the bank — it issues a receipted invoice, and that can't be quietly taken back."
        footer={
          <>
            <Button variant="outline" onClick={() => setAsking(false)}>
              Not yet
            </Button>
            <Button onClick={run} loading={busy}>
              <BadgeCheck className="h-4 w-4" /> Yes, it&apos;s in
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Pressing this will:</p>
          <ol className="space-y-2 text-sm text-slate-700">
            <Step n={1}>
              Raise an invoice for{" "}
              <strong>{formatCurrency(totalValue, currency)}</strong>, stamped{" "}
              <strong>DEPOSIT PAID</strong>, showing{" "}
              {formatCurrency(received, currency)} received and{" "}
              {formatCurrency(Math.max(0, totalValue - received), currency)}{" "}
              still to come.
            </Step>
            <Step n={2}>
              {canText ? (
                <>
                  Text <strong>{clientName ?? "the client"}</strong> on{" "}
                  <strong>{clientPhone}</strong> a link to that invoice —
                  the invoice only, on its own page. No portal, nothing else.
                </>
              ) : (
                <span className="text-amber-700">
                  {clientName ?? "This client"} has no phone number, so no text
                  will go out. The invoice is still raised and you&apos;ll get
                  the link to send yourself.
                </span>
              )}
            </Step>
          </ol>
        </div>
      </Modal>
    </section>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary-100 text-[11px] font-bold text-primary-700">
        {n}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
