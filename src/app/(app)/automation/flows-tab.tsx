"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  Plus,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import {
  CONDITION_FIELDS,
  CONDITION_OPS,
  STEP_META,
  TRIGGER_META,
} from "@/lib/automation-meta";
import { cn } from "@/lib/utils";
import type {
  Automation,
  AutomationRun,
  AutomationStep,
  AutomationStepKind,
  AutomationTrigger,
  MemberLite,
  Pipeline,
  PipelineStage,
  SmsWorkflow,
} from "@/lib/types";

import {
  createAutomation,
  deleteAutomation,
  saveAutomationSteps,
  testAutomation,
  updateAutomation,
  type AutomationStepInput,
} from "./actions";

// ---- Local editing model ---------------------------------------------------

type DraftStep = {
  key: string;
  kind: AutomationStepKind;
  config: Record<string, unknown>;
};

type DraftCondition = { field: string; op: string; value: string };

const STEP_KINDS: AutomationStepKind[] = [
  "send_sms",
  "send_whatsapp",
  "send_email",
  "wait",
  "create_task",
  "add_tag",
  "remove_tag",
  "assign_user",
  "move_stage",
  "update_field",
  "update_score",
  "notify",
  "ai_agent",
  "enroll_sms_workflow",
  "webhook",
];

function newDraft(kind: AutomationStepKind): DraftStep {
  const config: Record<string, unknown> =
    kind === "wait"
      ? { minutes: 60 }
      : kind === "create_task"
        ? { title: "Follow up with {{full_name}}", due_in_days: 1 }
        : kind === "notify"
          ? { user_id: "all", title: "", body: "" }
          : kind === "ai_agent"
            ? { instruction: "", save_to: "ai_next_action" }
            : {};
  return { key: crypto.randomUUID(), kind, config };
}

// ---- Tab --------------------------------------------------------------------

export function FlowsTab({
  automations,
  steps,
  runs,
  smsWorkflows,
  pipelines,
  stages,
  members,
  smsReady,
}: {
  automations: Automation[];
  steps: AutomationStep[];
  runs: AutomationRun[];
  smsWorkflows: SmsWorkflow[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
  members: MemberLite[];
  smsReady: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const selected =
    automations.find((a) => a.id === selectedId) ?? automations[0] ?? null;

  async function handleCreate() {
    setCreating(true);
    const res = await createAutomation("Untitled automation");
    setCreating(false);
    if (res.ok) {
      setSelectedId(res.automation.id);
      toast.success("Automation created — pick a trigger and add actions.");
    } else toast.error(res.error);
  }

  if (automations.length === 0) {
    return (
      <EmptyState
        icon={<Workflow className="h-6 w-6" />}
        title="No automations yet"
        description="Build a flow like: lead created → send welcome SMS → wait 1 day → create a call task. Or install a ready-made recipe from the Recipes tab."
        action={
          <Button onClick={handleCreate} loading={creating}>
            <Plus className="h-4 w-4" />
            Create your first automation
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="space-y-2">
        <Button variant="outline" className="w-full" onClick={handleCreate} loading={creating}>
          <Plus className="h-4 w-4" />
          New automation
        </Button>
        {automations.map((a) => {
          const stepCount = steps.filter((s) => s.automation_id === a.id).length;
          const running = runs.filter(
            (r) => r.automation_id === a.id && r.status === "running",
          ).length;
          return (
            <button
              key={a.id}
              onClick={() => setSelectedId(a.id)}
              className={cn(
                "w-full rounded-2xl border bg-white p-4 text-left shadow-[var(--shadow-card)] transition-colors",
                selected?.id === a.id
                  ? "border-primary-400 ring-2 ring-primary-100"
                  : "border-slate-200/80 hover:border-slate-300",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    a.is_active ? "bg-emerald-500" : "bg-slate-300",
                  )}
                  aria-hidden
                />
                <span className="truncate text-sm font-semibold text-slate-900">
                  {a.name}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {TRIGGER_META[a.trigger]?.label ?? a.trigger} · {stepCount} action
                {stepCount === 1 ? "" : "s"}
                {running > 0 && ` · ${running} running`}
              </p>
            </button>
          );
        })}
      </div>

      {selected && (
        <AutomationBuilder
          key={selected.id}
          automation={selected}
          savedSteps={steps.filter((s) => s.automation_id === selected.id)}
          smsWorkflows={smsWorkflows}
          pipelines={pipelines}
          stages={stages}
          members={members}
          smsReady={smsReady}
        />
      )}
    </div>
  );
}

// ---- Builder ------------------------------------------------------------------

function AutomationBuilder({
  automation,
  savedSteps,
  smsWorkflows,
  pipelines,
  stages,
  members,
  smsReady,
}: {
  automation: Automation;
  savedSteps: AutomationStep[];
  smsWorkflows: SmsWorkflow[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
  members: MemberLite[];
  smsReady: boolean;
}) {
  const [name, setName] = React.useState(automation.name);
  const [drafts, setDrafts] = React.useState<DraftStep[]>(
    savedSteps.map((s) => ({
      key: s.id,
      kind: s.kind,
      config: (s.config ?? {}) as Record<string, unknown>,
    })),
  );
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [testOpen, setTestOpen] = React.useState(false);

  const conditions = (automation.conditions ?? []) as unknown as DraftCondition[];

  function mutate(updater: (prev: DraftStep[]) => DraftStep[]) {
    setDrafts(updater);
    setDirty(true);
  }
  const insertAt = (index: number, kind: AutomationStepKind) =>
    mutate((prev) => [...prev.slice(0, index), newDraft(kind), ...prev.slice(index)]);
  const removeAt = (index: number) => mutate((prev) => prev.filter((_, i) => i !== index));
  const moveStep = (index: number, delta: -1 | 1) =>
    mutate((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const updateConfig = (index: number, patch: Record<string, unknown>) =>
    mutate((prev) =>
      prev.map((s, i) => (i === index ? { ...s, config: { ...s.config, ...patch } } : s)),
    );

  async function handleSave() {
    setSaving(true);
    const inputs: AutomationStepInput[] = drafts.map((d) => ({
      kind: d.kind,
      config: d.config,
    }));
    const res = await saveAutomationSteps(automation.id, inputs);
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      toast.success("Automation saved.");
    } else toast.error(res.error);
  }

  async function handleRename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === automation.name) {
      setName(automation.name);
      return;
    }
    const res = await updateAutomation(automation.id, { name: trimmed });
    if (!res.ok) toast.error(res.error);
  }

  async function handleToggleActive() {
    const res = await updateAutomation(automation.id, {
      is_active: !automation.is_active,
    });
    if (!res.ok) toast.error(res.error);
    else if (automation.is_active)
      toast.info("Automation paused — running enrollments are frozen.");
    else toast.success("Automation is live.");
  }

  async function handleDelete() {
    const res = await deleteAutomation(automation.id);
    if (res.ok) toast.success("Automation deleted.");
    else toast.error(res.error);
  }

  async function saveTriggerConfig(patch: Record<string, unknown>) {
    const res = await updateAutomation(automation.id, {
      trigger_config: {
        ...((automation.trigger_config ?? {}) as Record<string, unknown>),
        ...patch,
      },
    });
    if (!res.ok) toast.error(res.error);
  }

  async function saveConditions(next: DraftCondition[]) {
    const res = await updateAutomation(automation.id, {
      conditions: next as unknown as Record<string, unknown>[],
    });
    if (!res.ok) toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-base font-semibold text-slate-900 outline-none transition-colors hover:bg-slate-50 focus:bg-slate-50"
          aria-label="Automation name"
        />
        <button
          onClick={handleToggleActive}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            automation.is_active ? "bg-emerald-500" : "bg-slate-300",
          )}
          role="switch"
          aria-checked={automation.is_active}
          aria-label="Automation active"
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
              automation.is_active ? "translate-x-5.5" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="text-xs font-medium text-slate-500">
          {automation.is_active ? "Live" : "Paused"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTestOpen(true)}
            disabled={savedSteps.length === 0}
            title={savedSteps.length === 0 ? "Save some actions first" : undefined}
          >
            <FlaskConical className="h-4 w-4" />
            Test
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>
            {dirty ? "Save changes" : "Saved"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete automation"
            className="text-slate-400 hover:text-rose-500"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Canvas */}
      <div className="rounded-2xl border border-slate-200/80 bg-[radial-gradient(circle,#e2e8f0_1px,transparent_1px)] [background-size:18px_18px] p-6 sm:p-10">
        <div className="mx-auto flex max-w-xl flex-col items-stretch">
          <TriggerNode
            automation={automation}
            pipelines={pipelines}
            stages={stages}
            onTriggerChange={async (trigger) => {
              const res = await updateAutomation(automation.id, {
                trigger,
                trigger_config: {},
              });
              if (!res.ok) toast.error(res.error);
            }}
            onConfigChange={saveTriggerConfig}
          />

          <ConditionsNode
            conditions={conditions}
            members={members}
            onChange={saveConditions}
          />

          <Connector onAdd={(kind) => insertAt(0, kind)} smsReady={smsReady} />

          {drafts.map((draft, index) => (
            <React.Fragment key={draft.key}>
              <StepNode
                draft={draft}
                index={index}
                total={drafts.length}
                smsWorkflows={smsWorkflows}
                pipelines={pipelines}
                stages={stages}
                members={members}
                onChange={(patch) => updateConfig(index, patch)}
                onMove={(delta) => moveStep(index, delta)}
                onRemove={() => removeAt(index)}
              />
              <Connector onAdd={(kind) => insertAt(index + 1, kind)} smsReady={smsReady} />
            </React.Fragment>
          ))}

          <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-3 text-center text-xs font-medium text-slate-400">
            Flow ends — {drafts.length} action{drafts.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <TestModal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        automation={automation}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete this automation?"
        description="Its actions and run history are removed too. Messages already sent stay logged."
      />
    </div>
  );
}

// ---- Trigger node ---------------------------------------------------------------

function TriggerNode({
  automation,
  pipelines,
  stages,
  onTriggerChange,
  onConfigChange,
}: {
  automation: Automation;
  pipelines: Pipeline[];
  stages: PipelineStage[];
  onTriggerChange: (trigger: AutomationTrigger) => void;
  onConfigChange: (patch: Record<string, unknown>) => void;
}) {
  const cfg = (automation.trigger_config ?? {}) as Record<string, unknown>;
  const trigger = automation.trigger;
  const meta = TRIGGER_META[trigger];
  const pipelineStages = stages.filter((s) => s.pipeline_id === (cfg.pipeline_id ?? ""));

  const showsPipeline = [
    "lead_created",
    "form_submitted",
    "stage_changed",
    "lead_inactive",
    "date_reached",
  ].includes(trigger);

  return (
    <div className="rounded-2xl border border-primary-200 bg-primary-50/80 p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-600 text-white">
          <Zap className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">Trigger</p>
          <p className="truncate text-xs text-slate-500">{meta?.description}</p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Select
          value={trigger}
          onChange={(e) => onTriggerChange(e.target.value as AutomationTrigger)}
        >
          {(Object.keys(TRIGGER_META) as AutomationTrigger[]).map((t) => (
            <option key={t} value={t}>
              {TRIGGER_META[t].label}
            </option>
          ))}
        </Select>

        {showsPipeline && (
          <Select
            value={String(cfg.pipeline_id ?? "")}
            onChange={(e) => onConfigChange({ pipeline_id: e.target.value || undefined })}
          >
            <option value="">Any pipeline</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}

        {trigger === "stage_changed" && (
          <Select
            value={String(cfg.stage_id ?? "")}
            onChange={(e) => onConfigChange({ stage_id: e.target.value || undefined })}
          >
            <option value="">Moved to any stage</option>
            {(cfg.pipeline_id ? pipelineStages : stages).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}

        {trigger === "tag_added" && (
          <Input
            defaultValue={String(cfg.tag ?? "")}
            onBlur={(e) => onConfigChange({ tag: e.target.value.trim() })}
            placeholder="Tag, e.g. hot-lead"
          />
        )}

        {trigger === "wa_message_received" && (
          <Input
            defaultValue={String(cfg.keyword ?? "")}
            onBlur={(e) => onConfigChange({ keyword: e.target.value.trim() || undefined })}
            placeholder="Keyword filter (blank = every message)"
          />
        )}

        {(trigger === "lead_inactive" || trigger === "invoice_unpaid") && (
          <NumberConfig
            label={trigger === "lead_inactive" ? "days of inactivity" : "days after sending"}
            value={Number(cfg.days ?? (trigger === "lead_inactive" ? 7 : 3))}
            onChange={(days) => onConfigChange({ days })}
          />
        )}

        {(trigger === "date_reached" ||
          trigger === "installment_due" ||
          trigger === "cheque_due") && (
          <NumberConfig
            label="days before the date"
            value={Number(cfg.days_before ?? 2)}
            onChange={(days_before) => onConfigChange({ days_before })}
          />
        )}
      </div>
    </div>
  );
}

function NumberConfig({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={0}
        defaultValue={value}
        onBlur={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="w-24"
      />
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );
}

// ---- Conditions node --------------------------------------------------------------

function ConditionsNode({
  conditions,
  members,
  onChange,
}: {
  conditions: DraftCondition[];
  members: MemberLite[];
  onChange: (next: DraftCondition[]) => void;
}) {
  const [local, setLocal] = React.useState<DraftCondition[]>(conditions);
  const [dirty, setDirty] = React.useState(false);

  function mutate(next: DraftCondition[]) {
    setLocal(next);
    setDirty(true);
  }

  return (
    <>
      <div className="mx-auto flex flex-col items-center py-1">
        <div className="h-4 w-px bg-slate-300" />
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">
            Conditions{" "}
            <span className="font-normal text-slate-400">
              {local.length === 0 ? "— always run" : "— all must match"}
            </span>
          </p>
          <div className="flex items-center gap-2">
            {dirty && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onChange(local.filter((c) => c.field && c.op));
                  setDirty(false);
                }}
              >
                Apply
              </Button>
            )}
            <button
              onClick={() => mutate([...local, { field: "source", op: "eq", value: "" }])}
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              aria-label="Add condition"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
        {local.length > 0 && (
          <div className="mt-3 space-y-2">
            {local.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select
                  value={c.field}
                  onChange={(e) =>
                    mutate(local.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))
                  }
                  className="w-36"
                >
                  {CONDITION_FIELDS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
                <Select
                  value={c.op}
                  onChange={(e) =>
                    mutate(local.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))
                  }
                  className="w-36"
                >
                  {CONDITION_OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {!["is_set", "not_set"].includes(c.op) &&
                  (c.field === "assigned_to" ? (
                    <Select
                      value={c.value}
                      onChange={(e) =>
                        mutate(local.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                      }
                      className="w-40"
                    >
                      <option value="">Pick member…</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.full_name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      value={c.value}
                      onChange={(e) =>
                        mutate(local.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                      }
                      placeholder="Value"
                      className="w-40"
                    />
                  ))}
                <button
                  onClick={() => mutate(local.filter((_, j) => j !== i))}
                  className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Remove condition"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---- Step canvas pieces ------------------------------------------------------------

function Connector({
  onAdd,
  smsReady,
}: {
  onAdd: (kind: AutomationStepKind) => void;
  smsReady: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative mx-auto flex flex-col items-center py-1">
      <div className="h-4 w-px bg-slate-300" />
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-full border bg-white text-slate-400 shadow-sm transition-all hover:border-primary-300 hover:text-primary-600",
            open ? "border-primary-300 text-primary-600" : "border-slate-200",
          )}
          aria-label="Add action"
        >
          <Plus className="h-4 w-4" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute left-1/2 z-20 mt-2 max-h-80 w-60 -translate-x-1/2 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
              {STEP_KINDS.map((kind) => (
                <button
                  key={kind}
                  onClick={() => {
                    onAdd(kind);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <span
                    className={cn("h-2.5 w-2.5 shrink-0 rounded-full", STEP_META[kind].tone)}
                    aria-hidden
                  />
                  <span className="flex-1 text-left">{STEP_META[kind].label}</span>
                  {kind === "send_sms" && !smsReady && (
                    <span className="text-[10px] text-amber-500">no key</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="h-4 w-px bg-slate-300" />
    </div>
  );
}

const TOKENS = ["{{name}}", "{{full_name}}", "{{title}}", "{{value}}", "{{company}}"];

function StepNode({
  draft,
  index,
  total,
  smsWorkflows,
  pipelines,
  stages,
  members,
  onChange,
  onMove,
  onRemove,
}: {
  draft: DraftStep;
  index: number;
  total: number;
  smsWorkflows: SmsWorkflow[];
  pipelines: Pipeline[];
  stages: PipelineStage[];
  members: MemberLite[];
  onChange: (patch: Record<string, unknown>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const meta = STEP_META[draft.kind];
  const cfg = draft.config;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold text-white",
            meta.tone,
          )}
        >
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{meta.label}</p>
          <p className="text-xs text-slate-400">{meta.description}</p>
        </div>
        <div className="flex items-center gap-0.5">
          <IconBtn onClick={() => onMove(-1)} disabled={index === 0} label="Move up">
            <ArrowUp className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn onClick={() => onMove(1)} disabled={index === total - 1} label="Move down">
            <ArrowDown className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn onClick={onRemove} label="Remove" danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {draft.kind === "send_sms" && (
          <>
            <Textarea
              value={String(cfg.message ?? "")}
              onChange={(e) => onChange({ message: e.target.value })}
              rows={3}
              placeholder={"Hi {{name}}, welcome to ARC AI! ..."}
            />
            <TokenRow onInsert={(t) => onChange({ message: `${String(cfg.message ?? "")}${t}` })} />
          </>
        )}

        {draft.kind === "send_whatsapp" && (
          <>
            <Textarea
              value={String(cfg.message ?? "")}
              onChange={(e) => onChange({ message: e.target.value })}
              rows={3}
              placeholder={"Hi {{name}}, thanks for chatting with ARC AI! ..."}
            />
            <TokenRow onInsert={(t) => onChange({ message: `${String(cfg.message ?? "")}${t}` })} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={String(cfg.template_name ?? "")}
                onChange={(e) => onChange({ template_name: e.target.value.trim() || undefined })}
                placeholder="Template name (for contacts silent >24h)"
              />
              <Input
                value={String(cfg.template_lang ?? "")}
                onChange={(e) => onChange({ template_lang: e.target.value.trim() || undefined })}
                placeholder="Template language, e.g. en"
              />
            </div>
            {Boolean(cfg.template_name) && (
              <Input
                value={
                  Array.isArray(cfg.template_params)
                    ? (cfg.template_params as string[]).join(", ")
                    : ""
                }
                onChange={(e) =>
                  onChange({
                    template_params: e.target.value
                      .split(",")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={"Template variables in order, comma-separated — e.g. {{name}}, {{audit_score}}"}
              />
            )}
            <p className="text-[11px] leading-4 text-slate-400">
              WhatsApp only delivers free text within 24h of the contact&apos;s last
              message. Set an approved template name to reach colder contacts —
              when set, the template is sent instead of the message above, and the
              variables fill its {"{{1}}, {{2}}"}… placeholders in order.
            </p>
          </>
        )}

        {draft.kind === "send_email" && (
          <>
            <Input
              value={String(cfg.subject ?? "")}
              onChange={(e) => onChange({ subject: e.target.value })}
              placeholder="Subject"
            />
            <Textarea
              value={String(cfg.body ?? "")}
              onChange={(e) => onChange({ body: e.target.value })}
              rows={4}
              placeholder={"Hi {{name}},\n..."}
            />
            <TokenRow onInsert={(t) => onChange({ body: `${String(cfg.body ?? "")}${t}` })} />
          </>
        )}

        {draft.kind === "wait" && (
          <WaitConfig
            minutes={Number(cfg.minutes ?? 60)}
            onChange={(minutes) => onChange({ minutes })}
          />
        )}

        {draft.kind === "create_task" && (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <Input
              value={String(cfg.title ?? "")}
              onChange={(e) => onChange({ title: e.target.value })}
              placeholder="Task title, e.g. Call {{full_name}}"
            />
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                value={Number(cfg.due_in_days ?? 1)}
                onChange={(e) => onChange({ due_in_days: Math.max(0, Number(e.target.value) || 0) })}
                className="w-20"
              />
              <span className="text-xs text-slate-500">days until due</span>
            </div>
            <Select
              value={String(cfg.assigned_to ?? "")}
              onChange={(e) => onChange({ assigned_to: e.target.value || undefined })}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name}
                </option>
              ))}
            </Select>
          </div>
        )}

        {(draft.kind === "add_tag" || draft.kind === "remove_tag") && (
          <Input
            value={String(cfg.tag ?? "")}
            onChange={(e) => onChange({ tag: e.target.value })}
            placeholder="Tag, e.g. keep-warm"
            className="max-w-xs"
          />
        )}

        {draft.kind === "assign_user" && (
          <Select
            value={String(cfg.user_id ?? "")}
            onChange={(e) => onChange({ user_id: e.target.value })}
            className="max-w-xs"
          >
            <option value="">Pick teammate…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
          </Select>
        )}

        {draft.kind === "move_stage" && (
          <Select
            value={String(cfg.stage_id ?? "")}
            onChange={(e) => onChange({ stage_id: e.target.value })}
            className="max-w-sm"
          >
            <option value="">Pick stage…</option>
            {pipelines.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {stages
                  .filter((s) => s.pipeline_id === p.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
        )}

        {draft.kind === "update_field" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={String(cfg.field ?? "")}
              onChange={(e) => onChange({ field: e.target.value })}
              placeholder="Field: notes, source, value, custom.vehicle_no…"
            />
            <Input
              value={String(cfg.value ?? "")}
              onChange={(e) => onChange({ value: e.target.value })}
              placeholder="New value"
            />
          </div>
        )}

        {draft.kind === "update_score" && (
          <Select
            value={String(cfg.score ?? "warm")}
            onChange={(e) => onChange({ score: e.target.value })}
            className="max-w-40"
          >
            <option value="hot">🔥 Hot</option>
            <option value="warm">🌤 Warm</option>
            <option value="cold">🧊 Cold</option>
          </Select>
        )}

        {draft.kind === "notify" && (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                value={String(cfg.user_id ?? "all")}
                onChange={(e) => onChange({ user_id: e.target.value })}
              >
                <option value="all">Everyone</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                  </option>
                ))}
              </Select>
              <Input
                value={String(cfg.title ?? "")}
                onChange={(e) => onChange({ title: e.target.value })}
                placeholder="Notification title"
              />
            </div>
            <Input
              value={String(cfg.body ?? "")}
              onChange={(e) => onChange({ body: e.target.value })}
              placeholder="Body, e.g. {{title}} needs attention"
            />
          </div>
        )}

        {draft.kind === "webhook" && (
          <Input
            value={String(cfg.url ?? "")}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://hooks.zapier.com/…"
          />
        )}

        {draft.kind === "ai_agent" && (
          <div className="space-y-2">
            <Textarea
              value={String(cfg.instruction ?? "")}
              onChange={(e) => onChange({ instruction: e.target.value })}
              rows={2}
              placeholder="e.g. Summarize this lead's history and suggest the next action."
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Save result to</span>
              <Select
                value={String(cfg.save_to ?? "note")}
                onChange={(e) => onChange({ save_to: e.target.value })}
                className="w-44"
              >
                <option value="ai_summary">Lead AI summary</option>
                <option value="ai_next_action">Lead next action</option>
                <option value="note">Timeline note</option>
              </Select>
            </div>
          </div>
        )}

        {draft.kind === "enroll_sms_workflow" && (
          <Select
            value={String(cfg.workflow_id ?? "")}
            onChange={(e) => onChange({ workflow_id: e.target.value })}
            className="max-w-sm"
          >
            <option value="">Pick SMS workflow…</option>
            {smsWorkflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.is_active ? "" : " (paused)"}
              </option>
            ))}
          </Select>
        )}
      </div>
    </div>
  );
}

function WaitConfig({
  minutes,
  onChange,
}: {
  minutes: number;
  onChange: (minutes: number) => void;
}) {
  const unit = minutes % 1440 === 0 && minutes > 0 ? 1440 : minutes % 60 === 0 && minutes > 0 ? 60 : 1;
  const value = Math.max(1, Math.round(minutes / unit));
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1) * unit)}
        className="w-24"
      />
      <Select
        value={String(unit)}
        onChange={(e) => onChange(value * Number(e.target.value))}
        className="w-32"
      >
        <option value="1">minutes</option>
        <option value="60">hours</option>
        <option value="1440">days</option>
      </Select>
      <span className="text-xs text-slate-400">then continue</span>
    </div>
  );
}

function TokenRow({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {TOKENS.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onInsert(t)}
          className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 transition-colors hover:bg-slate-200"
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function IconBtn({
  onClick,
  disabled,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors disabled:opacity-30",
        danger ? "hover:bg-rose-50 hover:text-rose-500" : "hover:bg-slate-100 hover:text-slate-700",
      )}
    >
      {children}
    </button>
  );
}

// ---- Test modal ------------------------------------------------------------------

function TestModal({
  open,
  onClose,
  automation,
}: {
  open: boolean;
  onClose: () => void;
  automation: Automation;
}) {
  const [name, setName] = React.useState("Test contact");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleTest() {
    setSubmitting(true);
    const res = await testAutomation(automation.id, {
      name,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      toast.success("Test run started — check the Runs tab.");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Test "${automation.name}"`}
      description="Runs the saved actions right now against a test contact. Real SMS/emails are sent — use your own number."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleTest} loading={submitting}>
            <FlaskConical className="h-4 w-4" />
            Run test
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Phone" hint="Needed for SMS steps, e.g. 0712345678">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </Field>
        <Field label="Email" hint="Needed for email steps.">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </Field>
      </div>
    </Modal>
  );
}
