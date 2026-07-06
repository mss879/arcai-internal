"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type {
  Client,
  Company,
  CrmField,
  Lead,
  MemberLite,
  PipelineStage,
} from "@/lib/types";

import { saveLead, type LeadInput } from "@/app/(app)/crm/actions";

export const LEAD_SOURCES = [
  "manual",
  "form",
  "webhook",
  "api",
  "import",
  "referral",
  "facebook",
  "google",
  "walk-in",
  "phone",
] as const;

export function LeadFormModal({
  open,
  onClose,
  pipelineId,
  stages,
  defaultStageId,
  members,
  clients,
  companies = [],
  customFields = [],
  lead,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  members: MemberLite[];
  clients: Pick<Client, "id" | "name" | "company">[];
  companies?: Pick<Company, "id" | "name">[];
  customFields?: CrmField[];
  lead?: Lead | null;
  onDelete?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<LeadInput>({
    pipeline_id: pipelineId,
    stage_id: defaultStageId ?? stages[0]?.id ?? "",
    title: "",
  });
  const [tagInput, setTagInput] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setTagInput("");
    setForm(
      lead
        ? {
            id: lead.id,
            pipeline_id: pipelineId,
            stage_id: lead.stage_id ?? stages[0]?.id ?? "",
            title: lead.title,
            company: lead.company ?? "",
            company_website: lead.company_website ?? "",
            contact_name: lead.contact_name ?? "",
            contact_email: lead.contact_email ?? "",
            contact_phone: lead.contact_phone ?? "",
            value: lead.value,
            currency: lead.currency,
            notes: lead.notes ?? "",
            assigned_to: lead.assigned_to,
            client_id: lead.client_id,
            company_id: lead.company_id,
            tags: lead.tags ?? [],
            source: lead.source ?? "manual",
            expected_close_date: lead.expected_close_date,
            probability: lead.probability,
            score: lead.score,
            custom: (lead.custom ?? {}) as Record<string, unknown>,
          }
        : {
            pipeline_id: pipelineId,
            stage_id: defaultStageId ?? stages[0]?.id ?? "",
            title: "",
            currency: "LKR",
            tags: [],
            source: "manual",
            custom: {},
          },
    );
  }, [open, lead, pipelineId, defaultStageId, stages]);

  function set<K extends keyof LeadInput>(k: K, v: LeadInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function addTag() {
    const tag = tagInput.trim().toLowerCase();
    if (!tag) return;
    if (!(form.tags ?? []).includes(tag)) set("tags", [...(form.tags ?? []), tag]);
    setTagInput("");
  }

  function submit() {
    startTransition(async () => {
      const res = await saveLead(form);
      if (res.ok) {
        toast.success(lead ? "Lead updated" : "Lead added");
        router.refresh();
        onClose();
      } else toast.error(res.error);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={lead ? "Edit lead" : "New lead"}
      size="lg"
      footer={
        <>
          {lead && onDelete && (
            <Button
              variant="ghost"
              onClick={onDelete}
              disabled={pending}
              className="mr-auto text-rose-600 hover:bg-rose-50 hover:text-rose-700"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {lead ? "Save changes" : "Add lead"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Deal / opportunity name"
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Company (free text)">
            <Input
              value={form.company ?? ""}
              onChange={(e) => set("company", e.target.value)}
              placeholder="e.g. Acme (Pvt) Ltd"
            />
          </Field>
          <Field label="Company website">
            <Input
              type="url"
              inputMode="url"
              value={form.company_website ?? ""}
              onChange={(e) => set("company_website", e.target.value)}
              placeholder="acme.lk — sharpens AI research"
            />
          </Field>
          <Field label="Value">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.value ?? ""}
              onChange={(e) =>
                set("value", e.target.value ? Number(e.target.value) : null)
              }
              placeholder="0.00"
            />
          </Field>
          <Field label="Contact name">
            <Input
              value={form.contact_name ?? ""}
              onChange={(e) => set("contact_name", e.target.value)}
            />
          </Field>
          <Field label="Contact email">
            <Input
              type="email"
              value={form.contact_email ?? ""}
              onChange={(e) => set("contact_email", e.target.value)}
            />
          </Field>
          <Field label="Contact phone">
            <Input
              value={form.contact_phone ?? ""}
              onChange={(e) => set("contact_phone", e.target.value)}
            />
          </Field>
          <Field label="Stage">
            <Select
              value={form.stage_id}
              onChange={(e) => set("stage_id", e.target.value)}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assign to">
            <Select
              value={form.assigned_to ?? ""}
              onChange={(e) => set("assigned_to", e.target.value || null)}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || m.username}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Link client">
            <Select
              value={form.client_id ?? ""}
              onChange={(e) => set("client_id", e.target.value || null)}
            >
              <option value="">No client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source">
            <Select
              value={form.source ?? "manual"}
              onChange={(e) => set("source", e.target.value)}
            >
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          {companies.length > 0 && (
            <Field label="Organization">
              <Select
                value={form.company_id ?? ""}
                onChange={(e) => set("company_id", e.target.value || null)}
              >
                <option value="">No organization</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Expected close date">
            <Input
              type="date"
              value={form.expected_close_date ?? ""}
              onChange={(e) => set("expected_close_date", e.target.value || null)}
            />
          </Field>
          <Field label="Win probability %">
            <Input
              type="number"
              min={0}
              max={100}
              value={form.probability ?? ""}
              onChange={(e) =>
                set("probability", e.target.value ? Number(e.target.value) : null)
              }
              placeholder="e.g. 60"
            />
          </Field>
        </div>

        {/* Tags */}
        <Field label="Tags">
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5">
            {(form.tags ?? []).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
              >
                {tag}
                <button
                  type="button"
                  onClick={() =>
                    set("tags", (form.tags ?? []).filter((t) => t !== tag))
                  }
                  className="text-slate-400 hover:text-rose-500"
                  aria-label={`Remove ${tag}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              placeholder={(form.tags ?? []).length ? "" : "Type a tag, press Enter"}
              className="min-w-28 flex-1 border-0 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-slate-300"
            />
          </div>
        </Field>

        {/* Custom fields */}
        {customFields.length > 0 && (
          <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-100 bg-slate-50/50 p-3 sm:grid-cols-2">
            {customFields.map((field) => {
              const value = (form.custom ?? {})[field.key];
              const setCustom = (v: unknown) =>
                set("custom", { ...(form.custom ?? {}), [field.key]: v });
              return (
                <Field key={field.id} label={field.label} required={field.required}>
                  {field.kind === "select" ? (
                    <Select
                      value={String(value ?? "")}
                      onChange={(e) => setCustom(e.target.value)}
                    >
                      <option value="">—</option>
                      {field.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  ) : field.kind === "checkbox" ? (
                    <label className="flex h-10 items-center gap-2 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={Boolean(value)}
                        onChange={(e) => setCustom(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-primary-600"
                      />
                      Yes
                    </label>
                  ) : (
                    <Input
                      type={
                        field.kind === "number"
                          ? "number"
                          : field.kind === "date"
                            ? "date"
                            : "text"
                      }
                      inputMode={field.kind === "phone" ? "tel" : undefined}
                      value={String(value ?? "")}
                      onChange={(e) => setCustom(e.target.value)}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        )}

        <Field label="Notes">
          <Textarea
            rows={3}
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
