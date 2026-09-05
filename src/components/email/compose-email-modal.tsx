"use client";

import * as React from "react";
import { Paperclip, Link2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import {
  renderEmailTemplate,
  type EmailTemplateValues,
} from "@/lib/email-templates";

import {
  listEmailTemplates,
  sendComposedEmail,
  type ComposeEmailInput,
} from "@/app/(app)/inbox/email-actions";

/**
 * Write to a client from wherever you already are.
 *
 * The point is that the email leaves a trace: it goes through
 * sendAndLogEmail, so it lands on the client's timeline, in the inbox and in
 * the email log with whatever record it was sent about. Composing in a mail
 * client is what this replaces, and that left nothing behind.
 *
 * A template's tokens are filled with the SAME renderer the server uses, so
 * what the preview shows is what the client receives.
 */

type Template = {
  id: string;
  name: string;
  subject: string;
  body: string;
  cta_label: string | null;
};

export type ComposeEmailProps = {
  open: boolean;
  onClose: () => void;
  /** Prefilled recipient — usually the client's or lead's address. */
  to?: string;
  subject?: string;
  body?: string;
  /** What this email is about; becomes the log row's links. */
  links?: Pick<
    ComposeEmailInput,
    "clientId" | "leadId" | "projectId" | "quoteId" | "proposalId"
  >;
  /** Attach a saved document, rendered server-side from the record. */
  attachInvoiceId?: string | null;
  attachProposalId?: string | null;
  /** T4.6 — the client's statement of account for a period. */
  attachStatement?: ComposeEmailInput["attachStatement"];
  /** A button under the body — a quote link, a portal link. */
  cta?: { href: string; label: string } | null;
  /** Values for {{tokens}} in a template. */
  tokens?: EmailTemplateValues;
  /** What the attachment chip says. */
  attachmentLabel?: string;
  title?: string;
  onSent?: () => void;
};

export function ComposeEmailModal({
  open,
  onClose,
  to = "",
  subject = "",
  body = "",
  links,
  attachInvoiceId = null,
  attachProposalId = null,
  attachStatement = null,
  cta = null,
  tokens,
  attachmentLabel,
  title = "Write to the client",
  onSent,
}: ComposeEmailProps) {
  const [form, setForm] = React.useState({ to, cc: "", subject, body });
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [sending, setSending] = React.useState(false);

  // Reset to what the caller passed each time it opens, so a modal reused on
  // a list doesn't carry the previous row's draft into the next one.
  React.useEffect(() => {
    if (open) setForm({ to, cc: "", subject, body });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, to, subject, body]);

  React.useEffect(() => {
    if (!open) return;
    void listEmailTemplates().then(setTemplates);
  }, [open]);

  function applyTemplate(id: string) {
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    const filled = renderEmailTemplate(template, tokens ?? {});
    setForm((f) => ({ ...f, subject: filled.subject, body: filled.body }));
  }

  async function handleSend() {
    setSending(true);
    const res = await sendComposedEmail({
      to: form.to,
      cc: form.cc,
      subject: form.subject,
      body: form.body,
      ...links,
      attachInvoiceId,
      attachProposalId,
      attachStatement,
      cta,
    });
    setSending(false);
    if (res.ok) {
      toast.success("Sent — it's on their record now.");
      onSent?.();
      onClose();
    } else {
      toast.error(res.error);
    }
  }

  const attached = attachInvoiceId || attachProposalId || attachStatement;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="It goes out from ARC AI and is saved against this record."
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={handleSend} loading={sending} disabled={sending}>
            Send
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {templates.length > 0 && (
          <label className="block space-y-1.5 text-xs font-medium text-slate-600">
            Start from a template
            <select
              defaultValue=""
              onChange={(e) => applyTemplate(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
            >
              <option value="">Write from scratch</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          To
          <Input
            value={form.to}
            onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
            placeholder="name@company.com"
          />
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          Cc <span className="font-normal text-slate-400">(optional)</span>
          <Input
            value={form.cc}
            onChange={(e) => setForm((f) => ({ ...f, cc: e.target.value }))}
            placeholder="Separate several with commas"
          />
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          Subject
          <Input
            value={form.subject}
            onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
          />
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-slate-600">
          Message
          <textarea
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            rows={10}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm leading-6 text-slate-700"
            placeholder="Blank lines become paragraphs."
          />
        </label>

        {(attached || cta) && (
          <div className="flex flex-wrap items-center gap-2">
            {attached && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                <Paperclip className="h-3 w-3" />
                {attachmentLabel ?? "Document attached as a PDF"}
              </span>
            )}
            {cta && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 px-2.5 py-1 text-xs text-primary-700">
                <Link2 className="h-3 w-3" />
                Button: {cta.label}
              </span>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
