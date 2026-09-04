"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileDown, FileSignature, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { markdownToHtml } from "@/lib/markdown";

import {
  agreementPdfUrl,
  saveAgreement,
  sendAgreement,
  voidAgreement,
} from "./actions";

/**
 * Contracts, SOWs and NDAs — raised here, signed on a link.
 *
 * Before this the agency's contracts lived in a Google Doc and a chase: a PDF
 * was emailed, printed, signed with a pen, photographed and sent back, and
 * nobody could say from the CRM whether a given project had one.
 */

export type AgreementRow = {
  id: string;
  kind: string;
  title: string;
  bodyMd: string;
  status: string;
  shareToken: string;
  clientId: string | null;
  clientName: string | null;
  signerEmail: string | null;
  signedName: string | null;
  signedAt: string | null;
  sentAt: string | null;
  hasPdf: boolean;
  createdAt: string;
};

type Template = { id: string; name: string; kind: string; body_md: string };

const STATUS: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-600 ring-slate-200" },
  sent: { label: "Sent", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  viewed: { label: "Opened", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  signed: {
    label: "Signed",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  declined: { label: "Declined", className: "bg-rose-50 text-rose-600 ring-rose-200" },
};

const KINDS = [
  { value: "contract", label: "Contract" },
  { value: "sow", label: "Scope of work" },
  { value: "nda", label: "NDA" },
  { value: "custom", label: "Other" },
] as const;

function shareUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/a/${token}`;
}

export function AgreementsView({
  agreements,
  templates,
  clients,
}: {
  agreements: AgreementRow[];
  templates: Template[];
  clients: { id: string; name: string }[];
}) {
  useRealtimeSync("agreements");
  const router = useRouter();
  const [editing, setEditing] = React.useState<AgreementRow | null>(null);
  const [creating, setCreating] = React.useState(false);

  async function download(id: string) {
    const url = await agreementPdfUrl(id);
    if (url) window.open(url, "_blank");
    else toast.error("No signed copy filed for this one yet.");
  }

  async function send(row: AgreementRow) {
    const to = row.signerEmail?.trim();
    if (!to) {
      toast.error("Add the signer's email first — open it and save one.");
      return;
    }
    const res = await sendAgreement(row.id, to, shareUrl(row.shareToken));
    if (res.ok) {
      toast.success(`Sent to ${to}.`);
      router.refresh();
    } else toast.error(res.error);
  }

  async function withdraw(id: string) {
    const res = await voidAgreement(id);
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agreements"
        description="Contracts, scopes of work and NDAs — sent as a link and signed online."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New agreement
          </Button>
        }
      />

      {agreements.length === 0 ? (
        <EmptyState
          icon={<FileSignature className="h-6 w-6" />}
          title="No agreements yet"
          description="Write one here and send the client a link — they read it and sign it in the browser."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New agreement
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/70 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Agreement</th>
                <th className="px-4 py-3 font-medium">With</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((a) => {
                const meta = STATUS[a.status] ?? STATUS.draft;
                return (
                  <tr
                    key={a.id}
                    className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60"
                  >
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setEditing(a)}
                        className="text-left font-semibold text-slate-900 hover:text-primary-600"
                      >
                        {a.title}
                      </button>
                      <span className="ml-2 text-xs uppercase text-slate-400">
                        {a.kind}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {a.clientName ?? a.signerEmail ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={meta.className}>{meta.label}</Badge>
                      {a.signedName && (
                        <span className="ml-2 text-xs text-slate-400">
                          by {a.signedName}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <CopyButton
                          value={shareUrl(a.shareToken)}
                          label="Copy the signing link"
                        />
                        {a.status !== "signed" && (
                          <Button size="sm" variant="ghost" onClick={() => send(a)}>
                            <Send className="h-4 w-4" />
                            {a.sentAt ? "Resend" : "Send"}
                          </Button>
                        )}
                        {a.hasPdf && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => download(a.id)}
                          >
                            <FileDown className="h-4 w-4" /> Signed copy
                          </Button>
                        )}
                        {a.status !== "signed" && (
                          <button
                            onClick={() => withdraw(a.id)}
                            aria-label="Withdraw"
                            className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AgreementModal
        open={creating || Boolean(editing)}
        agreement={editing}
        templates={templates}
        clients={clients}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function AgreementModal({
  open,
  agreement,
  templates,
  clients,
  onClose,
}: {
  open: boolean;
  agreement: AgreementRow | null;
  templates: Template[];
  clients: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState({
    kind: "contract",
    title: "",
    bodyMd: "",
    clientId: "",
    signerEmail: "",
  });
  const [saving, setSaving] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  const signed = agreement?.status === "signed";

  React.useEffect(() => {
    if (!open) return;
    setForm({
      kind: agreement?.kind ?? "contract",
      title: agreement?.title ?? "",
      // Load the real body, or editing would silently blank the agreement.
      bodyMd: agreement?.bodyMd ?? "",
      clientId: agreement?.clientId ?? "",
      signerEmail: agreement?.signerEmail ?? "",
    });
    setPreview(false);
  }, [open, agreement]);

  async function save() {
    setSaving(true);
    const res = await saveAgreement({
      id: agreement?.id ?? null,
      kind: form.kind as "contract",
      title: form.title,
      bodyMd: form.bodyMd,
      clientId: form.clientId || null,
      signerEmail: form.signerEmail || null,
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Saved.");
      onClose();
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={agreement ? agreement.title : "New agreement"}
      description={
        signed
          ? "This one is signed — the wording is now evidence and can't be edited."
          : "Markdown: # headings, - bullets, **bold**. It renders the same on the page and in the PDF."
      }
      size="xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!signed && (
            <Button onClick={save} loading={saving} disabled={saving}>
              Save
            </Button>
          )}
        </div>
      }
    >
      {signed ? (
        <p className="text-sm text-slate-500">
          Signed by {agreement?.signedName} on{" "}
          {agreement?.signedAt
            ? new Date(agreement.signedAt).toLocaleDateString()
            : "—"}
          . Raise a new agreement if the terms need to change.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind">
              <Select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Client">
              <Select
                value={form.clientId}
                onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
              >
                <option value="">Not linked</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Title" required>
            <Input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Website build — services agreement"
            />
          </Field>
          <Field label="Signer's email">
            <Input
              value={form.signerEmail}
              onChange={(e) => setForm((f) => ({ ...f, signerEmail: e.target.value }))}
              placeholder="Who receives the signing link"
            />
          </Field>

          {templates.length > 0 && (
            <Field label="Start from a template">
              <Select
                defaultValue=""
                onChange={(e) => {
                  const template = templates.find((t) => t.id === e.target.value);
                  if (template) {
                    setForm((f) => ({
                      ...f,
                      kind: template.kind,
                      bodyMd: template.body_md,
                    }));
                  }
                }}
              >
                <option value="">Write from scratch</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">The agreement</span>
              <button
                onClick={() => setPreview((p) => !p)}
                className="text-xs font-medium text-primary-600 hover:underline"
              >
                {preview ? "Edit" : "Preview"}
              </button>
            </div>
            {preview ? (
              <div
                className="min-h-[16rem] rounded-xl border border-slate-200 px-4 py-3 text-sm leading-relaxed text-slate-700 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-bold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:font-bold [&_li]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(form.bodyMd) }}
              />
            ) : (
              <Textarea
                value={form.bodyMd}
                onChange={(e) => setForm((f) => ({ ...f, bodyMd: e.target.value }))}
                rows={16}
                placeholder={"# Services\n\n1. What we will do\n2. What it costs\n\n## Term\n\nThis agreement runs until…"}
              />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
