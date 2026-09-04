"use server";

import { revalidatePath } from "next/cache";

import { getProfile, requireAdmin } from "@/lib/auth";
import { sendAndLogEmail } from "@/lib/email-outbox";
import type { MailAttachment } from "@/lib/email";
import { invoiceEmailData } from "@/lib/invoice";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/**
 * Writing to a client from inside the CRM.
 *
 * Until now the only email a person could send from this app was an invoice,
 * through the assistant. Everything else meant opening a mail client, where
 * it left no trace on the client's record. This is the plain "write to them"
 * path: it goes through sendAndLogEmail like every other send, so it lands in
 * the log, the timeline and the inbox.
 *
 * Documents are attached here rather than by the caller: the invoice PDF is
 * rendered from the saved row so what the client receives is the same
 * document the assistant would have sent, not a second rendering that could
 * drift from it.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function addressList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export type ComposeEmailInput = {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Which records this is about — they become the log row's links. */
  clientId?: string | null;
  leadId?: string | null;
  projectId?: string | null;
  quoteId?: string | null;
  proposalId?: string | null;
  /** Attach this invoice's PDF, exactly as the assistant would send it. */
  attachInvoiceId?: string | null;
  /** Attach this proposal's PDF. */
  attachProposalId?: string | null;
  /** A button under the body — a quote or portal link. */
  cta?: { href: string; label: string } | null;
  templateId?: string | null;
};

export async function sendComposedEmail(
  input: ComposeEmailInput,
): Promise<ActionResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Not signed in." };

  const to = addressList(input.to);
  if (to.length === 0) return { ok: false, error: "Who is this going to?" };
  const bad = to.find((a) => !EMAIL_RE.test(a));
  if (bad) return { ok: false, error: `"${bad}" isn't an email address.` };

  const cc = addressList(input.cc);
  const badCc = cc.find((a) => !EMAIL_RE.test(a));
  if (badCc) return { ok: false, error: `"${badCc}" isn't an email address.` };

  const subject = input.subject.trim();
  if (!subject) return { ok: false, error: "Give it a subject." };
  if (!input.body.trim()) return { ok: false, error: "Write something first." };

  const supabase = await createClient();

  // Attachments are rendered server-side from the saved record.
  const attachments: MailAttachment[] = [];
  let invoiceId: string | null = null;

  if (input.attachInvoiceId) {
    const { data: invoice } = await supabase
      .from("invoices")
      .select(
        "id, invoice_number, invoice_date, bill_to_name, bill_to_details, items, grand_total, due_today, amount_paid, stamp, bank_account",
      )
      .eq("id", input.attachInvoiceId)
      .maybeSingle();
    if (!invoice) return { ok: false, error: "That invoice no longer exists." };
    try {
      const { renderInvoicePdf } = await import("@/lib/invoice-pdf");
      const pdf = await renderInvoicePdf(invoiceEmailData(invoice));
      const safe = invoice.invoice_number.replace(/[^a-zA-Z0-9-]/g, "") || "invoice";
      attachments.push({ filename: `Invoice-${safe}.pdf`, content: pdf });
      invoiceId = invoice.id;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Could not render the invoice PDF.",
      };
    }
  }

  if (input.attachProposalId) {
    const { data: proposal } = await supabase
      .from("proposals")
      .select("id, client_name, project_name, proposal_date, selection, content")
      .eq("id", input.attachProposalId)
      .maybeSingle();
    if (!proposal) return { ok: false, error: "That proposal no longer exists." };
    try {
      const { renderProposalPdf } = await import("@/lib/proposal-pdf");
      const { defaultContent, defaultSelection } = await import("@/lib/proposal");
      // Same defaults-merge as /api/proposals/pdf, so an older proposal saved
      // before a section existed still renders instead of throwing.
      const pdf = await renderProposalPdf({
        client_name: proposal.client_name,
        project_name: proposal.project_name,
        proposal_date: proposal.proposal_date,
        selection: { ...defaultSelection(), ...proposal.selection },
        content: { ...defaultContent(), ...proposal.content },
      });
      const safe =
        (proposal.client_name || "proposal").replace(/[^a-zA-Z0-9._-]/g, "") ||
        "proposal";
      attachments.push({ filename: `Proposal-${safe}.pdf`, content: pdf });
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Could not render the proposal PDF.",
      };
    }
  }

  const res = await sendAndLogEmail(supabase, {
    to,
    cc,
    kind: "compose",
    actor: "team",
    sentBy: profile.id,
    clientId: input.clientId ?? null,
    leadId: input.leadId ?? null,
    projectId: input.projectId ?? null,
    invoiceId,
    quoteId: input.quoteId ?? null,
    proposalId: input.proposalId ?? null,
    templateId: input.templateId ?? null,
    message: {
      transport: "generic",
      subject,
      body: input.body,
      cta: input.cta ?? undefined,
      attachments: attachments.length ? attachments : undefined,
    },
  });

  if (!res.sent) {
    return { ok: false, error: res.error || "The email didn't send." };
  }

  revalidatePath("/inbox");
  if (input.clientId) revalidatePath(`/clients/${input.clientId}`);
  if (input.projectId) revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

// ---- Templates -----------------------------------------------------------

export type EmailTemplateInput = {
  id?: string | null;
  name: string;
  subject: string;
  body: string;
  ctaLabel?: string | null;
  ctaKind?: string | null;
};

export async function saveEmailTemplate(
  input: EmailTemplateInput,
): Promise<ActionResult> {
  const admin = await requireAdmin();
  const supabase = await createClient();

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the template a name." };

  const row = {
    name,
    subject: input.subject.trim(),
    body: input.body,
    cta_label: input.ctaLabel?.trim() || null,
    cta_kind: input.ctaKind?.trim() || null,
    created_by: admin.id,
  };

  const { error } = input.id
    ? await supabase.from("email_templates").update(row).eq("id", input.id)
    : await supabase.from("email_templates").insert(row);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/inbox");
  return { ok: true };
}

export async function deleteEmailTemplate(id: string): Promise<ActionResult> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.from("email_templates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/inbox");
  return { ok: true };
}

/** The saved templates, for the compose box's picker. */
export async function listEmailTemplates(): Promise<
  { id: string; name: string; subject: string; body: string; cta_label: string | null }[]
> {
  const profile = await getProfile();
  if (!profile) return [];
  const supabase = await createClient();
  try {
    const { data } = await supabase
      .from("email_templates")
      .select("id, name, subject, body, cta_label")
      .order("name");
    return data ?? [];
  } catch {
    // 0115 not applied yet — compose still works, just without templates.
    return [];
  }
}
