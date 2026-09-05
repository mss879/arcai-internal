"use client";

import * as React from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  ListChecks,
  Loader2,
  Mail,
  MessageSquareText,
  Play,
  ScrollText,
  Send,
  MessageCircle,
  CalendarClock,
  Link2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  AssistantCard,
  CardResolution,
  CardSendState,
  EmailCardData,
  InvoiceCardData,
  PortalLinkCardData,
  ProposalCardData,
  SmsCardData,
  SocialPostCardData,
  WhatsAppCardData,
} from "@/lib/assistant-cards";
import { cardArtifactId } from "@/lib/assistant-artifacts";
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
/**
 * A mission Arcus has planned but not started (0103).
 *
 * The plan is shown in full BEFORE anything runs, for the same reason a
 * confirm card shows the recipients before an email goes: you should be able
 * to see exactly what was about to happen and say no. Approving posts to the
 * approve route with the user's own session — there is no tool that starts a
 * mission, so the model can propose this plan and never authorise it.
 */
function MissionPlanBody({
  mission,
  resolution,
  onApprove,
}: {
  mission: {
    id: string;
    title: string;
    goal: string;
    steps: { n: number; title: string }[];
  };
  resolution?: CardResolution;
  onApprove?: (missionId: string) => Promise<SendInvoiceResult>;
}) {
  const [localState, setLocalState] = React.useState<SendState>("idle");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const state = resolution?.state ?? localState;
  const error = resolution?.error ?? localError;

  const approve = async () => {
    if (!onApprove) return;
    setLocalState("sending");
    setLocalError(null);
    const res = await onApprove(mission.id);
    if (res.ok) {
      setLocalState("sent");
    } else {
      setLocalError(res.error || "Could not start it.");
      setLocalState("error");
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">
          <ListChecks className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold text-slate-900">
            {mission.title}
          </p>
          <p className="text-[11px] text-slate-400">
            {mission.steps.length} steps · nothing has started
          </p>
        </div>
      </div>

      <ol className="mt-3 space-y-1.5">
        {mission.steps.map((step) => (
          <li key={step.n} className="flex gap-2 text-[13px] text-slate-600">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500">
              {step.n}
            </span>
            <span className="min-w-0">{step.title}</span>
          </li>
        ))}
      </ol>

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rose-600">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {state === "sent" ? (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] font-medium text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          Off it goes — I&apos;ll report back.
        </p>
      ) : (
        onApprove && (
          <button
            onClick={approve}
            disabled={state === "sending"}
            // The hand's thumbs-up gesture presses the first visible one.
            data-hand-approve

            className={cn(
              "mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white transition",
              "hover:bg-primary-700 active:scale-[0.98] disabled:opacity-60",
            )}
          >
            {state === "sending" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                {state === "error" ? "Try again" : "Approve and run"}
              </>
            )}
          </button>
        )
      )}
      <p className="mt-2 text-[11px] text-slate-400">
        Anything meant for a client still waits for your Send afterwards.
      </p>
    </>
  );
}

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
 * The confirm/cancel machinery every "we wrote it, you send it" card shares.
 *
 * The rule this encodes is the whole point of the cards: the model can write
 * something, and only a person can send it. Nothing here reaches a provider —
 * it calls back into a route that requires a browser session.
 */
function ConfirmFooter({
  state,
  error,
  sentLabel,
  sendLabel,
  hint,
  onSend,
  onCancel,
}: {
  state: SendState;
  error: string | null;
  sentLabel: string;
  sendLabel: string;
  hint: string;
  onSend: () => void;
  onCancel: () => void;
}) {
  if (state === "sent") {
    return (
      <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700">
        <Check className="mt-0.5 h-4 w-4 shrink-0" />
        {sentLabel}
      </div>
    );
  }
  if (state === "cancelled") {
    return <p className="mt-2.5 text-sm text-slate-400">Cancelled — nothing was sent.</p>;
  }
  return (
    <>
      {state === "error" && error && (
        <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[13px] text-rose-600">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <p className="mt-2.5 text-[13px] text-slate-500">{hint}</p>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onSend}
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
              {state === "error" ? "Try again" : sendLabel}
            </>
          )}
        </button>
        <button
          onClick={onCancel}
          disabled={state === "sending"}
          className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </>
  );
}

/** A prepared email, shown in full before anyone can send it (0115). */
function ConfirmSendEmail({
  email,
  resolution,
  onSendEmail,
}: {
  email: EmailCardData;
  resolution?: CardResolution;
  onSendEmail?: (email: EmailCardData) => Promise<SendInvoiceResult>;
}) {
  const [localState, setLocalState] = React.useState<SendState>("idle");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const state = resolution?.state ?? localState;
  const error = resolution?.error ?? localError;

  const send = async () => {
    setLocalState("sending");
    setLocalError(null);
    if (!onSendEmail) return;
    const res = await onSendEmail(email);
    if (res.ok) setLocalState("sent");
    else {
      setLocalError(res.error || "Could not send.");
      setLocalState("error");
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">
          <Mail className="h-4.5 w-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-900">Email</p>
          <p className="text-[11px] text-slate-400">
            {email.client_name ? `${email.client_name} · ` : ""}
            {email.to.join(", ")}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Subject
        </p>
        <p className="mt-0.5 text-[13px] font-medium text-slate-800">{email.subject}</p>
        <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Message
        </p>
        <p className="mt-0.5 whitespace-pre-line text-[13px] leading-relaxed text-slate-800">
          {email.body}
        </p>
      </div>

      {onSendEmail ? (
        <ConfirmFooter
          state={state}
          error={error ?? null}
          sentLabel={`Sent to ${email.to.join(", ")}`}
          sendLabel="Send email"
          hint="Read it through, then confirm."
          onSend={send}
          onCancel={() => setLocalState("cancelled")}
        />
      ) : (
        <p className="mt-2.5 text-[13px] text-slate-400">
          Open Arcus to send this.
        </p>
      )}
    </>
  );
}

/** A prepared WhatsApp message (0115). Sending pauses the AI for that chat. */
function ConfirmSendWhatsApp({
  whatsapp,
  resolution,
  onSendWhatsApp,
}: {
  whatsapp: WhatsAppCardData;
  resolution?: CardResolution;
  onSendWhatsApp?: (whatsapp: WhatsAppCardData) => Promise<SendInvoiceResult>;
}) {
  const [localState, setLocalState] = React.useState<SendState>("idle");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const state = resolution?.state ?? localState;
  const error = resolution?.error ?? localError;

  const send = async () => {
    setLocalState("sending");
    setLocalError(null);
    if (!onSendWhatsApp) return;
    const res = await onSendWhatsApp(whatsapp);
    if (res.ok) setLocalState("sent");
    else {
      setLocalError(res.error || "Could not send.");
      setLocalState("error");
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
          <MessageCircle className="h-4.5 w-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-900">WhatsApp</p>
          <p className="text-[11px] text-slate-400">
            {whatsapp.client_name} · {whatsapp.to_display}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Message
        </p>
        <p className="mt-0.5 whitespace-pre-line text-[13px] leading-relaxed text-slate-800">
          {whatsapp.message}
        </p>
      </div>

      {!whatsapp.within_window && state !== "sent" && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          They haven&apos;t written in 24h — WhatsApp may reject free text.
        </p>
      )}

      {onSendWhatsApp ? (
        <ConfirmFooter
          state={state}
          error={error ?? null}
          sentLabel={`Sent to ${whatsapp.to_display}`}
          sendLabel="Send on WhatsApp"
          hint="Sending takes over the chat — the AI stops replying to them."
          onSend={send}
          onCancel={() => setLocalState("cancelled")}
        />
      ) : (
        <p className="mt-2.5 text-[13px] text-slate-400">
          Open Arcus to send this.
        </p>
      )}
    </>
  );
}

const CHANNEL_LABEL: Record<PortalLinkCardData["likely_channel"], string> = {
  whatsapp: "WhatsApp, with an “Open your project” button",
  whatsapp_template: "WhatsApp, as the approved portal template",
  sms: "SMS",
  none: "nothing can send it — a task will be raised instead",
};

/** The client's project link (0119). Sent only on a tap, via the ladder. */
function ConfirmPortalLink({
  portal,
  resolution,
  onSendPortalLink,
}: {
  portal: PortalLinkCardData;
  resolution?: CardResolution;
  onSendPortalLink?: (portal: PortalLinkCardData) => Promise<SendInvoiceResult>;
}) {
  const [localState, setLocalState] = React.useState<SendState>("idle");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const state = resolution?.state ?? localState;
  const error = resolution?.error ?? localError;

  const send = async () => {
    setLocalState("sending");
    setLocalError(null);
    if (!onSendPortalLink) return;
    const res = await onSendPortalLink(portal);
    if (res.ok) setLocalState("sent");
    else {
      setLocalError(res.error || "Could not send the link.");
      setLocalState("error");
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-sky-50 text-sky-600">
          <Link2 className="h-4.5 w-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-900">
            {portal.sent_before ? "Resend the project link" : "Send the project link"}
          </p>
          <p className="text-[11px] text-slate-400">
            {portal.client_name} · {portal.to_display}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {portal.project_name}
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-slate-800">
          Goes out on {CHANNEL_LABEL[portal.likely_channel]}.
        </p>
        {portal.note && (
          <p className="mt-1.5 whitespace-pre-line text-[13px] text-slate-600">
            “{portal.note}”
          </p>
        )}
      </div>

      {portal.channel_note && state !== "sent" && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {portal.channel_note}
        </p>
      )}

      {onSendPortalLink ? (
        <ConfirmFooter
          state={state}
          error={error ?? null}
          sentLabel={`Sent to ${portal.client_name}`}
          sendLabel="Send the link"
          hint="Same ladder as the project page: WhatsApp while their chat is open, the template after, SMS last."
          onSend={send}
          onCancel={() => setLocalState("cancelled")}
        />
      ) : (
        <p className="mt-2.5 text-[13px] text-slate-400">
          Open Arcus to send this.
        </p>
      )}
    </>
  );
}

/** A post lined up for the publish queue (0118). Queued only on a tap. */
function ConfirmSocialPost({
  social,
  resolution,
  onScheduleSocial,
}: {
  social: SocialPostCardData;
  resolution?: CardResolution;
  onScheduleSocial?: (social: SocialPostCardData) => Promise<SendInvoiceResult>;
}) {
  const [localState, setLocalState] = React.useState<SendState>("idle");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const state = resolution?.state ?? localState;
  const error = resolution?.error ?? localError;

  const send = async () => {
    setLocalState("sending");
    setLocalError(null);
    if (!onScheduleSocial) return;
    const res = await onScheduleSocial(social);
    if (res.ok) setLocalState("sent");
    else {
      setLocalError(res.error || "Could not schedule it.");
      setLocalState("error");
    }
  };

  const when = new Date(social.scheduled_for);
  const whenLabel = Number.isNaN(when.getTime())
    ? social.scheduled_for
    : when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <>
      <div className="flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-violet-50 text-violet-600">
          <CalendarClock className="h-4.5 w-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-900">Schedule a post</p>
          <p className="text-[11px] text-slate-400">
            {social.accounts
              .map((a) => `${a.platform === "instagram" ? "IG" : "FB"} · ${a.name}`)
              .join(", ")}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {social.topic} · {social.media_count} image{social.media_count === 1 ? "" : "s"}
        </p>
        <p className="mt-0.5 line-clamp-6 whitespace-pre-line text-[13px] leading-relaxed text-slate-800">
          {social.caption}
        </p>
        <p className="mt-2 text-[11px] text-slate-500">Goes out {whenLabel}</p>
      </div>

      {social.client_name && (
        <p
          className={
            social.client_approved
              ? "mt-2 text-[11px] text-emerald-600"
              : "mt-2 flex items-start gap-1.5 text-[11px] text-amber-600"
          }
        >
          {social.client_approved ? (
            `Approved by ${social.client_name}.`
          ) : (
            <>
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {social.client_name} hasn&apos;t approved this yet — it will be refused.
            </>
          )}
        </p>
      )}

      {onScheduleSocial ? (
        <ConfirmFooter
          state={state}
          error={error ?? null}
          sentLabel="On the queue"
          sendLabel="Schedule it"
          hint="Queued now, posted at that time. The publisher re-checks the client's approval first."
          onSend={send}
          onCancel={() => setLocalState("cancelled")}
        />
      ) : (
        <p className="mt-2.5 text-[13px] text-slate-400">
          Open Arcus to schedule this.
        </p>
      )}
    </>
  );
}

/**
 * A saved proposal, with the branded PDF a tap away. Nothing here sends
 * anything — the proposal is already stored under Proposals; this is the
 * review copy.
 */
function ProposalBody({
  proposal,
  onOpen,
}: {
  proposal: ProposalCardData;
  /** Show this proposal in the preview canvas instead of navigating away. */
  onOpen?: () => void;
}) {
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
        {/* "Open" means open it HERE. Leaving the assistant for the
            Proposals list to look at the thing Arc just wrote is the long way
            round — the preview canvas already renders the real PDF. The link
            is kept only for surfaces with nowhere to put a preview. */}
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            <Eye className="h-4 w-4" />
            Open
          </button>
        ) : (
          <a
            href="/proposals"
            className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100"
          >
            Open
          </a>
        )}
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
  onOpenPreview,
  onApproveMission,
  onSendEmail,
  onSendWhatsApp,
  onScheduleSocial,
  onSendPortalLink,
}: {
  card: AssistantCard;
  onSend: (
    invoiceId: string,
    emails: string[],
    message?: string,
  ) => Promise<SendInvoiceResult>;
  onSendSms: (sms: SmsCardData) => Promise<SendInvoiceResult>;
  /**
   * 0115 — send a prepared email / WhatsApp message. Optional for the same
   * reason as onApproveMission: a surface that cannot send shows the draft
   * without a Send button, rather than a button that would do nothing.
   */
  onSendEmail?: (email: EmailCardData) => Promise<SendInvoiceResult>;
  onSendWhatsApp?: (whatsapp: WhatsAppCardData) => Promise<SendInvoiceResult>;
  /** 0118 — put a prepared post on the publish queue. */
  onScheduleSocial?: (social: SocialPostCardData) => Promise<SendInvoiceResult>;
  /** 0119 — send a client their project link. */
  onSendPortalLink?: (portal: PortalLinkCardData) => Promise<SendInvoiceResult>;
  /**
   * Approve a planned mission. Omitted on surfaces that cannot start one —
   * the card then shows the plan without an Approve button rather than a
   * button that would do nothing.
   */
  onApproveMission?: (missionId: string) => Promise<SendInvoiceResult>;
  /**
   * Show this card's document in the preview canvas. Given the artifact id
   * from `cardArtifactId()`. Omitted on a surface with no canvas, and the
   * card then falls back to a link into the app.
   */
  onOpenPreview?: (artifactId: string) => void;
}) {
  const previewId = cardArtifactId(card);
  const openPreview =
    onOpenPreview && previewId ? () => onOpenPreview(previewId) : undefined;

  return (
    <div className="w-full max-w-[320px] rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm">
      {card.type === "confirm_send_sms" && (
        <ConfirmSendSms
          sms={card.sms}
          resolution={card.resolution}
          onSendSms={onSendSms}
        />
      )}
      {card.type === "confirm_send_email" && (
        <ConfirmSendEmail
          email={card.email}
          resolution={card.resolution}
          onSendEmail={onSendEmail}
        />
      )}
      {card.type === "confirm_send_whatsapp" && (
        <ConfirmSendWhatsApp
          whatsapp={card.whatsapp}
          resolution={card.resolution}
          onSendWhatsApp={onSendWhatsApp}
        />
      )}
      {card.type === "confirm_social_post" && (
        <ConfirmSocialPost
          social={card.social}
          resolution={card.resolution}
          onScheduleSocial={onScheduleSocial}
        />
      )}
      {card.type === "confirm_portal_link" && (
        <ConfirmPortalLink
          portal={card.portal}
          resolution={card.resolution}
          onSendPortalLink={onSendPortalLink}
        />
      )}
      {card.type === "proposal" && (
        <ProposalBody proposal={card.proposal} onOpen={openPreview} />
      )}
      {card.type === "mission_plan" && (
        <MissionPlanBody
          mission={card.mission}
          resolution={card.resolution}
          onApprove={onApproveMission}
        />
      )}
      {(card.type === "invoice" || card.type === "confirm_send") && (
        <>
          <InvoiceBody invoice={card.invoice} />
          {card.type === "invoice" && openPreview && (
            <button
              type="button"
              onClick={openPreview}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            >
              <Eye className="h-4 w-4" />
              Open the PDF here
            </button>
          )}
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
