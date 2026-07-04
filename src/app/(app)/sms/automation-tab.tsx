"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  MessageSquareText,
  Play,
  Plus,
  Timer,
  Trash2,
  UserPlus,
  Workflow,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type {
  Client,
  SmsRunStatus,
  SmsWorkflow,
  SmsWorkflowRun,
  SmsWorkflowStep,
} from "@/lib/types";

import {
  cancelSmsRun,
  createSmsWorkflow,
  deleteSmsRun,
  deleteSmsWorkflow,
  enrollInSmsWorkflow,
  renameSmsWorkflow,
  saveSmsWorkflowSteps,
  setSmsWorkflowActive,
  type WorkflowStepInput,
} from "./actions";
import { MessageMeta } from "./history-tab";

// ---- Local editing model ---------------------------------------------------

type WaitUnit = "minutes" | "hours" | "days";

type DraftStep = {
  key: string;
  kind: "send_sms" | "wait";
  message: string;
  waitValue: number;
  waitUnit: WaitUnit;
};

const UNIT_MINUTES: Record<WaitUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

function toDraft(step: SmsWorkflowStep): DraftStep {
  let waitValue = step.wait_minutes;
  let waitUnit: WaitUnit = "minutes";
  if (waitValue > 0 && waitValue % 1440 === 0) {
    waitValue /= 1440;
    waitUnit = "days";
  } else if (waitValue > 0 && waitValue % 60 === 0) {
    waitValue /= 60;
    waitUnit = "hours";
  }
  return {
    key: step.id,
    kind: step.kind,
    message: step.message,
    waitValue: waitValue || 1,
    waitUnit,
  };
}

function toInput(draft: DraftStep): WorkflowStepInput {
  return {
    kind: draft.kind,
    message: draft.message,
    wait_minutes:
      draft.kind === "wait"
        ? Math.max(1, Math.round(draft.waitValue * UNIT_MINUTES[draft.waitUnit]))
        : 0,
  };
}

function newDraft(kind: DraftStep["kind"]): DraftStep {
  return {
    key: crypto.randomUUID(),
    kind,
    message: "",
    waitValue: kind === "wait" ? 1 : 1,
    waitUnit: "hours",
  };
}

function humanizeMinutes(total: number): string {
  if (total <= 0) return "no delay";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(" ");
}

// ---- Tab --------------------------------------------------------------------

export function AutomationTab({
  clients,
  workflows,
  steps,
  runs,
  smsReady,
}: {
  clients: Client[];
  workflows: SmsWorkflow[];
  steps: SmsWorkflowStep[];
  runs: SmsWorkflowRun[];
  smsReady: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  // Fall back to the first workflow when nothing is selected or the
  // selection was deleted (possibly by a teammate, via realtime).
  const selected =
    workflows.find((w) => w.id === selectedId) ?? workflows[0] ?? null;

  async function handleCreate() {
    setCreating(true);
    const res = await createSmsWorkflow("Untitled workflow");
    setCreating(false);
    if (res.ok) {
      setSelectedId(res.workflow.id);
      toast.success("Workflow created — add your steps.");
    } else {
      toast.error(res.error);
    }
  }

  if (workflows.length === 0) {
    return (
      <EmptyState
        icon={<Workflow className="h-6 w-6" />}
        title="No workflows yet"
        description="Build a flow like: send a welcome SMS → wait 2 days → send a follow-up. Then enroll any client into it."
        action={
          <Button onClick={handleCreate} loading={creating}>
            <Plus className="h-4 w-4" />
            Create your first workflow
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2">
        <Button
          variant="outline"
          className="w-full"
          onClick={handleCreate}
          loading={creating}
        >
          <Plus className="h-4 w-4" />
          New workflow
        </Button>
        {workflows.map((w) => {
          const stepCount = steps.filter((s) => s.workflow_id === w.id).length;
          const running = runs.filter(
            (r) => r.workflow_id === w.id && r.status === "running",
          ).length;
          return (
            <button
              key={w.id}
              onClick={() => setSelectedId(w.id)}
              className={cn(
                "w-full rounded-2xl border bg-white p-4 text-left shadow-[var(--shadow-card)] transition-colors",
                selected?.id === w.id
                  ? "border-primary-400 ring-2 ring-primary-100"
                  : "border-slate-200/80 hover:border-slate-300",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    w.is_active ? "bg-emerald-500" : "bg-slate-300",
                  )}
                  aria-hidden
                />
                <span className="truncate text-sm font-semibold text-slate-900">
                  {w.name}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {stepCount} step{stepCount === 1 ? "" : "s"}
                {running > 0 && ` · ${running} running`}
              </p>
            </button>
          );
        })}
      </div>

      {selected && (
        <WorkflowBuilder
          key={selected.id}
          workflow={selected}
          savedSteps={steps.filter((s) => s.workflow_id === selected.id)}
          runs={runs.filter((r) => r.workflow_id === selected.id)}
          clients={clients}
          smsReady={smsReady}
        />
      )}
    </div>
  );
}

// ---- Builder ------------------------------------------------------------------

function WorkflowBuilder({
  workflow,
  savedSteps,
  runs,
  clients,
  smsReady,
}: {
  workflow: SmsWorkflow;
  savedSteps: SmsWorkflowStep[];
  runs: SmsWorkflowRun[];
  clients: Client[];
  smsReady: boolean;
}) {
  const [name, setName] = React.useState(workflow.name);
  const [drafts, setDrafts] = React.useState<DraftStep[]>(savedSteps.map(toDraft));
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [enrollOpen, setEnrollOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Realtime refreshes replace savedSteps — adopt them unless mid-edit.
  const savedKey = JSON.stringify(
    savedSteps.map((s) => [s.id, s.kind, s.message, s.wait_minutes]),
  );
  const lastAdoptedKey = React.useRef(savedKey);
  React.useEffect(() => {
    if (savedKey === lastAdoptedKey.current) return;
    lastAdoptedKey.current = savedKey;
    setDrafts((prev) => (dirty ? prev : savedSteps.map(toDraft)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  function mutate(updater: (prev: DraftStep[]) => DraftStep[]) {
    setDrafts(updater);
    setDirty(true);
  }

  const insertAt = (index: number, kind: DraftStep["kind"]) =>
    mutate((prev) => [...prev.slice(0, index), newDraft(kind), ...prev.slice(index)]);

  const removeAt = (index: number) =>
    mutate((prev) => prev.filter((_, i) => i !== index));

  const moveStep = (index: number, delta: -1 | 1) =>
    mutate((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const updateStep = (index: number, patch: Partial<DraftStep>) =>
    mutate((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  async function handleSave() {
    setSaving(true);
    const res = await saveSmsWorkflowSteps(workflow.id, drafts.map(toInput));
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      setDrafts(res.steps.map(toDraft));
      toast.success("Workflow saved.");
    } else {
      toast.error(res.error);
    }
  }

  async function handleRename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === workflow.name) {
      setName(workflow.name);
      return;
    }
    const res = await renameSmsWorkflow(workflow.id, trimmed);
    if (!res.ok) toast.error(res.error);
  }

  async function handleToggleActive() {
    const res = await setSmsWorkflowActive(workflow.id, !workflow.is_active);
    if (!res.ok) toast.error(res.error);
    else if (workflow.is_active)
      toast.info("Workflow paused — running enrollments are frozen.");
  }

  async function handleDelete() {
    const res = await deleteSmsWorkflow(workflow.id);
    if (res.ok) toast.success("Workflow deleted.");
    else toast.error(res.error);
  }

  const totalDelay = drafts
    .filter((d) => d.kind === "wait")
    .reduce((sum, d) => sum + d.waitValue * UNIT_MINUTES[d.waitUnit], 0);
  const smsCount = drafts.filter((d) => d.kind === "send_sms").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-base font-semibold text-slate-900 outline-none transition-colors hover:bg-slate-50 focus:bg-slate-50"
          aria-label="Workflow name"
        />
        <button
          onClick={handleToggleActive}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            workflow.is_active ? "bg-emerald-500" : "bg-slate-300",
          )}
          role="switch"
          aria-checked={workflow.is_active}
          aria-label="Workflow active"
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
              workflow.is_active ? "translate-x-5.5" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="text-xs font-medium text-slate-500">
          {workflow.is_active ? "Active" : "Paused"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEnrollOpen(true)}
            disabled={!smsReady || !workflow.is_active || savedSteps.length === 0}
            title={
              savedSteps.length === 0
                ? "Add and save steps first"
                : !workflow.is_active
                  ? "Activate the workflow first"
                  : undefined
            }
          >
            <UserPlus className="h-4 w-4" />
            Enroll client
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>
            {dirty ? "Save changes" : "Saved"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete workflow"
            className="text-slate-400 hover:text-rose-500"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Canvas */}
      <div className="rounded-2xl border border-slate-200/80 bg-[radial-gradient(circle,#e2e8f0_1px,transparent_1px)] [background-size:18px_18px] p-6 sm:p-10">
        <div className="mx-auto flex max-w-xl flex-col items-stretch">
          {/* Trigger node */}
          <div className="rounded-2xl border border-primary-200 bg-primary-50/80 p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-600 text-white">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">Trigger — Manual enrollment</p>
                <p className="text-xs text-slate-500">
                  Starts when you enroll a client into this workflow.
                </p>
              </div>
            </div>
          </div>

          <Connector onAdd={(kind) => insertAt(0, kind)} />

          {drafts.map((draft, index) => (
            <React.Fragment key={draft.key}>
              <StepNode
                draft={draft}
                index={index}
                total={drafts.length}
                onChange={(patch) => updateStep(index, patch)}
                onMove={(delta) => moveStep(index, delta)}
                onRemove={() => removeAt(index)}
              />
              <Connector onAdd={(kind) => insertAt(index + 1, kind)} />
            </React.Fragment>
          ))}

          {/* End node */}
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-3 text-center text-xs font-medium text-slate-400">
            Flow ends — {smsCount} SMS · total delay {humanizeMinutes(totalDelay)}
          </div>
        </div>
      </div>

      <RunsList runs={runs} savedStepCount={savedSteps.length} />

      <EnrollModal
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        workflow={workflow}
        clients={clients}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete this workflow?"
        description="Its steps and enrollments are removed too. Messages already sent stay in History."
      />
    </div>
  );
}

// ---- Canvas pieces --------------------------------------------------------------

function Connector({ onAdd }: { onAdd: (kind: DraftStep["kind"]) => void }) {
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
          aria-label="Add step"
        >
          <Plus className="h-4 w-4" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute left-1/2 z-20 mt-2 w-48 -translate-x-1/2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
              <button
                onClick={() => {
                  onAdd("send_sms");
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <MessageSquareText className="h-4 w-4 text-primary-500" />
                Send SMS
              </button>
              <button
                onClick={() => {
                  onAdd("wait");
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Timer className="h-4 w-4 text-amber-500" />
                Wait (timer)
              </button>
            </div>
          </>
        )}
      </div>
      <div className="h-4 w-px bg-slate-300" />
    </div>
  );
}

function StepNode({
  draft,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  draft: DraftStep;
  index: number;
  total: number;
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const isSms = draft.kind === "send_sms";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white",
            isSms ? "bg-primary-500" : "bg-amber-500",
          )}
        >
          {isSms ? <MessageSquareText className="h-5 w-5" /> : <Timer className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {index + 1}. {isSms ? "Send SMS" : "Wait"}
          </p>
          <p className="text-xs text-slate-400">
            {isSms ? "Message goes to the enrolled contact." : "Pause before the next step."}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton onClick={() => onMove(-1)} disabled={index === 0} label="Move up">
            <ArrowUp className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            label="Move down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={onRemove} label="Remove step" danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {isSms ? (
        <div className="mt-3 space-y-2">
          <Textarea
            value={draft.message}
            onChange={(e) => onChange({ message: e.target.value })}
            rows={3}
            placeholder={"Hi {{name}}, ..."}
          />
          <div className="flex items-center justify-between">
            <MessageMeta message={draft.message} />
            <TokenInsert onInsert={(t) => onChange({ message: `${draft.message}${t}` })} />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={draft.waitValue}
            onChange={(e) =>
              onChange({ waitValue: Math.max(1, Number(e.target.value) || 1) })
            }
            className="w-24"
          />
          <Select
            value={draft.waitUnit}
            onChange={(e) => onChange({ waitUnit: e.target.value as WaitUnit })}
            className="w-32"
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </Select>
          <span className="text-xs text-slate-400">
            then continue to the next step
          </span>
        </div>
      )}
    </div>
  );
}

function TokenInsert({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div className="flex gap-1.5">
      {["{{name}}", "{{full_name}}"].map((t) => (
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

function IconButton({
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

// ---- Enroll modal ----------------------------------------------------------------

function EnrollModal({
  open,
  onClose,
  workflow,
  clients,
}: {
  open: boolean;
  onClose: () => void;
  workflow: SmsWorkflow;
  clients: Client[];
}) {
  const [clientId, setClientId] = React.useState("");
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  function pickClient(id: string) {
    setClientId(id);
    const client = clients.find((c) => c.id === id);
    if (client) {
      setName(client.name);
      if (client.phone) setPhone(client.phone);
    }
  }

  async function handleEnroll() {
    setSubmitting(true);
    const res = await enrollInSmsWorkflow({
      workflowId: workflow.id,
      clientId: clientId || null,
      clientName: name,
      phone,
    });
    setSubmitting(false);
    if (res.ok) {
      toast.success(`Enrolled${name ? ` ${name}` : ""} — first steps fired.`);
      setClientId("");
      setName("");
      setPhone("");
      onClose();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Enroll into "${workflow.name}"`}
      description="The flow starts immediately: SMS steps send right away until the first wait timer."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleEnroll}
            loading={submitting}
            disabled={!phone.trim()}
          >
            <Play className="h-4 w-4" />
            Start flow
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Client" hint="Optional — fills the name and phone.">
          <Select value={clientId} onChange={(e) => pickClient(e.target.value)}>
            <option value="">Manual contact</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company ? ` — ${c.company}` : ""}
                {c.phone ? "" : " (no phone saved)"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" hint="Used for {{name}} in messages.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Client name" />
        </Field>
        <Field label="Phone number" required hint="e.g. 0712345678 or 94712345678">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="07X XXX XXXX"
            inputMode="tel"
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---- Runs -------------------------------------------------------------------------

const RUN_STATUS_META: Record<SmsRunStatus, { label: string; badge: string; dot: string }> = {
  running: {
    label: "Running",
    badge: "bg-primary-50 text-primary-600 ring-primary-200",
    dot: "bg-primary-500",
  },
  completed: {
    label: "Completed",
    badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    dot: "bg-emerald-500",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
    dot: "bg-slate-400",
  },
  failed: {
    label: "Failed",
    badge: "bg-rose-50 text-rose-600 ring-rose-200",
    dot: "bg-rose-500",
  },
};

function RunsList({
  runs,
  savedStepCount,
}: {
  runs: SmsWorkflowRun[];
  savedStepCount: number;
}) {
  const [toCancel, setToCancel] = React.useState<SmsWorkflowRun | null>(null);

  // Refresh the "next fires in…" countdowns every half-minute.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  async function handleCancel() {
    if (!toCancel) return;
    const res = await cancelSmsRun(toCancel.id);
    if (res.ok) toast.success("Enrollment cancelled.");
    else toast.error(res.error);
  }

  async function handleDelete(run: SmsWorkflowRun) {
    const res = await deleteSmsRun(run.id);
    if (!res.ok) toast.error(res.error);
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">
        Enrollments{runs.length > 0 && ` (${runs.length})`}
      </h3>
      {runs.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-6 text-center text-sm text-slate-400">
          No one is enrolled yet. Use “Enroll client” to start the flow for someone.
        </p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => {
            const meta = RUN_STATUS_META[run.status];
            const waiting =
              run.status === "running" &&
              new Date(run.next_run_at).getTime() > now;
            return (
              <div
                key={run.id}
                className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-[var(--shadow-card)]"
              >
                <Badge className={meta.badge} dot={meta.dot}>
                  {meta.label}
                </Badge>
                <span className="text-sm font-medium text-slate-800">
                  {run.client_name || run.to_number}
                </span>
                <span className="flex items-center gap-1 text-xs text-slate-400">
                  <ChevronRight className="h-3 w-3" />
                  step {Math.min(run.step_index + 1, Math.max(savedStepCount, 1))} of{" "}
                  {Math.max(savedStepCount, run.step_index)}
                </span>
                {waiting && (
                  <span className="text-xs text-slate-400">
                    · next{" "}
                    {formatDistanceToNow(new Date(run.next_run_at), { addSuffix: true })}
                  </span>
                )}
                {run.status === "failed" && run.error && (
                  <span className="text-xs text-rose-500">· {run.error}</span>
                )}
                <span className="ml-auto">
                  {run.status === "running" ? (
                    <Button variant="ghost" size="sm" onClick={() => setToCancel(run)}>
                      Cancel
                    </Button>
                  ) : (
                    <IconButton onClick={() => handleDelete(run)} label="Remove" danger>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={toCancel !== null}
        onClose={() => setToCancel(null)}
        onConfirm={handleCancel}
        title="Cancel this enrollment?"
        description="The contact won't receive any remaining steps."
        confirmLabel="Cancel enrollment"
      />
    </div>
  );
}
