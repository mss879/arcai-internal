"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Wallet, Plus, FileText, Receipt, Sparkles, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { STORAGE_BUCKETS } from "@/lib/constants";
import type { Client, Project, ProjectStatus } from "@/lib/types";
import { uploadFile } from "@/lib/upload";
import { formatCurrency } from "@/lib/utils";

import type { ProjectBrief } from "@/lib/ai/project-brief";

import { saveProject, type ProjectInput } from "@/app/(app)/projects/actions";
import { draftBrief } from "@/app/(app)/projects/ai-actions";
import { ClientFormModal } from "@/app/(app)/clients/clients-view";

export function ProjectFormModal({
  open,
  onClose,
  project,
  clients,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  clients: Pick<Client, "id" | "name" | "company">[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<ProjectInput>({ name: "" });
  const [isAddingClient, setIsAddingClient] = React.useState(false);

  // AI-1 (0098) — write the brief from the sale rather than from memory.
  const [drafting, setDrafting] = React.useState(false);
  const [brief, setBrief] = React.useState<ProjectBrief | null>(null);

  async function handleDraftBrief() {
    if (!form.client_id) {
      toast.error("Pick the client first — that's what the brief is read from.");
      return;
    }
    setDrafting(true);
    const res = await draftBrief({ clientId: form.client_id });
    setDrafting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    // Pre-fills, never overwrites something already typed: a half-filled form
    // is somebody's work in progress.
    setBrief(res.brief);
    setForm((prev) => ({
      ...prev,
      name: prev.name?.trim() ? prev.name : res.brief.name,
      description: prev.description?.trim()
        ? prev.description
        : [
            res.brief.summary,
            res.brief.deliverables.length
              ? `\n\nIncluded:\n${res.brief.deliverables.map((d) => `• ${d}`).join("\n")}`
              : "",
            res.brief.exclusions.length
              ? `\n\nNot included:\n${res.brief.exclusions.map((d) => `• ${d}`).join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join(""),
      service_type: prev.service_type ?? res.brief.service_type,
      due_date:
        prev.due_date ??
        (res.brief.estimated_days
          ? new Date(Date.now() + res.brief.estimated_days * 86400000)
              .toISOString()
              .slice(0, 10)
          : prev.due_date),
    }));
    toast.success("Brief drafted — read it before you save.");
  }
  /** Which document slot is mid-upload — blocks Save so nothing saves half-done. */
  const [uploading, setUploading] = React.useState<"proposal" | "invoice" | null>(
    null,
  );

  React.useEffect(() => {
    if (!open) return;
    setForm(
      project
        ? {
            id: project.id,
            name: project.name,
            description: project.description ?? "",
            client_id: project.client_id,
            status: project.status,
            budget: project.budget,
            currency: project.currency,
            start_date: project.start_date,
            due_date: project.due_date,
            total_value: project.total_value ?? 0,
            deposit_paid: project.deposit_paid ?? 0,
            service_type: project.service_type ?? null,
            proposal_url: project.proposal_url ?? null,
            proposal_name: project.proposal_name ?? null,
            proposal_path: project.proposal_path ?? null,
            invoice_url: project.invoice_url ?? null,
            invoice_name: project.invoice_name ?? null,
            invoice_path: project.invoice_path ?? null,
          }
        : {
            name: "",
            status: "planning",
            currency: "LKR",
            total_value: 0,
            deposit_paid: 0,
            service_type: null,
            proposal_url: null,
            proposal_name: null,
            proposal_path: null,
            invoice_url: null,
            invoice_name: null,
            invoice_path: null,
          },
    );
  }, [open, project]);

  function set<K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    if (uploading) {
      toast.error("Wait for the upload to finish.");
      return;
    }
    startTransition(async () => {
      const res = await saveProject(form);
      if (res.ok) {
        toast.success(project ? "Project updated" : "Project created");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={project ? "Edit project" : "New project"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Project name" required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Website redesign"
            autoFocus
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={form.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
            rows={2}
          />
        </Field>

        {/* AI-1 — the quote, the proposal and the WhatsApp thread already say
            what was agreed; this reads them instead of you retyping it. */}
        {!project && (
          <div className="rounded-xl border border-dashed border-fuchsia-200 bg-fuchsia-50/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-600">
                <span className="font-semibold text-slate-800">
                  Draft this from the sale.
                </span>{" "}
                Reads the client&apos;s quote, proposal and WhatsApp thread.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleDraftBrief}
                loading={drafting}
                disabled={!form.client_id}
              >
                <Sparkles className="h-4 w-4" /> Draft brief
              </Button>
            </div>

            {brief && (
              <div className="mt-3 space-y-2 text-xs">
                {brief.estimated_days && (
                  <p className="text-slate-600">
                    <span className="font-semibold">Estimated:</span>{" "}
                    {brief.estimated_days} days, from what your past projects of
                    this type actually took.
                  </p>
                )}
                {brief.open_questions.length > 0 && (
                  <div className="rounded-lg bg-amber-50 px-2.5 py-2 text-amber-800">
                    <p className="font-semibold">The sale didn&apos;t settle:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {brief.open_questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(brief.tasks.length > 0 || brief.assets.length > 0) && (
                  <p className="text-slate-500">
                    It also suggested {brief.tasks.length} task
                    {brief.tasks.length === 1 ? "" : "s"} and {brief.assets.length}{" "}
                    asset{brief.assets.length === 1 ? "" : "s"} to collect — seed
                    them from a plan template on the project once it exists.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <Field label="Client" className="sm:col-span-2">
            <div className="flex gap-2">
              <Select
                value={form.client_id ?? ""}
                onChange={(e) => set("client_id", e.target.value || null)}
                className="flex-grow"
              >
                <option value="">No client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company ? ` · ${c.company}` : ""}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddingClient(true)}
                className="px-3"
                title="Add new client"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </Field>

          <Field label="Status" className="sm:col-span-1">
            <Select
              value={form.status ?? "planning"}
              onChange={(e) => set("status", e.target.value as ProjectStatus)}
            >
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>

          <Field label="Service Type" className="sm:col-span-1">
            <Select
              value={form.service_type ?? ""}
              onChange={(e) => set("service_type", e.target.value || null)}
            >
              <option value="">Select type</option>
              <option value="business_website">Business Website</option>
              <option value="ecommerce_website">E-commerce Website</option>
              <option value="social_media_marketing">Social Media Marketing</option>
            </Select>
          </Field>

          <Field label="Total Value" className="sm:col-span-1">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.total_value ?? ""}
              onChange={(e) =>
                set("total_value", e.target.value ? Number(e.target.value) : 0)
              }
              placeholder="0.00"
            />
          </Field>

          <Field label="Deposit Paid" className="sm:col-span-1">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.deposit_paid ?? ""}
              onChange={(e) =>
                set("deposit_paid", e.target.value ? Number(e.target.value) : 0)
              }
              placeholder="0.00"
            />
          </Field>

          <div className="sm:col-span-2 rounded-2xl bg-slate-50 border border-slate-200/80 p-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-500/10 text-primary-600">
                <Wallet className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Wallet Indicator</p>
                <p className="text-[11px] font-medium text-slate-400">Balance to pay</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-base font-extrabold text-slate-800">
                {formatCurrency(
                  Math.max(0, (form.total_value ?? 0) - (form.deposit_paid ?? 0)),
                  form.currency || "LKR"
                )}
              </p>
            </div>
          </div>

          <Field label="Currency" className="sm:col-span-2">
            <Input
              value={form.currency ?? "USD"}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
              maxLength={3}
            />
          </Field>

          <Field label="Start date" className="sm:col-span-1">
            <Input
              type="date"
              value={form.start_date ?? ""}
              onChange={(e) => set("start_date", e.target.value || null)}
            />
          </Field>

          <Field label="Due date" className="sm:col-span-1">
            <Input
              type="date"
              value={form.due_date ?? ""}
              onChange={(e) => set("due_date", e.target.value || null)}
            />
          </Field>
        </div>

        <div className="space-y-3 border-t border-slate-200/80 pt-4">
          <div>
            <p className="text-sm font-semibold text-slate-800">Documents</p>
            <p className="text-xs text-slate-400">
              Attach the signed proposal and the invoice for this project.
              Optional — you can add them later by editing the project.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <DocumentSlot
              label="Proposal"
              icon={<FileText className="h-4 w-4" />}
              fileName={form.proposal_name ?? null}
              fileUrl={form.proposal_url ?? null}
              busy={uploading === "proposal"}
              disabled={uploading !== null && uploading !== "proposal"}
              onPick={async (file) => {
                setUploading("proposal");
                try {
                  const { path, publicUrl } = await uploadFile(
                    STORAGE_BUCKETS.projectDocs,
                    file,
                    "proposals",
                  );
                  setForm((f) => ({
                    ...f,
                    proposal_url: publicUrl,
                    proposal_name: file.name,
                    proposal_path: path,
                  }));
                  toast.success("Proposal attached");
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Upload failed",
                  );
                } finally {
                  setUploading(null);
                }
              }}
              onClear={() =>
                setForm((f) => ({
                  ...f,
                  proposal_url: null,
                  proposal_name: null,
                  proposal_path: null,
                }))
              }
            />
            <DocumentSlot
              label="Invoice"
              icon={<Receipt className="h-4 w-4" />}
              fileName={form.invoice_name ?? null}
              fileUrl={form.invoice_url ?? null}
              busy={uploading === "invoice"}
              disabled={uploading !== null && uploading !== "invoice"}
              onPick={async (file) => {
                setUploading("invoice");
                try {
                  const { path, publicUrl } = await uploadFile(
                    STORAGE_BUCKETS.projectDocs,
                    file,
                    "invoices",
                  );
                  setForm((f) => ({
                    ...f,
                    invoice_url: publicUrl,
                    invoice_name: file.name,
                    invoice_path: path,
                  }));
                  toast.success("Invoice attached");
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Upload failed",
                  );
                } finally {
                  setUploading(null);
                }
              }}
              onClear={() =>
                setForm((f) => ({
                  ...f,
                  invoice_url: null,
                  invoice_name: null,
                  invoice_path: null,
                }))
              }
            />
          </div>
        </div>
      </div>
      <ClientFormModal
        open={isAddingClient}
        client={null}
        onClose={() => setIsAddingClient(false)}
        onSaved={(newClient) => {
          if (newClient?.id) {
            set("client_id", newClient.id);
          }
          router.refresh();
        }}
      />
    </Modal>
  );
}

/** One document slot — empty it offers a file picker, filled it shows the
 * attached file with a link to open it and an X to detach. */
function DocumentSlot({
  label,
  icon,
  fileName,
  fileUrl,
  busy,
  disabled,
  onPick,
  onClear,
}: {
  label: string;
  icon: React.ReactNode;
  fileName: string | null;
  fileUrl: string | null;
  busy: boolean;
  disabled: boolean;
  onPick: (file: File) => void | Promise<void>;
  onClear: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-white text-primary-600 ring-1 ring-slate-200">
          {icon}
        </span>
        {label}
      </div>

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first so re-picking the same file still fires onChange.
          e.target.value = "";
          if (file) void onPick(file);
        }}
      />

      {fileUrl ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate text-sm font-medium text-primary-700 hover:underline"
            title={fileName ?? "Open document"}
          >
            {fileName ?? "Open document"}
          </a>
          <button
            type="button"
            onClick={onClear}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white hover:text-rose-600"
            title={`Remove ${label.toLowerCase()}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="mt-2 w-full"
          loading={busy}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-4 w-4" /> Upload {label.toLowerCase()}
        </Button>
      )}
    </div>
  );
}
