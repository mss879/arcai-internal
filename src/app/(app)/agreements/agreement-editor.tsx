"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, FilePlus2, Lock, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import {
  BUILT_IN_AGREEMENT_TEMPLATES,
  fillAgreementTokens,
} from "@/lib/agreement-templates";

import { saveAgreement, sendAgreement } from "./actions";
import { AgreementPdfFrame } from "./agreement-pdf-frame";
import { downloadAgreementPdf } from "./download-pdf";
import type { AgreementPrefill, AgreementRow, Template } from "./agreements-view";

/**
 * Writing an agreement, in the proposal generator's shape: the form on the
 * left, the real rendered PDF on the right, updating as you type.
 *
 * This replaced a modal with a Markdown textarea and an HTML "Preview"
 * toggle. Two problems with that: the preview was not the document — it was a
 * CSS approximation of it, so nobody could see where a contract broke across
 * pages — and a 20-clause services agreement in a modal is not something you
 * can read while you edit it. The contract is the highest-stakes document the
 * CRM sends; it deserves the same screen the proposal gets.
 */

const KINDS = [
  { value: "contract", label: "Contract" },
  { value: "nda", label: "NDA" },
  { value: "sow", label: "Scope of work" },
  { value: "custom", label: "Other" },
] as const;

/** Today, as the ISO date the PDF prints. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AgreementEditor({
  agreement,
  templates,
  clients,
  prefill,
  onExitEdit,
  onSaved,
}: {
  agreement: AgreementRow | null;
  templates: Template[];
  clients: { id: string; name: string }[];
  prefill: AgreementPrefill | null;
  onExitEdit: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const signed = agreement?.status === "signed";

  const [kind, setKind] = React.useState(agreement?.kind ?? "contract");
  const [title, setTitle] = React.useState(agreement?.title ?? prefill?.title ?? "");
  const [bodyMd, setBodyMd] = React.useState(agreement?.bodyMd ?? "");
  const [clientId, setClientId] = React.useState(
    agreement?.clientId ?? prefill?.clientId ?? "",
  );
  const [signerEmail, setSignerEmail] = React.useState(agreement?.signerEmail ?? "");
  const [date, setDate] = React.useState(agreement?.createdAt?.slice(0, 10) ?? today());
  const [saving, setSaving] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  // Carried through every save, never edited here: an edit must not drop the
  // project or proposal an agreement was raised from.
  const projectId = agreement?.projectId ?? prefill?.projectId ?? "";
  const proposalId = agreement?.proposalId ?? prefill?.proposalId ?? "";

  const clientName =
    clients.find((c) => c.id === clientId)?.name ?? agreement?.clientName ?? "";

  /** Built-ins first — they are the ones anybody sending a contract wants. */
  const allTemplates: Template[] = React.useMemo(
    () => [...BUILT_IN_AGREEMENT_TEMPLATES, ...templates],
    [templates],
  );

  function applyTemplate(id: string) {
    const t = allTemplates.find((x) => x.id === id);
    if (!t) return;
    if (
      bodyMd.trim() &&
      !window.confirm("Replace what's written with this template?")
    ) {
      return;
    }
    setKind(t.kind);
    setBodyMd(
      fillAgreementTokens(t.body_md, {
        client: clientName,
        project: title || prefill?.title || null,
        date,
      }),
    );
    if (!title.trim()) {
      setTitle(
        t.kind === "nda"
          ? `Mutual NDA${clientName ? ` — ${clientName}` : ""}`
          : `Services agreement${clientName ? ` — ${clientName}` : ""}`,
      );
    }
  }

  const payload = React.useMemo(
    () => ({
      kind,
      title: title || "Agreement",
      bodyMd,
      clientName: clientName || null,
      date,
    }),
    [kind, title, bodyMd, clientName, date],
  );

  async function save(): Promise<string | null> {
    setSaving(true);
    const res = await saveAgreement({
      id: agreement?.id ?? null,
      kind: kind as "contract",
      title,
      bodyMd,
      clientId: clientId || null,
      projectId: projectId || null,
      proposalId: proposalId || null,
      signerEmail: signerEmail || null,
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    toast.success("Saved.");
    router.refresh();
    return res.id;
  }

  async function saveAndSend() {
    const to = signerEmail.trim();
    if (!to) {
      toast.error("Add the signer's email first.");
      return;
    }
    const id = await save();
    if (!id) return;
    // The token is minted on insert, so a brand-new agreement has none in
    // hand here — the list row does. Save first, send from there.
    const token = agreement?.shareToken;
    if (!token) {
      toast.success("Saved — open it from the list to send the signing link.");
      onSaved();
      return;
    }
    setSaving(true);
    const res = await sendAgreement(id, to, `${window.location.origin}/a/${token}`);
    setSaving(false);
    if (res.ok) {
      toast.success(`Sent to ${to}.`);
      onSaved();
      router.refresh();
    } else toast.error(res.error);
  }

  async function download() {
    setDownloading(true);
    try {
      await downloadAgreementPdf(payload);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't generate the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {agreement ? "Editing agreement" : "New agreement"}
          </h1>
          <p className="text-sm text-slate-500">
            {signed
              ? "Signed — the wording is evidence now and can't be changed."
              : "Start from a template, edit the wording, and watch the document the client will sign build itself on the right."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {agreement && (
            <Button variant="ghost" onClick={onExitEdit}>
              <FilePlus2 className="h-4 w-4" /> New agreement
            </Button>
          )}
          <Button
            variant="outline"
            onClick={download}
            loading={downloading}
            disabled={!bodyMd.trim()}
          >
            <Download className="h-4 w-4" /> Download PDF
          </Button>
          {!signed && (
            <>
              <Button variant="outline" onClick={save} loading={saving} disabled={saving}>
                Save
              </Button>
              <Button onClick={saveAndSend} disabled={saving}>
                <Send className="h-4 w-4" /> Save &amp; send
              </Button>
            </>
          )}
        </div>
      </div>

      {signed && (
        <div className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Signed by {agreement?.signedName ?? "the client"}
            {agreement?.signedAt
              ? ` on ${new Date(agreement.signedAt).toLocaleDateString()}`
              : ""}
            . Raise a new agreement if the terms need to change.
          </span>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(360px,440px)_1fr]">
        {/* ---------- FORM ---------- */}
        <div className="space-y-5">
          <Card title="Who it's with">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Kind">
                <Select
                  value={kind}
                  disabled={signed}
                  onChange={(e) => setKind(e.target.value)}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date">
                <Input
                  type="date"
                  value={date}
                  disabled={signed}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Client"
              hint="Names the other party on the document, and files it on their record."
            >
              <Select
                value={clientId}
                disabled={signed}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Not linked</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title" required>
              <Input
                value={title}
                disabled={signed}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Website build — services agreement"
              />
            </Field>
            <Field label="Signer's email" hint="Who receives the signing link.">
              <Input
                value={signerEmail}
                disabled={signed}
                onChange={(e) => setSignerEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </Field>
            {(projectId || proposalId) && (
              <p className="text-xs text-slate-500">
                Linked to {projectId ? "the project" : "the proposal"} it was raised
                from — it shows on that record and on the client&apos;s portal.
              </p>
            )}
          </Card>

          {!signed && (
            <Card title="Start from a template">
              <Field
                label="Template"
                hint="The standard wording, with the client and date filled in. Edit freely afterwards."
              >
                <Select value="" onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">Write from scratch</option>
                  {allTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="text-xs leading-relaxed text-slate-500">
                The services agreement deliberately carries no scope of work — the
                accepted proposal is what says what is being built and for how much,
                and the contract points at it rather than repeating it.
              </p>
            </Card>
          )}

          <Card title="The wording">
            <Textarea
              value={bodyMd}
              disabled={signed}
              onChange={(e) => setBodyMd(e.target.value)}
              rows={26}
              className="font-mono text-[12px] leading-relaxed"
              placeholder={"# Services Agreement\n\n## 1. The parties\n\n…"}
            />
            <p className="text-xs text-slate-500">
              Markdown: <code className="rounded bg-slate-100 px-1">#</code> headings,{" "}
              <code className="rounded bg-slate-100 px-1">-</code> bullets,{" "}
              <code className="rounded bg-slate-100 px-1">1.</code> numbered lists,{" "}
              <code className="rounded bg-slate-100 px-1">**bold**</code>. It renders
              the same on the signing page and in the PDF.
            </p>
          </Card>
        </div>

        {/* ---------- LIVE PREVIEW — the real PDF, exactly as sent ---------- */}
        <div className="min-w-0">
          <AgreementPdfFrame className="sticky top-4 h-[85vh]" payload={payload} />
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}
