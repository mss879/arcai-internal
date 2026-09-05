"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Ban, BadgeCheck, ExternalLink, FileText, Landmark } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { SlipQueueRow } from "@/lib/slips";
import { cn, formatCurrency } from "@/lib/utils";

import { confirmSlipAction, rejectSlipAction } from "./actions";

/**
 * The verification queue (0120): every slip a client sent, what the reader
 * made of it, what the invoice still owes, and two buttons. Nothing here is
 * automatic — the parsed amount is a suggestion, the person's number is the
 * record.
 */

const MATCH_META: Record<SlipQueueRow["match"], { label: string; className: string }> = {
  exact: { label: "Matches the balance", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  partial: { label: "Part of the balance", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  mismatch: { label: "Does not match", className: "bg-rose-50 text-rose-600 ring-rose-200" },
  unknown: { label: "No invoice to match", className: "bg-slate-100 text-slate-600 ring-slate-200" },
};

const SOURCE_LABEL: Record<SlipQueueRow["source"], string> = {
  public_invoice: "Invoice page",
  portal: "Project portal",
  whatsapp: "WhatsApp",
  team: "Team",
  gateway: "Gateway",
};

export function SlipsTab({ slips }: { slips: SlipQueueRow[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState<SlipQueueRow | null>(null);
  const [rejecting, setRejecting] = React.useState<SlipQueueRow | null>(null);
  const [amount, setAmount] = React.useState("");
  const [paidOn, setPaidOn] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  function openConfirm(slip: SlipQueueRow) {
    setAmount(String(slip.amountClaimed ?? slip.invoice?.balance ?? ""));
    setPaidOn(slip.parsed.date ?? format(new Date(), "yyyy-MM-dd"));
    setConfirming(slip);
  }

  async function submitConfirm() {
    if (!confirming) return;
    setBusy(true);
    const res = await confirmSlipAction({
      slipId: confirming.id,
      amount: Number(amount) || null,
      paidAt: paidOn || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(res.told ? "Confirmed, and the client was told." : "Confirmed. The client couldn't be reached — a task was raised.");
      setConfirming(null);
      router.refresh();
    } else toast.error(res.error);
  }

  async function submitReject() {
    if (!rejecting) return;
    setBusy(true);
    const res = await rejectSlipAction({ slipId: rejecting.id, reason });
    setBusy(false);
    if (res.ok) {
      toast.success(res.told ? "Rejected, and the client was asked to check it." : "Rejected.");
      setRejecting(null);
      setReason("");
      router.refresh();
    } else toast.error(res.error);
  }

  if (slips.length === 0) {
    return (
      <EmptyState
        icon={<Landmark className="h-6 w-6" />}
        title="No slips waiting"
        description="When a client sends a bank-transfer slip from their invoice page, the portal or WhatsApp, it lands here for you to confirm."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="px-1 text-xs text-slate-500">
        The reader&apos;s figures are suggestions. Confirm with the amount the bank statement shows —
        that is what becomes the payment, and the invoice, the project and the client follow from it.
      </p>
      <ul className="space-y-3">
        {slips.map((slip) => {
          const match = MATCH_META[slip.match];
          return (
            <li
              key={slip.id}
              className="grid gap-4 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)] md:grid-cols-[160px_minmax(0,1fr)_auto]"
            >
              <a
                href={slip.previewUrl ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="flex h-36 items-center justify-center overflow-hidden rounded-xl bg-slate-100"
              >
                {slip.previewUrl && !slip.isPdf ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={slip.previewUrl} alt="Payment slip" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex flex-col items-center gap-1 text-xs text-slate-500">
                    <FileText className="h-6 w-6" /> {slip.isPdf ? "PDF" : "Open"}
                    <ExternalLink className="h-3 w-3" />
                  </span>
                )}
              </a>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={match.className}>{match.label}</Badge>
                  {slip.status === "duplicate" && (
                    <Badge className="bg-rose-50 text-rose-600 ring-rose-200">Seen before</Badge>
                  )}
                  <span className="text-xs text-slate-400">
                    {SOURCE_LABEL[slip.source]} · {format(parseISO(slip.createdAt), "d MMM, h:mm a")}
                  </span>
                </div>
                <p className="mt-2 text-lg font-bold tabular-nums text-slate-900">
                  {slip.amountClaimed !== null
                    ? formatCurrency(slip.amountClaimed, slip.parsed.currency ?? slip.invoice?.currency ?? "LKR")
                    : "Amount not read"}
                  {slip.invoice && (
                    <span className="ml-2 text-sm font-medium text-slate-500">
                      of {formatCurrency(slip.invoice.balance, slip.invoice.currency)} owed on {slip.invoice.number}
                    </span>
                  )}
                </p>
                <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-slate-500 sm:grid-cols-3">
                  {slip.reference && <Row label="Reference" value={slip.reference} mono />}
                  {slip.parsed.bank && <Row label="Bank" value={slip.parsed.bank} />}
                  {slip.parsed.date && <Row label="Dated" value={slip.parsed.date} />}
                  {slip.parsed.payer && <Row label="From" value={slip.parsed.payer} />}
                  {slip.client && <Row label="Client" value={slip.client.name} />}
                  {slip.project && <Row label="Project" value={slip.project.name} />}
                </dl>
                {slip.note && <p className="mt-1.5 text-xs italic text-slate-500">“{slip.note}”</p>}
                {slip.parsed.confidence === "low" && (
                  <p className="mt-1 text-[11px] text-amber-600">The reader wasn&apos;t sure — open the slip.</p>
                )}
              </div>

              <div className="flex flex-row gap-2 md:flex-col">
                <Button size="sm" onClick={() => openConfirm(slip)}>
                  <BadgeCheck className="h-4 w-4" /> Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-rose-600 hover:bg-rose-50"
                  onClick={() => setRejecting(slip)}
                >
                  <Ban className="h-4 w-4" /> Reject
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <Modal
        open={!!confirming}
        onClose={() => setConfirming(null)}
        title="Confirm the payment"
        description={
          confirming?.invoice
            ? `${confirming.invoice.number} · ${formatCurrency(confirming.invoice.balance, confirming.invoice.currency)} owed. Enter what the bank actually received.`
            : "No invoice is linked — the money lands on the project's ledger."
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitConfirm} loading={busy} disabled={!Number(amount)}>
              <BadgeCheck className="h-4 w-4" /> Confirm and record
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount received" required>
            <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Received on">
            <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Recorded through the same core as every payment. The client gets a thank-you on WhatsApp
          or by text.
        </p>
      </Modal>

      <Modal
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Reject this slip"
        description="Nothing is recorded. The client is asked to check it and send it again."
        footer={
          <>
            <Button variant="outline" onClick={() => setRejecting(null)} disabled={busy}>
              Keep it
            </Button>
            <Button onClick={submitReject} loading={busy} className="bg-rose-600 hover:bg-rose-700">
              <Ban className="h-4 w-4" /> Reject
            </Button>
          </>
        }
      >
        <Field label="Why (sent to the client)">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="The amount doesn't match, the slip is unreadable, the transfer hasn't arrived…"
          />
        </Field>
      </Modal>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={cn("truncate text-slate-700", mono && "font-mono")} title={value}>
        {value}
      </dd>
    </div>
  );
}
