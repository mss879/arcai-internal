"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  FileText,
  KeyRound,
  MessageCircle,
  Plus,
  Receipt,
  Send,
  Sparkles,
  Upload,
  Wallet,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { projectPackageOptions } from "@/lib/package-match";
import type { Client, Project, ProjectStatus } from "@/lib/types";
import { uploadFile } from "@/lib/upload";
import { cn, formatCurrency } from "@/lib/utils";

import type { ProjectBrief } from "@/lib/ai/project-brief";

import {
  saveProject,
  type ProjectInput,
  type SaveProjectResult,
} from "@/app/(app)/projects/actions";
import { draftBrief } from "@/app/(app)/projects/ai-actions";
import {
  rollPortalPasscode,
  sendPortalToClient,
} from "@/app/(app)/projects/portal-actions";
import { ClientFormModal } from "@/app/(app)/clients/clients-view";

/** What a quote or a proposal hands the form to start from (0112). */
export type ProjectPrefill = {
  input: Partial<ProjectInput>;
  /** "Quote Q-0042", "Proposal for Silva Motors" — shown above the form. */
  sourceLabel?: string;
};

type ModalClient = Pick<Client, "id" | "name" | "company"> & {
  phone?: string | null;
};

const EMPTY: ProjectInput = {
  name: "",
  status: "planning",
  currency: "LKR",
  total_value: 0,
  deposit_paid: 0,
  service_type: null,
  package_key: null,
  proposal_url: null,
  proposal_name: null,
  proposal_path: null,
  invoice_url: null,
  invoice_name: null,
  invoice_path: null,
};

/**
 * Create or edit a project — and, on create, hand the client their tracking
 * link before the dialog closes (0112).
 *
 * Step 1 is the form. Step 2 only exists after a CREATE: the link, the
 * passcode, and what happened to the automatic send (WhatsApp, SMS, or why
 * not) with a retry — so nobody has to go looking for the Client tab to find
 * out whether the customer was told.
 */
export function ProjectFormModal({
  open,
  onClose,
  project,
  clients,
  prefill = null,
  portalAutoSend = true,
  baseUrl,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  clients: ModalClient[];
  prefill?: ProjectPrefill | null;
  /** delivery_settings.portal_auto_send — the default for the send tick. */
  portalAutoSend?: boolean;
  /** Absolute origin from the server, for the link on step 2. */
  baseUrl?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<ProjectInput>({ name: "" });
  const [isAddingClient, setIsAddingClient] = React.useState(false);
  const [sendPortal, setSendPortal] = React.useState(true);
  const [created, setCreated] = React.useState<SaveProjectResult | null>(null);
  const packages = React.useMemo(() => projectPackageOptions(), []);

  // AI-1 (0098) — write the brief from the sale rather than from memory.
  const [drafting, setDrafting] = React.useState(false);
  const [brief, setBrief] = React.useState<ProjectBrief | null>(null);

  /** Which document slot is mid-upload — blocks Save so nothing saves half-done. */
  const [uploading, setUploading] = React.useState<"proposal" | "invoice" | null>(
    null,
  );

  // Initialise only when the dialog OPENS. Re-running on every prop change
  // would wipe step 2 the moment router.refresh() re-renders the parent.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setCreated(null);
      setBrief(null);
      setSendPortal(portalAutoSend);
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
              package_key: project.package_key ?? null,
              proposal_url: project.proposal_url ?? null,
              proposal_name: project.proposal_name ?? null,
              proposal_path: project.proposal_path ?? null,
              invoice_url: project.invoice_url ?? null,
              invoice_name: project.invoice_name ?? null,
              invoice_path: project.invoice_path ?? null,
            }
          : { ...EMPTY, ...(prefill?.input ?? {}) },
      );
    }
    wasOpen.current = open;
  }, [open, project, prefill, portalAutoSend]);

  const isEdit = Boolean(project);
  const selectedClient = clients.find((c) => c.id === form.client_id) ?? null;
  const clientHasPhone = Boolean(selectedClient?.phone?.trim());

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

  function set<K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  /** A package sets the service type, and the value when none was typed yet. */
  function choosePackage(key: string) {
    const pkg = packages.find((p) => p.key === key) ?? null;
    setForm((f) => ({
      ...f,
      package_key: key || null,
      service_type: pkg?.serviceType ?? f.service_type ?? null,
      total_value: !f.total_value && pkg?.amount ? pkg.amount : f.total_value,
    }));
  }

  function submit() {
    if (uploading) {
      toast.error("Wait for the upload to finish.");
      return;
    }
    startTransition(async () => {
      const res = await saveProject({
        ...form,
        send_portal: !isEdit && clientHasPhone && sendPortal,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.refresh();
      if (res.created) {
        toast.success("Project created");
        setCreated(res);
      } else {
        toast.success("Project updated");
        onClose();
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        created ? "Share with the client" : project ? "Edit project" : "New project"
      }
      footer={
        created ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={pending}>
              {project ? "Save changes" : "Create project"}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <SharePanel
          result={created}
          projectName={form.name}
          client={selectedClient}
          baseUrl={baseUrl}
          onGoToProject={() => {
            onClose();
            router.push(`/projects/${created.id}`);
          }}
        />
      ) : (
        <div className="space-y-4">
          {prefill?.sourceLabel && !isEdit && (
            <p className="rounded-xl border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs text-sky-800">
              Started from <span className="font-semibold">{prefill.sourceLabel}</span> —
              the client, value and package came across; check them before you save.
            </p>
          )}

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

            <Field label="Package" className="sm:col-span-2">
              <Select
                value={form.package_key ?? ""}
                onChange={(e) => choosePackage(e.target.value)}
              >
                <option value="">Not from the catalogue</option>
                {packages.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                    {p.amount ? ` · ${formatCurrency(p.amount, "LKR")}` : ""}
                  </option>
                ))}
              </Select>
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

          {/* 0112 — the tracking link goes out the moment the project exists. */}
          {!isEdit && (
            <label
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-2xl border p-3 transition",
                clientHasPhone
                  ? "border-emerald-200 bg-emerald-50/50"
                  : "border-slate-200 bg-slate-50/60",
              )}
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-primary-600"
                checked={clientHasPhone && sendPortal}
                disabled={!clientHasPhone}
                onChange={(e) => setSendPortal(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  <MessageCircle className="h-4 w-4 text-emerald-600" />
                  Send {selectedClient ? selectedClient.name.split(/\s+/)[0] : "the client"}{" "}
                  the tracking link on WhatsApp now
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {clientHasPhone
                    ? `One message with the link (and the passcode, if you set one) — SMS if WhatsApp can't deliver. To ${selectedClient?.phone}.`
                    : selectedClient
                      ? `${selectedClient.name} has no phone number on their record — you can still copy the link after saving.`
                      : "Pick a client with a phone number to send it automatically."}
                </span>
              </span>
            </label>
          )}

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
      )}
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

/* ------------------------------------------------------------------ */
/* Step 2 — share with the client (0112)                              */
/* ------------------------------------------------------------------ */

type SendState = SaveProjectResult["send"];

function SharePanel({
  result,
  projectName,
  client,
  baseUrl,
  onGoToProject,
}: {
  result: SaveProjectResult;
  projectName: string;
  client: ModalClient | null;
  baseUrl?: string;
  onGoToProject: () => void;
}) {
  const [origin, setOrigin] = React.useState(baseUrl ?? "");
  React.useEffect(() => {
    if (!origin && typeof window !== "undefined") setOrigin(window.location.origin);
  }, [origin]);
  const link =
    origin && result.shareToken ? `${origin}/public/project/${result.shareToken}` : "";

  const [copied, setCopied] = React.useState(false);
  const [passcode, setPasscode] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"code" | "send" | null>(null);
  const [send, setSend] = React.useState<SendState>(result.send);

  const clientHasPhone = Boolean(client?.phone?.trim());

  function copy() {
    if (!link) return;
    navigator.clipboard.writeText(link);
    setCopied(true);
    toast.success("Client link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  async function setCode() {
    setBusy("code");
    const res = await rollPortalPasscode(result.id);
    setBusy(null);
    if (res.ok && res.passcode) {
      setPasscode(res.passcode);
      toast.success(`Passcode set: ${res.passcode}`);
    } else if (!res.ok) toast.error(res.error);
  }

  async function sendNow() {
    setBusy("send");
    const res = await sendPortalToClient(result.id);
    setBusy(null);
    if (res.ok) {
      const channel =
        res.channel === "whatsapp" || res.channel === "whatsapp_template" || res.channel === "sms"
          ? res.channel
          : "sms";
      setSend({ ok: true, channel, to: res.to ?? "", preview: res.preview ?? "" });
      toast.success(`Sent on ${channel === "sms" ? "SMS" : "WhatsApp"}`);
    } else {
      setSend({ ok: false, reason: "send_failed", error: res.error });
      toast.error(res.error);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
          <Check className="h-5 w-5" strokeWidth={3} />
        </span>
        <div>
          <p className="text-sm font-semibold text-slate-900">
            {projectName || "The project"} is ready.
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            This link shows the client how far along the build is, what we need
            from them, and their payments — nothing internal.
          </p>
        </div>
      </div>

      {/* The link */}
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Client tracking link
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            readOnly
            value={link}
            className="min-w-0 flex-1 select-all rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 focus:outline-none"
          />
          <Button variant="outline" size="sm" onClick={copy} disabled={!link}>
            {copied ? (
              <Check className="h-4 w-4 text-emerald-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            Copy
          </Button>
          <a href={link || "#"} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm" disabled={!link}>
              <ExternalLink className="h-4 w-4" /> Open
            </Button>
          </a>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          {passcode ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
              <KeyRound className="h-3.5 w-3.5" /> Passcode {passcode} — anyone opening
              the link must enter it
            </span>
          ) : (
            <span>Open link — anyone holding it can view the project.</span>
          )}
          {!passcode && (
            <button
              type="button"
              onClick={setCode}
              disabled={busy === "code"}
              className="inline-flex items-center gap-1 font-medium text-primary-600 hover:underline disabled:opacity-50"
            >
              <KeyRound className="h-3.5 w-3.5" /> Set a passcode
            </button>
          )}
        </div>
      </div>

      {/* What happened */}
      <div
        className={cn(
          "rounded-2xl border p-4",
          send?.ok
            ? "border-emerald-200 bg-emerald-50/50"
            : "border-amber-200 bg-amber-50/60",
        )}
      >
        {send?.ok ? (
          <>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
              <MessageCircle className="h-4 w-4" />
              Sent on {send.channel === "sms" ? "SMS" : "WhatsApp"} to{" "}
              {client?.name ?? "the client"} ({send.to})
            </p>
            {send.preview && (
              <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-emerald-100 bg-white px-3 py-2 font-sans text-xs leading-relaxed text-slate-600">
                {send.preview}
              </pre>
            )}
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-amber-900">
              {send
                ? `Not sent — ${send.error}`
                : client
                  ? clientHasPhone
                    ? "Not sent yet."
                    : `${client.name} has no phone number on their record, so the link can't be messaged. Copy it above, or add a number and send it from the project.`
                  : "No client on this project yet — attach one to send the link."}
            </p>
            {send && !send.ok && send.taskCreated && (
              <p className="mt-1 text-xs text-amber-800">
                A task was raised for the team to send it by hand.
              </p>
            )}
          </>
        )}
        {clientHasPhone && (
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant={send?.ok ? "outline" : "primary"}
              onClick={sendNow}
              loading={busy === "send"}
            >
              <Send className="h-3.5 w-3.5" />
              {send?.ok ? "Send again" : "Send now"}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onGoToProject}>
          Go to project <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
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
