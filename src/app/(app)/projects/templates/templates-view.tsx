"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Flag,
  Layers,
  ListTodo,
  Package,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectsSectionNav } from "@/components/projects/section-nav";
import {
  PROJECT_ROLES,
  SERVICE_TYPE_LABELS,
} from "@/lib/constants";
import type {
  ProjectTemplate,
  ProjectTemplateItem,
  TemplateItemKind,
  TodoPriority,
} from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

import {
  deleteTemplate,
  deleteTemplateItem,
  saveTemplate,
  saveTemplateItem,
} from "@/app/(app)/projects/plan-actions";

const KIND_META: Record<
  TemplateItemKind,
  { label: string; plural: string; icon: React.ReactNode; badge: string; blurb: string }
> = {
  task: {
    label: "Task",
    plural: "Tasks",
    icon: <ListTodo className="h-4 w-4" />,
    badge: "bg-violet-50 text-violet-600 ring-violet-200",
    blurb: "Work the team does. Lands as a to-do on the project.",
  },
  asset: {
    label: "Asset",
    plural: "Assets to collect",
    icon: <Package className="h-4 w-4" />,
    badge: "bg-sky-50 text-sky-600 ring-sky-200",
    blurb: "Things the client has to send. Shows on their portal.",
  },
  milestone: {
    label: "Milestone",
    plural: "Milestones",
    icon: <Flag className="h-4 w-4" />,
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
    blurb: "Phases the client can see progress against.",
  },
  launch_check: {
    label: "Launch check",
    plural: "Before delivery",
    icon: <ShieldCheck className="h-4 w-4" />,
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    blurb: "Internal gate. A project can't be delivered while any are open.",
  },
};

const KINDS = Object.keys(KIND_META) as TemplateItemKind[];

export function TemplatesView({
  templates,
  items,
}: {
  templates: ProjectTemplate[];
  items: ProjectTemplateItem[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = React.useState<string | null>(
    templates[0]?.id ?? null,
  );
  const [editingTemplate, setEditingTemplate] =
    React.useState<ProjectTemplate | null>(null);
  const [creatingTemplate, setCreatingTemplate] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<ProjectTemplate | null>(null);
  const [editingItem, setEditingItem] = React.useState<{
    item: ProjectTemplateItem | null;
    kind: TemplateItemKind;
  } | null>(null);

  const selected =
    templates.find((t) => t.id === selectedId) ?? templates[0] ?? null;
  const templateItems = items.filter((i) => i.template_id === selected?.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project templates"
        description="The plan behind a service type — seeded onto a project in one click."
        actions={
          <Button onClick={() => setCreatingTemplate(true)}>
            <Plus className="h-4 w-4" /> New template
          </Button>
        }
      />

      <ProjectsSectionNav />

      {templates.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-6 w-6" />}
          title="No templates yet"
          description="Build one here, or plan a project properly and save it as a template from its Plan tab — that's usually faster."
          action={
            <Button onClick={() => setCreatingTemplate(true)}>
              <Plus className="h-4 w-4" /> New template
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
          {/* Template list */}
          <div className="space-y-2">
            {templates.map((t) => {
              const count = items.filter((i) => i.template_id === t.id).length;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={cn(
                    "w-full rounded-xl border px-4 py-3 text-left transition",
                    selected?.id === t.id
                      ? "border-primary-300 bg-primary-50/60 shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-300",
                  )}
                >
                  <p className="text-sm font-semibold text-slate-900">{t.name}</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {count} item{count === 1 ? "" : "s"}
                    {t.service_type
                      ? ` · ${SERVICE_TYPE_LABELS[t.service_type] ?? t.service_type}`
                      : ""}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Selected template */}
          {selected && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">
                    {selected.name}
                  </h2>
                  {selected.description && (
                    <p className="mt-1 max-w-xl text-sm text-slate-500">
                      {selected.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
                    {selected.service_type && (
                      <Badge className="bg-primary-50 text-primary-700 ring-primary-200">
                        {SERVICE_TYPE_LABELS[selected.service_type] ??
                          selected.service_type}
                      </Badge>
                    )}
                    {selected.default_value ? (
                      <span>
                        Suggests{" "}
                        {formatCurrency(
                          Number(selected.default_value),
                          selected.default_currency,
                        )}
                      </span>
                    ) : null}
                    {selected.default_days ? (
                      <span>· {selected.default_days} days</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingTemplate(selected)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setToDelete(selected)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {KINDS.map((kind) => {
                const kindItems = templateItems.filter((i) => i.kind === kind);
                const meta = KIND_META[kind];
                return (
                  <section
                    key={kind}
                    className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="text-slate-400">{meta.icon}</span>
                        <div>
                          <h3 className="text-sm font-semibold text-slate-900">
                            {meta.plural}
                          </h3>
                          <p className="text-xs text-slate-400">{meta.blurb}</p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingItem({ item: null, kind })}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>

                    {kindItems.length === 0 ? (
                      <p className="px-5 py-5 text-center text-xs text-slate-400">
                        Nothing here yet.
                      </p>
                    ) : (
                      <ul className="divide-y divide-slate-100">
                        {kindItems.map((item) => (
                          <li
                            key={item.id}
                            className="group flex items-center gap-3 px-5 py-2.5"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-sm text-slate-800">
                                {item.title}
                                {!item.required && (
                                  <span className="ml-2 text-[10px] font-semibold uppercase text-slate-400">
                                    optional
                                  </span>
                                )}
                              </p>
                              {item.detail && (
                                <p className="mt-0.5 text-xs text-slate-500">
                                  {item.detail}
                                </p>
                              )}
                              <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-400">
                                {item.offset_days !== null && (
                                  <span>Day {item.offset_days}</span>
                                )}
                                {item.role && <span>· {item.role}</span>}
                                {item.category && <span>· {item.category}</span>}
                              </div>
                            </div>
                            <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
                              <button
                                type="button"
                                onClick={() => setEditingItem({ item, kind })}
                                className="text-slate-300 hover:text-primary-600"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  const res = await deleteTemplateItem(item.id);
                                  if (res.ok) router.refresh();
                                  else toast.error(res.error);
                                }}
                                className="text-slate-300 hover:text-rose-600"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      )}

      <TemplateModal
        open={creatingTemplate || !!editingTemplate}
        template={editingTemplate}
        onClose={() => {
          setCreatingTemplate(false);
          setEditingTemplate(null);
        }}
        onSaved={(id) => setSelectedId(id)}
      />

      {selected && editingItem && (
        <ItemModal
          open
          templateId={selected.id}
          kind={editingItem.kind}
          item={editingItem.item}
          nextPosition={
            templateItems.filter((i) => i.kind === editingItem.kind).length
          }
          onClose={() => setEditingItem(null)}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete template"
        description={`"${toDelete?.name}" and all of its items. Projects already seeded from it are untouched.`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteTemplate(toDelete.id);
          if (res.ok) {
            setSelectedId(null);
            toast.success("Template deleted");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </div>
  );
}

function TemplateModal({
  open,
  template,
  onClose,
  onSaved,
}: {
  open: boolean;
  template: ProjectTemplate | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    name: "",
    service_type: "",
    description: "",
    default_value: "",
    default_days: "",
  });

  React.useEffect(() => {
    if (!open) return;
    setForm({
      name: template?.name ?? "",
      service_type: template?.service_type ?? "",
      description: template?.description ?? "",
      default_value: template?.default_value?.toString() ?? "",
      default_days: template?.default_days?.toString() ?? "",
    });
  }, [open, template]);

  async function submit() {
    setSaving(true);
    const res = await saveTemplate({
      id: template?.id,
      name: form.name,
      service_type: form.service_type || null,
      description: form.description || null,
      default_value: form.default_value ? Number(form.default_value) : null,
      default_days: form.default_days ? Number(form.default_days) : null,
    });
    setSaving(false);
    if (res.ok) {
      if (res.id) onSaved(res.id);
      onClose();
      toast.success(template ? "Template updated" : "Template created");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={template ? "Edit template" : "New template"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Business website — standard build"
          />
        </Field>
        <Field
          label="Service type"
          hint="Offered automatically on projects of this type."
        >
          <Select
            value={form.service_type}
            onChange={(e) => setForm({ ...form, service_type: e.target.value })}
          >
            <option value="">Any</option>
            {Object.entries(SERVICE_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description">
          <Textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Typical value" hint="Pre-fills a new project.">
            <Input
              type="number"
              value={form.default_value}
              onChange={(e) =>
                setForm({ ...form, default_value: e.target.value })
              }
            />
          </Field>
          <Field label="Typical length (days)">
            <Input
              type="number"
              value={form.default_days}
              onChange={(e) => setForm({ ...form, default_days: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ItemModal({
  open,
  templateId,
  kind,
  item,
  nextPosition,
  onClose,
}: {
  open: boolean;
  templateId: string;
  kind: TemplateItemKind;
  item: ProjectTemplateItem | null;
  nextPosition: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    title: "",
    detail: "",
    offset_days: "",
    role: "",
    category: "",
    required: true,
    priority: "medium" as TodoPriority,
  });

  React.useEffect(() => {
    if (!open) return;
    setForm({
      title: item?.title ?? "",
      detail: item?.detail ?? "",
      offset_days: item?.offset_days?.toString() ?? "",
      role: item?.role ?? "",
      category: item?.category ?? "",
      required: item?.required ?? true,
      priority: item?.priority ?? "medium",
    });
  }, [open, item]);

  async function submit() {
    setSaving(true);
    const res = await saveTemplateItem({
      id: item?.id,
      template_id: templateId,
      kind,
      title: form.title,
      detail: form.detail || null,
      offset_days: form.offset_days ? Number(form.offset_days) : null,
      role: form.role || null,
      category: form.category || null,
      required: form.required,
      priority: form.priority,
      position: item?.position ?? nextPosition,
    });
    setSaving(false);
    if (res.ok) {
      onClose();
      toast.success("Saved");
      router.refresh();
    } else toast.error(res.error);
  }

  const meta = KIND_META[kind];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${item ? "Edit" : "Add"} ${meta.label.toLowerCase()}`}
      description={meta.blurb}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input
            autoFocus
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
        <Field label="Detail">
          <Textarea
            rows={2}
            value={form.detail}
            onChange={(e) => setForm({ ...form, detail: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Day"
            hint="Days after the project starts. Blank = no date."
          >
            <Input
              type="number"
              value={form.offset_days}
              onChange={(e) => setForm({ ...form, offset_days: e.target.value })}
            />
          </Field>
          {kind === "task" || kind === "milestone" ? (
            <Field label="Role" hint="Lands on whoever holds it.">
              <Input
                list="template-roles"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              />
              <datalist id="template-roles">
                {PROJECT_ROLES.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </Field>
          ) : (
            <Field label="Category" hint="brand · content · photos · access">
              <Input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              />
            </Field>
          )}
        </div>
        {kind === "task" && (
          <Field label="Priority">
            <Select
              value={form.priority}
              onChange={(e) =>
                setForm({ ...form, priority: e.target.value as TodoPriority })
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </Select>
          </Field>
        )}
        {kind === "asset" && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={form.required}
              onChange={(e) => setForm({ ...form, required: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-primary-600"
            />
            Required — the build can&apos;t start without it
          </label>
        )}
      </div>
    </Modal>
  );
}
