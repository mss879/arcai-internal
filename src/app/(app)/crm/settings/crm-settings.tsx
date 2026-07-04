"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Bookmark, Plus, SlidersHorizontal, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import type { CrmField, CrmFieldKind, CrmSegment, Pipeline } from "@/lib/types";

import {
  deleteCrmField,
  deleteSegment,
  saveCrmField,
  updatePipeline,
} from "../actions";

const FIELD_KINDS: { value: CrmFieldKind; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Dropdown" },
  { value: "checkbox", label: "Checkbox" },
  { value: "url", label: "URL" },
  { value: "phone", label: "Phone" },
];

export function CrmSettings({
  fields,
  pipelines,
  segments,
}: {
  fields: CrmField[];
  pipelines: Pipeline[];
  segments: CrmSegment[];
}) {
  const router = useRouter();
  const [fieldModal, setFieldModal] = React.useState<CrmField | "new" | null>(null);
  const [fieldToDelete, setFieldToDelete] = React.useState<CrmField | null>(null);

  async function handleDeleteField() {
    if (!fieldToDelete) return;
    const res = await deleteCrmField(fieldToDelete.id);
    if (res.ok) {
      toast.success("Field removed (existing values stay stored on leads).");
      router.refresh();
    } else toast.error(res.error);
  }

  async function handleDeleteSegment(segment: CrmSegment) {
    const res = await deleteSegment(segment.id);
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/crm"
          className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:text-slate-800"
          aria-label="Back to CRM"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <PageHeader
          title="CRM settings"
          description="Custom fields for your industry, stale-deal thresholds per pipeline, and saved smart segments."
        />
      </div>

      {/* Custom fields */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <SlidersHorizontal className="h-4 w-4 text-slate-400" />
              Custom fields
            </h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Vehicle number, patient age, property budget — whatever your industry needs. Fields
              appear on every lead form and detail page.
            </p>
          </div>
          <Button size="sm" onClick={() => setFieldModal("new")}>
            <Plus className="h-4 w-4" />
            New field
          </Button>
        </div>

        {fields.length > 0 && (
          <div className="mt-4 space-y-2">
            {fields.map((field) => (
              <div
                key={field.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5"
              >
                <button
                  onClick={() => setFieldModal(field)}
                  className="text-sm font-medium text-slate-800 hover:text-primary-600"
                >
                  {field.label}
                </button>
                <Badge className="bg-slate-100 text-slate-500 ring-slate-200">
                  {FIELD_KINDS.find((k) => k.value === field.kind)?.label ?? field.kind}
                </Badge>
                <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                  custom.{field.key}
                </code>
                {field.required && (
                  <Badge className="bg-amber-50 text-amber-600 ring-amber-200">required</Badge>
                )}
                <button
                  onClick={() => setFieldToDelete(field)}
                  className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Delete field"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pipelines */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <h3 className="text-sm font-semibold text-slate-900">Pipelines</h3>
        <p className="mt-0.5 text-sm text-slate-500">
          Set how long a deal may sit untouched before it&apos;s flagged stale on the board.
        </p>
        <div className="mt-4 space-y-2">
          {pipelines.map((pipeline) => (
            <PipelineRow key={pipeline.id} pipeline={pipeline} />
          ))}
        </div>
      </section>

      {/* Segments */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Bookmark className="h-4 w-4 text-slate-400" />
          Smart segments
        </h3>
        <p className="mt-0.5 text-sm text-slate-500">
          Saved filters that auto-update. Create them from the CRM board (“Save segment”).
        </p>
        {segments.length > 0 ? (
          <div className="mt-4 space-y-2">
            {segments.map((segment) => (
              <div
                key={segment.id}
                className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5"
              >
                <span className="text-sm font-medium text-slate-800">{segment.name}</span>
                <code className="truncate rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                  {JSON.stringify(segment.filters)}
                </code>
                <button
                  onClick={() => handleDeleteSegment(segment)}
                  className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Delete segment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-400">No segments saved yet.</p>
        )}
      </section>

      <FieldModal
        open={fieldModal !== null}
        field={fieldModal === "new" ? null : fieldModal}
        onClose={() => setFieldModal(null)}
      />
      <ConfirmDialog
        open={fieldToDelete !== null}
        onClose={() => setFieldToDelete(null)}
        onConfirm={handleDeleteField}
        title={`Delete "${fieldToDelete?.label}"?`}
        description="The field disappears from forms. Values already saved on leads remain in their data."
      />
    </div>
  );
}

function PipelineRow({ pipeline }: { pipeline: Pipeline }) {
  const router = useRouter();
  const [days, setDays] = React.useState(String(pipeline.stale_after_days));

  async function save() {
    const value = Math.max(1, Number(days) || 7);
    if (value === pipeline.stale_after_days) return;
    const res = await updatePipeline(pipeline.id, { stale_after_days: value });
    if (res.ok) {
      toast.success(`"${pipeline.name}" now flags deals after ${value} days.`);
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
      <span className="text-sm font-medium text-slate-800">{pipeline.name}</span>
      <span className="ml-auto flex items-center gap-2 text-sm text-slate-500">
        stale after
        <Input
          type="number"
          min={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          onBlur={save}
          className="w-20"
        />
        days untouched
      </span>
    </div>
  );
}

function FieldModal({
  open,
  field,
  onClose,
}: {
  open: boolean;
  field: CrmField | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [label, setLabel] = React.useState("");
  const [kind, setKind] = React.useState<CrmFieldKind>("text");
  const [options, setOptions] = React.useState("");
  const [required, setRequired] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLabel(field?.label ?? "");
    setKind(field?.kind ?? "text");
    setOptions((field?.options ?? []).join(", "));
    setRequired(field?.required ?? false);
  }, [open, field]);

  async function handleSave() {
    setSaving(true);
    const res = await saveCrmField({
      id: field?.id,
      label,
      kind,
      options:
        kind === "select"
          ? options.split(",").map((o) => o.trim()).filter(Boolean)
          : [],
      required,
    });
    setSaving(false);
    if (res.ok) {
      toast.success(field ? "Field updated." : "Field added to every lead form.");
      onClose();
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={field ? "Edit field" : "New custom field"}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!label.trim()}>
            {field ? "Save" : "Add field"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Label" required>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Vehicle number"
            autoFocus
          />
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as CrmFieldKind)}>
            {FIELD_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "select" && (
          <Field label="Options" hint="Comma separated.">
            <Input
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="Small, Medium, Large"
            />
          </Field>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-primary-600"
          />
          Required on the lead form
        </label>
      </div>
    </Modal>
  );
}
