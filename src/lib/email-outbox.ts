import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Database,
  EmailActor,
  EmailAttachmentMeta,
  EmailKind,
} from "@/lib/database.types";
import {
  sendGenericEmail,
  sendInvoiceEmail,
  sendNoticeEmail,
  sendPricingEmail,
  type MailAttachment,
} from "@/lib/email";
import type { InvoiceEmailData } from "@/lib/invoice-pdf";
import type { NoticePdfData } from "@/lib/notice-pdf";

type DB = SupabaseClient<Database>;

/**
 * The one way the CRM sends an email to a client, a lead or about a project.
 *
 * Before this, six senders in src/lib/email.ts wrote to Resend and nothing
 * else: there was no record that an invoice had been emailed, no way to answer
 * "what have we sent this client", and a bounce webhook could only guess which
 * send it belonged to by matching the address. Five of the six senders threw
 * away Resend's message id entirely.
 *
 * Now every send goes through here and leaves an `email_messages` row (0115).
 * `src/lib/email.ts` is transport — it renders and hands to Resend, and knows
 * nothing about the CRM's records. This module knows the records and nothing
 * about HTML.
 *
 * Two rules that matter:
 *
 *   • Logging must never stop a send. The row is written best-effort, in its
 *     own try/catch, so an email still goes out if 0115 has not been applied
 *     yet or the insert fails. A missing log line is a smaller problem than a
 *     client not receiving their invoice.
 *   • One row per send CALL. A notice emailed to three people is one row with
 *     three addresses, because that is one message and they can see each
 *     other. Cold outreach deliberately makes one call per recipient so each
 *     gets its own unsubscribe token, and so gets one row each.
 *
 * The team-invite email is the one deliberate exception: it goes to a
 * colleague, not a customer, and belongs to no client record.
 */

/** Which CRM records this email is about. All optional — a pricing email
 *  knows nothing, a quote share knows four. */
export type EmailLinks = {
  clientId?: string | null;
  leadId?: string | null;
  projectId?: string | null;
  invoiceId?: string | null;
  quoteId?: string | null;
  proposalId?: string | null;
  meetingId?: string | null;
  /** Groups a back-and-forth in the inbox. Defaults from the links above. */
  threadKey?: string | null;
};

/** What to send. The transport is chosen from this, not passed in. */
export type EmailBody =
  | {
      transport: "generic";
      subject: string;
      body: string;
      cta?: { href: string; label: string };
      /** Trusted, server-built HTML (a CAN-SPAM footer). Never user input. */
      footer?: string;
      attachments?: MailAttachment[];
    }
  | { transport: "invoice"; invoice: InvoiceEmailData; note?: string }
  | { transport: "notice"; notice: NoticePdfData; note?: string }
  | {
      transport: "pricing";
      overrides?: Record<string, number>;
      note?: string;
    };

export type SendAndLogInput = EmailLinks & {
  to: string | string[];
  cc?: string[];
  /** Sender override. Cold outreach pins its own mailbox; the rest don't. */
  from?: string;
  replyTo?: string;
  /** What this email IS, for the log and the inbox. */
  kind: EmailKind;
  /** Who decided to send it. Defaults to a person. */
  actor?: EmailActor;
  /** The signed-in user behind a team or assistant send. */
  sentBy?: string | null;
  templateId?: string | null;
  message: EmailBody;
};

export type SendAndLogResult = {
  sent: boolean;
  error?: string;
  /** Resend's message id, when the send reported one. */
  providerId?: string;
  /** The `email_messages` row, when one could be written. */
  logId?: string;
};

/** Recipients as a clean array. Blank addresses are dropped, not sent to. */
function addresses(to: string | string[] | undefined): string[] {
  return (Array.isArray(to) ? to : [to])
    .map((a) => (a ?? "").trim())
    .filter(Boolean);
}

/**
 * A stable key for the thread this email belongs to, so a reply can be filed
 * beside it in the inbox. The client is the strongest identity available —
 * two projects for one client are one conversation.
 */
export function emailThreadKey(links: EmailLinks): string | null {
  if (links.threadKey) return links.threadKey;
  if (links.clientId) return `client:${links.clientId}`;
  if (links.leadId) return `lead:${links.leadId}`;
  if (links.projectId) return `project:${links.projectId}`;
  return null;
}

/** What went out, as far as the log is concerned. */
function describe(message: EmailBody): {
  subject: string;
  bodyText: string | null;
  attachments: EmailAttachmentMeta[];
} {
  switch (message.transport) {
    case "generic":
      return {
        subject: message.subject,
        bodyText: message.body,
        attachments: (message.attachments ?? []).map((a) => ({
          filename: a.filename,
          size: a.content.length,
        })),
      };
    case "invoice":
      return {
        // The real subject comes back from the sender; this is the fallback
        // for a send that failed before Resend was reached.
        subject: `Invoice ${message.invoice.invoice_number}`,
        bodyText: message.note ?? null,
        attachments: [{ filename: "invoice.pdf", of: "invoice" }],
      };
    case "notice":
      return {
        subject: `Notice ${message.notice.notice_number}`,
        bodyText: message.note ?? null,
        attachments: [{ filename: "notice.pdf", of: "notice" }],
      };
    case "pricing":
      return {
        subject: "ARC AI — Services & Pricing",
        bodyText: message.note ?? null,
        attachments: [{ filename: "pricing.pdf", of: "pricing" }],
      };
  }
}

/** Hand the message to the right sender in src/lib/email.ts. */
async function transport(input: SendAndLogInput, to: string[]) {
  const { message } = input;
  switch (message.transport) {
    case "generic":
      return sendGenericEmail({
        to,
        subject: message.subject,
        body: message.body,
        cta: message.cta,
        from: input.from,
        replyTo: input.replyTo,
        footer: message.footer,
        attachments: message.attachments,
      });
    case "invoice":
      return sendInvoiceEmail({
        to,
        invoice: message.invoice,
        message: message.note,
      });
    case "notice":
      return sendNoticeEmail({
        to,
        notice: message.notice,
        message: message.note,
      });
    case "pricing":
      return sendPricingEmail({
        to,
        overrides: message.overrides,
        message: message.note,
      });
  }
}

export async function sendAndLogEmail(
  db: DB,
  input: SendAndLogInput,
): Promise<SendAndLogResult> {
  const to = addresses(input.to);
  if (to.length === 0) {
    return { sent: false, error: "No email address to send to." };
  }
  const cc = addresses(input.cc);
  const planned = describe(input.message);

  // 1. Queue it, so a send that dies mid-flight still left a trace.
  let logId: string | undefined;
  try {
    const { data } = await db
      .from("email_messages")
      .insert({
        status: "queued",
        from_email: input.from ?? defaultFrom(),
        to_emails: to,
        cc_emails: cc,
        reply_to: input.replyTo ?? null,
        subject: planned.subject,
        body_text: planned.bodyText,
        attachments: planned.attachments,
        kind: input.kind,
        client_id: input.clientId ?? null,
        lead_id: input.leadId ?? null,
        project_id: input.projectId ?? null,
        invoice_id: input.invoiceId ?? null,
        quote_id: input.quoteId ?? null,
        proposal_id: input.proposalId ?? null,
        meeting_id: input.meetingId ?? null,
        thread_key: emailThreadKey(input),
        template_id: input.templateId ?? null,
        sent_by: input.sentBy ?? null,
        actor: input.actor ?? "team",
      })
      .select("id")
      .maybeSingle();
    logId = data?.id;
  } catch {
    // 0115 not applied yet, or the insert failed. Send anyway.
  }

  // 2. Send.
  const result = await transport(input, to);

  // 3. Record what happened.
  try {
    if (logId) {
      await db
        .from("email_messages")
        .update({
          status: result.sent ? "sent" : "failed",
          provider_id: result.id ?? null,
          // The PDF senders compose their own subject; take theirs over ours.
          subject: result.subject ?? planned.subject,
          error: result.sent ? null : (result.error ?? "send failed"),
          sent_at: result.sent ? new Date().toISOString() : null,
        })
        .eq("id", logId);
    }
  } catch {
    // The mail already went. A missing status is not worth failing over.
  }

  return {
    sent: result.sent,
    error: result.error,
    providerId: result.id,
    logId,
  };
}

/** Mirrors email.ts's own default, for the log line written before sending. */
function defaultFrom(): string {
  return process.env.RESEND_FROM_EMAIL || "ARC AI <onboarding@resend.dev>";
}
