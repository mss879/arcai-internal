"use client";

import * as React from "react";
import {
  AlertCircle,
  Check,
  Download,
  FileText,
  Loader2,
  Mail,
  MessageSquareText,
  ScrollText,
  Send,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  AssistantCard,
  CardResolution,
  CardSendState,
  InvoiceCardData,
  ProposalCardData,
  SmsCardData,
} from "@/lib/assistant-cards";
import { downloadProposalPdf } from "@/app/(app)/proposals/download-pdf";
import type { SendInvoiceResult } from "@/components/assistant/use-voice-chat";

function money(amount: number): string {
  const v = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  return (
    "Rs. " +
    v.toLocaleString("en-US", {
      minimumFractionDigits: v % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB");
}

/** The invoice body, shared by the plain and confirm-send variants. */
function InvoiceBody({ invoice }: { invoice: InvoiceCardData }) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">
            <FileText className="h-4.5 w-4.5" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-slate-900">
              Invoice {invoice.invoice_number}
            </p>
            <p className="text-[11px] text-slate-400">
              {fmtDate(invoice.invoice_date)}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Billed to
        </p>
        <p className="text-sm font-medium text-slate-800">
          {invoice.bill_to_name || "—"}
        </p>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
        {invoice.items.map((it, i) => (
          <div key={i} className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <p className="truncate text-slate-700">
                {it.item || it.description || "Item"}
              </p>
              {it.item && it.description && (
                <p className="truncate text-[12px] text-slate-400">
                  {it.description}
                </p>
              )}
              <p className="text-[11px] text-slate-400">
                {(it.qty || "1")} × {money(Number(it.rate) || 0)}
              </p>
            </div>
            <span className="shrink-0 font-medium text-slate-900">
              {money(it.total)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Total</span>
          <span className="font-semibold text-slate-900">
            {money(invoice.grand_total)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Due today</span>
          <span className="font-semibold text-primary-700">
            {money(invoice.due_today)}
          </span>
        </div>
      </div>
    </>
  );
}

type SendState = CardSendState;

function ConfirmSend({
  invoice,
  emails,
  message,
  resolution,
  onSend,
}: {
  invoice: InvoiceCardData;
  emails: string[];
  message?: string;
  /** Outcome set from outside the card (e.g. the user confirmed by voice). */
  resolution?: CardResolution;
  onSend: (
    invoiceId: string,
    emails: string[],
    message?: string,
  ) => Promise<SendInvoiceResult>;
}) {
  const [localState, setLocalState] = React.useState<SendState>("idle");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const state = resolution?.state ?? localState;
  const error = resolution?.error ?? localError;
  const setState = setLocalState;

  const send = async () => {
    setState("sending");
    setLocalError(null);
    const res = await onSend(invoice.id, emails, message);
    if (res.ok) {
      setState("sent");
    } else {
      setLocalError(res.error || "Could not send.");
      setState("error");
    }
  };

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Send to
          </p>
          {emails.map((e) => (
            <p key={e} className="break-all text-sm font-medium text-slate-800">
              {e}
            </p>
          ))}
        </div>
      </div>

      {message && (
        <div className="mt-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">
            Message
          </p>
          <p className="mt-0.5 whitespace-pre-line text-[13px] leading-relaxed text-amber-900">
            {message}
          </p>
        </div>
      )}

      {state === "sent" ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          Sent to {emails.join(", ")}
        </div>
      ) : state === "cancelled" ? (
        <p className="mt-2.5 text-sm text-slate-400">Cancelled — nothing was sent.</p>
      ) : (
        <>
          {state === "error" && error && (
            <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[13px] text-rose-600">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <p className="mt-2.5 text-[13px] text-slate-500">
            Check the invoice, the recipients and the message above, then confirm.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={send}
              disabled={state === "sending"}
              className={cn(
                "inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white transition",
                "hover:bg-primary-700 active:scale-[0.98] disabled:opacity-60",
              )}
            >
              {state === "sending" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  {state === "error" ? "Try again" : "Send invoice"}
                </>
              )}
            </button>
            <button
              onClick={() => setState("cancelled")}
              disabled={state === "sending"}
              className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A pending SMS the user must confirm — recipient, message, then Send. */
function ConfirmSendSms({
  sms,
  resolution,
  onSendSms,
}: {
  sms: SmsCardData;
  /** Outcome set from outside the card (e.g. the user confirmed by voice). */
  resolution?: CardResolution;
  onSendSms: (sms: SmsCardData) => Promise<SendInvoiceResult>;
}) {
  const [localState, setLocalState] = React.useState<SendState>("idle");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const state = resolution?.state ?? localState;
  const error = resolution?.error ?? localError;
  const setState = setLocalState;

  const send = async () => {
    setState("sending");
    setLocalError(null);
    const res = await onSendSms(sms);
    if (res.ok) {
      setState("sent");
    } else {
      setLocalError(res.error || "Could not send.");
      setState("error");
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">
          <MessageSquareText className="h-4.5 w-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-900">
            {sms.kind === "payment_reminder" ? "SMS payment reminder" : "Text message"}
          </p>
          <p className="text-[11px] text-slate-400">
            {sms.client_name ? `${sms.client_name} · ` : ""}
            {sms.to_display}
            {sms.invoice_number ? ` · Invoice ${sms.invoice_number}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Message
        </p>
        <p className="mt-0.5 whitespace-pre-line text-[13px] leading-relaxed text-slate-800">
          {sms.message}
        </p>
      </div>

      {state === "sent" ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          Sent to {sms.to_display}
        </div>
      ) : state === "cancelled" ? (
        <p className="mt-2.5 text-sm text-slate-400">Cancelled — nothing was sent.</p>
      ) : (
        <>
          {state === "error" && error && (
            <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[13px] text-rose-600">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <p className="mt-2.5 text-[13px] text-slate-500">
            Check the number and the message above, then confirm.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={send}
              disabled={state === "sending"}
              className={cn(
                "inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white transition",
                "hover:bg-primary-700 active:scale-[0.98] disabled:opacity-60",
              )}
            >
              {state === "sending" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  {state === "error" ? "Try again" : "Send SMS"}
                </>
              )}
            </button>
            <button
              onClick={() => setState("cancelled")}
              disabled={state === "sending"}
              className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * A saved proposal, with the branded PDF a tap away. Nothing here sends
 * anything — the proposal is already stored under Proposals; this is the
 * review copy.
 */
function ProposalBody({ proposal }: { proposal: ProposalCardData }) {
  const [downloading, setDownloading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      await downloadProposalPdf({
        client_name: proposal.client_name,
        project_name: proposal.project_name,
        proposal_date: proposal.proposal_date,
        selection: proposal.selection,
        content: proposal.content,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">
          <ScrollText className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold text-slate-900">
            {proposal.client_name || "Proposal"}
          </p>
          <p className="truncate text-[11px] text-slate-400">
            {proposal.project_name || "Proposal"} · {fmtDate(proposal.proposal_date)}
          </p>
        </div>
      </div>

      <div className="mt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Package
        </p>
        <p className="text-sm font-medium text-slate-800">
          {proposal.package_summary}
        </p>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
        {proposal.line_items.map((l, i) => (
          <div key={i} className="flex items-start justify-between gap-3 text-sm">
            <p className="min-w-0 text-slate-700">{l.label}</p>
            <span className="shrink-0 whitespace-nowrap font-medium">
              {/* Matches the PDF: an offer price shows what it came down from. */}
              {typeof l.original === "number" && (
                <span className="mr-1.5 text-slate-400 line-through">
                  {money(l.original)}
                </span>
              )}
              <span className={l.amount < 0 ? "text-emerald-600" : "text-slate-900"}>
                {money(l.amount)}
              </span>
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
        <span className="text-slate-500">One-time total</span>
        <span className="font-semibold text-slate-900">
          {money(proposal.grand_total)}
        </span>
      </div>

      {proposal.recurring_notes.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {proposal.recurring_notes.map((n, i) => (
            <li key={i} className="text-[11px] leading-snug text-slate-400">
              {n}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rose-600">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={download}
          disabled={downloading}
          className={cn(
            "inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white transition",
            "hover:bg-primary-700 active:scale-[0.98] disabled:opacity-60",
          )}
        >
          {downloading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Building…
            </>
          ) : (
            <>
              <Download className="h-4 w-4" />
              {error ? "Try again" : "Download PDF"}
            </>
          )}
        </button>
        <a
          href="/proposals"
          className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100"
        >
          Open
        </a>
      </div>
    </>
  );
}

/**
 * Renders a card the assistant attached to a reply. Always light-themed so the
 * invoice reads like a document on both the desktop panel and the dark mobile
 * voice screen.
 */
export function AssistantCardView({
  card,
  onSend,
  onSendSms,
}: {
  card: AssistantCard;
  onSend: (
    invoiceId: string,
    emails: string[],
    message?: string,
  ) => Promise<SendInvoiceResult>;
  onSendSms: (sms: SmsCardData) => Promise<SendInvoiceResult>;
}) {
  return (
    <div className="w-full max-w-[320px] rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm">
      {card.type === "confirm_send_sms" && (
        <ConfirmSendSms
          sms={card.sms}
          resolution={card.resolution}
          onSendSms={onSendSms}
        />
      )}
      {card.type === "proposal" && <ProposalBody proposal={card.proposal} />}
      {(card.type === "invoice" || card.type === "confirm_send") && (
        <>
          <InvoiceBody invoice={card.invoice} />
          {card.type === "confirm_send" && (
            <ConfirmSend
              invoice={card.invoice}
              emails={card.emails}
              message={card.message}
              resolution={card.resolution}
              onSend={onSend}
            />
          )}
        </>
      )}
    </div>
  );
}
