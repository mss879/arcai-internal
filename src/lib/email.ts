import "server-only";

import { Resend } from "resend";

import { INVOICE_COMPANY } from "@/lib/invoice";
import type { InvoiceEmailData } from "@/lib/invoice-pdf";

const FROM = process.env.RESEND_FROM_EMAIL || "ARC AI <onboarding@resend.dev>";

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

type SendResult = { sent: boolean; error?: string };

function shell(title: string, body: string) {
  return `
  <div style="background:#f6f7fb;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e9ecf5;">
      <div style="background:linear-gradient(135deg,#f97316,#c2410c);padding:28px 32px;">
        <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.01em;">ARC AI</div>
        <div style="color:#ffedd5;font-size:13px;margin-top:2px;">Workspace</div>
      </div>
      <div style="padding:32px;color:#0f172a;">
        <h1 style="margin:0 0 12px;font-size:20px;">${title}</h1>
        ${body}
      </div>
      <div style="padding:18px 32px;border-top:1px solid #eef0f6;color:#94a3b8;font-size:12px;">
        Sent by ARC AI Management. If you weren't expecting this, you can ignore it.
      </div>
    </div>
  </div>`;
}

function button(href: string, label: string) {
  return `<a href="${href}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px;font-size:14px;">${label}</a>`;
}

/** Invitation email with a join link. */
export async function sendInviteEmail(opts: {
  to: string;
  inviteUrl: string;
  inviterName?: string;
}): Promise<SendResult> {
  const resend = getResend();
  if (!resend) return { sent: false, error: "RESEND_API_KEY not configured" };

  const body = `
    <p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:1.6;">
      ${opts.inviterName ? `<strong>${opts.inviterName}</strong> has invited you` : "You have been invited"}
      to join the ARC AI workspace. Click below to set up your account — we'll
      generate your login the moment you join.
    </p>
    <p style="margin:24px 0;">${button(opts.inviteUrl, "Join the workspace")}</p>
    <p style="margin:0;color:#94a3b8;font-size:13px;">This invite expires in 7 days.</p>
  `;

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: opts.to,
      subject: "You're invited to ARC AI",
      html: shell("You're invited 👋", body),
    });
    if (error) return { sent: false, error: error.message };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

/** Credentials email sent after a user accepts an invite. */
export async function sendCredentialsEmail(opts: {
  to: string;
  fullName: string;
  username: string;
  password: string;
  loginUrl: string;
}): Promise<SendResult> {
  const resend = getResend();
  if (!resend) return { sent: false, error: "RESEND_API_KEY not configured" };

  const cred = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 0;color:#94a3b8;font-size:13px;width:90px;">${label}</td>
      <td style="padding:8px 0;color:#0f172a;font-size:14px;font-weight:600;font-family:monospace;">${value}</td>
    </tr>`;

  const body = `
    <p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:1.6;">
      Welcome aboard, <strong>${opts.fullName}</strong>! Your ARC AI account is ready.
      Here are your login details:
    </p>
    <div style="background:#f6f7fb;border:1px solid #eef0f6;border-radius:14px;padding:16px 20px;margin:18px 0;">
      <table style="width:100%;border-collapse:collapse;">
        ${cred("Email", opts.to)}
        ${cred("Username", opts.username)}
        ${cred("Password", opts.password)}
      </table>
    </div>
    <p style="margin:18px 0;">${button(opts.loginUrl, "Log in to ARC AI")}</p>
    <p style="margin:0;color:#94a3b8;font-size:13px;">
      For your security, change your password after your first login.
    </p>
  `;

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: opts.to,
      subject: "Your ARC AI login details",
      html: shell("Your account is ready 🎉", body),
    });
    if (error) return { sent: false, error: error.message };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

// ---- Invoice email -------------------------------------------------------

/** Escape user-supplied text before it goes into the HTML email. */
function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Email a saved invoice to one or more recipients as a PDF attachment that
 * matches the in-app invoice template. The body is short — the invoice is the
 * attached PDF — but can carry a custom message (e.g. a payment reminder).
 * Used by the assistant's confirmed send flow.
 */
export async function sendInvoiceEmail(opts: {
  to: string | string[];
  invoice: InvoiceEmailData;
  message?: string;
}): Promise<SendResult> {
  const resend = getResend();
  if (!resend) return { sent: false, error: "RESEND_API_KEY not configured" };

  // Render the PDF lazily so the heavy react-pdf dependency only loads when an
  // invoice is actually emailed — not on invite/credential emails.
  let pdf: Buffer;
  try {
    const { renderInvoicePdf } = await import("@/lib/invoice-pdf");
    pdf = await renderInvoicePdf(opts.invoice);
  } catch (e) {
    return {
      sent: false,
      error:
        e instanceof Error ? e.message : "Could not render the invoice PDF.",
    };
  }

  const name = opts.invoice.bill_to_name?.trim();
  const safeNumber =
    opts.invoice.invoice_number.replace(/[^a-zA-Z0-9-]/g, "") || "invoice";
  const customMessage = opts.message?.trim();

  // The custom message (if any) becomes the main paragraph; otherwise a plain
  // "here is your invoice" line. Newlines in the message become paragraphs.
  const lead = customMessage
    ? customMessage
        .split(/\n+/)
        .map(
          (line) =>
            `<p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.6;">${esc(line)}</p>`,
        )
        .join("")
    : `<p style="margin:0 0 14px;color:#475569;font-size:15px;line-height:1.6;">Hi${name ? ` ${esc(name)}` : ""}, here is your invoice.</p>`;

  const body = `
    ${lead}
    <p style="margin:0 0 14px;color:#475569;font-size:14px;line-height:1.6;">
      Your invoice is attached as a PDF.
    </p>
    <p style="margin:0;color:#94a3b8;font-size:13px;">
      Any questions? Just reply to this email or contact ${esc(INVOICE_COMPANY.email)}.
    </p>
  `;

  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: opts.to,
      subject: customMessage
        ? `Payment reminder — Invoice ${opts.invoice.invoice_number} from ${INVOICE_COMPANY.name}`
        : `Invoice ${opts.invoice.invoice_number} from ${INVOICE_COMPANY.name}`,
      html: shell(customMessage ? "Payment reminder" : "Your invoice", body),
      attachments: [{ filename: `Invoice-${safeNumber}.pdf`, content: pdf }],
    });
    if (error) return { sent: false, error: error.message };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
