"use client";

/**
 * The planning half of a project (PLAN-2, 3, 5, 10).
 *
 * Who is on it, the phases between the six coarse delivery stages, the
 * internal gate before it can be called delivered, and where the hours went.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format, isBefore, startOfToday } from "date-fns";
import {
  CheckCircle2,
  Circle,
  Clock,
  Crown,
  Flag,
  Plus,
  MessageSquareText,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { MILESTONE_STATUS_META, PROJECT_ROLES } from "@/lib/constants";
import { formatMinutes } from "@/lib/projects";
import type {
  MemberLite,
  MilestoneKind,
  ProjectMilestone,
  ProjectTemplate,
} from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";

import { textMilestone } from "@/app/(app)/projects/client-sms-actions";
import {
  addProjectMember,
  applyTemplate,
  deleteMilestone,
  deleteTimeEntry,
  logTime,
  removeProjectMember,
  saveMilestone,
  seedLaunchChecklist,
  setMilestoneStatus,
  setProjectOwner,
  templateFromProject,
} from "@/app/(app)/projects/plan-actions";

export type ProjectMemberRow = {
  id: string;
  user_id: string;
  role: string | null;
  is_owner: boolean;
  profile?: Pick<MemberLite, "id" | "full_name" | "username" | "avatar_url"> | null;
};

export type TimeEntryRow = {
  id: string;
  user_id: string;
  minutes: number;
  note: string | null;
  worked_on: string;
  profile?: Pick<MemberLite, "id" | "full_name" | "avatar_url"> | null;
};

export function PlanSection({
  projectId,
  members,
  team,
  milestones,
  timeEntries,
  templates,
  currency,
  labourCost,
}: {
  projectId: string;
  /** Everyone in the workspace, for the "add someone" picker. */
  members: MemberLite[];
  team: ProjectMemberRow[];
  milestones: ProjectMilestone[];
  timeEntries: TimeEntryRow[];
  templates: Pick<ProjectTemplate, "id" | "name" | "service_type">[];
  currency: string;
  /** Logged time priced at each member's hourly cost. */
  labourCost: number;
}) {
  const phases = milestones.filter((m) => m.kind === "milestone");
  const checks = milestones.filter((m) => m.kind === "launch_check");

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <MilestonesCard
          projectId={projectId}
          milestones={phases}
          members={members}
          kind="milestone"
        />
        <LaunchChecksCard projectId={projectId} checks={checks} />
      </div>
      <div className="space-y-6">
        <TemplateCard projectId={projectId} templates={templates} />
        <TeamCard projectId={projectId} team={team} members={members} />
        <TimeCard
          projectId={projectId}
          entries={timeEntries}
          members={members}
          currency={currency}
          labourCost={labourCost}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Milestones (PLAN-2)                                                 */
/* ------------------------------------------------------------------ */

function MilestonesCard({
  projectId,
  milestones,
  members,
  kind,
}: {
  projectId: string;
  milestones: ProjectMilestone[];
  members: MemberLite[];
  kind: MilestoneKind;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ProjectMilestone | null>(null);
  const [form, setForm] = React.useState({
    title: "",
    detail: "",
    due_date: "",
    owner_id: "",
    client_visible: true,
    notify_sms: false,
  });
  const [saving, setSaving] = React.useState(false);
  const [texting, setTexting] = React.useState<string | null>(null);

  function start(m?: ProjectMilestone) {
    setEditing(m ?? null);
    setForm({
      title: m?.title ?? "",
      detail: m?.detail ?? "",
      due_date: m?.due_date ?? "",
      owner_id: m?.owner_id ?? "",
      client_visible: m?.client_visible ?? true,
      notify_sms: m?.notify_sms ?? false,
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    const res = await saveMilestone({
      id: editing?.id,
      project_id: projectId,
      title: form.title,
      detail: form.detail || null,
      kind,
      due_date: form.due_date || null,
      owner_id: form.owner_id || null,
      client_visible: form.client_visible,
      notify_sms: form.notify_sms,
      position: editing?.position ?? milestones.length,
    });
    setSaving(false);
    if (res.ok) {
      setOpen(false);
      toast.success(editing ? "Milestone updated" : "Milestone added");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function toggle(m: ProjectMilestone) {
    const res = await setMilestoneStatus(
      m.id,
      projectId,
      m.status === "done" ? "pending" : "done",
    );
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    // The milestone is done either way — but never let a failed client text
    // pass silently, or nobody finds out the client wasn't told.
    if (res.smsError) toast.warning(`Marked done, but the client wasn't texted: ${res.smsError}`);
    else if (m.notify_sms && m.status !== "done") toast.success("Client texted");
    router.refresh();
  }

  /** Manual "tell the client" — the same message the auto path would send. */
  async function tellClient(m: ProjectMilestone) {
    setTexting(m.id);
    const res = await textMilestone(m.id, { force: Boolean(m.notified_at) });
    setTexting(null);
    if (res.ok) {
      toast.success("Client texted");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  const doneCount = milestones.filter((m) => m.status === "done").length;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-500">
            <Flag className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Milestones</h2>
            <p className="text-xs text-slate-400">
              {milestones.length === 0
                ? "The phases the client actually cares about"
                : `${doneCount} of ${milestones.length} done`}
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => start()}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>

      {milestones.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          No milestones yet. These show on the client&apos;s portal, so they can
          see progress without asking.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {milestones.map((m) => {
            const overdue =
              m.status !== "done" &&
              m.due_date &&
              isBefore(new Date(`${m.due_date}T23:59:59`), startOfToday());
            return (
              <li key={m.id} className="group flex items-start gap-3 px-5 py-3">
                <button
                  type="button"
                  onClick={() => toggle(m)}
                  className="mt-0.5 shrink-0 text-slate-300 transition hover:text-emerald-500"
                  aria-label={m.status === "done" ? "Reopen" : "Mark done"}
                >
                  {m.status === "done" ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <Circle className="h-5 w-5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => start(m)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p
                    className={cn(
                      "text-sm font-medium",
                      m.status === "done"
                        ? "text-slate-400 line-through"
                        : "text-slate-800",
                    )}
                  >
                    {m.title}
                  </p>
                  {m.detail && (
                    <p className="mt-0.5 text-xs text-slate-500">{m.detail}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {m.due_date && (
                      <span
                        className={cn(
                          "text-[11px]",
                          overdue ? "font-semibold text-rose-500" : "text-slate-400",
                        )}
                      >
                        {overdue ? "Overdue " : "Due "}
                        {format(new Date(m.due_date), "d MMM yyyy")}
                      </span>
                    )}
                    {!m.client_visible && (
                      <Badge className="bg-slate-100 text-slate-500 ring-slate-200">
                        Internal
                      </Badge>
                    )}
                    {m.notified_at ? (
                      <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
                        <MessageSquareText className="h-3 w-3" />
                        Client told
                      </Badge>
                    ) : m.notify_sms ? (
                      <Badge className="bg-sky-50 text-sky-600 ring-sky-200">
                        <MessageSquareText className="h-3 w-3" />
                        Will text
                      </Badge>
                    ) : null}
                    {m.status === "blocked" && (
                      <Badge className={MILESTONE_STATUS_META.blocked.badge}>
                        Blocked
                      </Badge>
                    )}
                  </div>
                </button>

                <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    disabled={texting === m.id}
                    onClick={() => tellClient(m)}
                    className="text-slate-300 transition hover:text-sky-600 disabled:opacity-50"
                    title={
                      m.notified_at
                        ? "Text the client about this again"
                        : "Text the client about this"
                    }
                  >
                    <MessageSquareText className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await deleteMilestone(m.id, projectId);
                      if (res.ok) router.refresh();
                      else toast.error(res.error);
                    }}
                    className="text-slate-300 transition hover:text-rose-600"
                    title="Delete milestone"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit milestone" : "Add a milestone"}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Milestone" required>
            <Input
              autoFocus
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Design approved"
            />
          </Field>
          <Field label="Detail">
            <Textarea
              rows={2}
              value={form.detail}
              onChange={(e) => setForm({ ...form, detail: e.target.value })}
              placeholder="Homepage and one inner page signed off."
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Due">
              <Input
                type="date"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              />
            </Field>
            <Field label="Owner">
              <Select
                value={form.owner_id}
                onChange={(e) => setForm({ ...form, owner_id: e.target.value })}
              >
                <option value="">Nobody yet</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={form.client_visible}
              onChange={(e) =>
                setForm({ ...form, client_visible: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 text-primary-600"
            />
            Show this on the client&apos;s portal
          </label>

          <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-3">
            <input
              type="checkbox"
              checked={form.notify_sms}
              onChange={(e) => setForm({ ...form, notify_sms: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600"
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">
                Text the client when this is done
              </span>
              <span className="block text-xs text-slate-500">
                Sends once, the moment it&rsquo;s ticked off. Leave off for the
                everyday steps — a client texted about all of them stops reading
                any of them.
              </span>
            </span>
          </label>
        </div>
      </Modal>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Launch checklist (PLAN-10)                                          */
/* ------------------------------------------------------------------ */

function LaunchChecksCard({
  projectId,
  checks,
}: {
  projectId: string;
  checks: ProjectMilestone[];
}) {
  const router = useRouter();
  const [seeding, setSeeding] = React.useState(false);

  const openCount = checks.filter((c) => c.status !== "done").length;

  async function seed() {
    setSeeding(true);
    const res = await seedLaunchChecklist(projectId);
    setSeeding(false);
    if (res.ok) {
      toast.success(
        res.seeded ? `${res.seeded} checks added` : "Already on the project",
      );
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-50 text-emerald-500">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Before it goes out
            </h2>
            <p className="text-xs text-slate-400">
              {checks.length === 0
                ? "The gate between build and delivered"
                : openCount === 0
                  ? "All clear — safe to deliver"
                  : `${openCount} still open`}
            </p>
          </div>
        </div>
        {checks.length === 0 && (
          <Button size="sm" variant="outline" onClick={seed} loading={seeding}>
            <Plus className="h-4 w-4" /> Add the standard checks
          </Button>
        )}
      </div>

      {checks.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          SSL, analytics, backups, forms, mobile, speed, SEO, handover. A
          project can&apos;t be marked delivered while any of these are open.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {checks.map((c) => (
            <li key={c.id} className="flex items-start gap-3 px-5 py-2.5">
              <button
                type="button"
                onClick={async () => {
                  const res = await setMilestoneStatus(
                    c.id,
                    projectId,
                    c.status === "done" ? "pending" : "done",
                  );
                  if (res.ok) router.refresh();
                  else toast.error(res.error);
                }}
                className="mt-0.5 shrink-0 text-slate-300 transition hover:text-emerald-500"
                aria-label={c.status === "done" ? "Reopen check" : "Mark passed"}
              >
                {c.status === "done" ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : (
                  <Circle className="h-5 w-5" />
                )}
              </button>
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-sm",
                    c.status === "done" ? "text-slate-400" : "text-slate-800",
                  )}
                >
                  {c.title}
                </p>
                {c.detail && (
                  <p className="mt-0.5 text-xs text-slate-500">{c.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Templates (PLAN-1)                                                  */
/* ------------------------------------------------------------------ */

function TemplateCard({
  projectId,
  templates,
}: {
  projectId: string;
  templates: Pick<ProjectTemplate, "id" | "name" | "service_type">[];
}) {
  const router = useRouter();
  const [choice, setChoice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [name, setName] = React.useState("");

  async function apply() {
    if (!choice) return;
    setBusy(true);
    const res = await applyTemplate(projectId, choice);
    setBusy(false);
    if (res.ok) {
      const parts = [
        res.tasks ? `${res.tasks} tasks` : null,
        res.assets ? `${res.assets} asset requests` : null,
        res.milestones ? `${res.milestones} milestones` : null,
        res.checks ? `${res.checks} launch checks` : null,
      ].filter(Boolean);
      toast.success(
        parts.length ? `Added ${parts.join(", ")}` : "Everything was already here",
      );
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function saveAsTemplate() {
    setBusy(true);
    const res = await templateFromProject(projectId, name);
    setBusy(false);
    if (res.ok) {
      setSaveOpen(false);
      setName("");
      toast.success("Template saved — it's on /projects/templates");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-sm font-semibold text-slate-900">Plan from a template</h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Seeds the tasks, asset checklist, milestones and launch checks in one go.
        Applying twice tops up rather than duplicating.
      </p>

      {templates.length === 0 ? (
        <p className="mt-4 text-xs text-slate-400">
          No templates yet. Plan one project properly, then save it as a template.
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={apply} disabled={!choice} loading={busy}>
            Apply
          </Button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setSaveOpen(true)}
        className="mt-3 text-xs font-medium text-primary-600 hover:text-primary-700"
      >
        Save this project as a template
      </button>

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save as a template"
        description="Copies this project's tasks, asset requests, milestones and launch checks into a reusable plan."
        footer={
          <>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveAsTemplate} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Template name" required>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Business website — standard build"
          />
        </Field>
      </Modal>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Team (PLAN-3)                                                       */
/* ------------------------------------------------------------------ */

function TeamCard({
  projectId,
  team,
  members,
}: {
  projectId: string;
  team: ProjectMemberRow[];
  members: MemberLite[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [userId, setUserId] = React.useState("");
  const [role, setRole] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const onProject = new Set(team.map((t) => t.user_id));

  async function add() {
    if (!userId) return;
    setBusy(true);
    const res = await addProjectMember(projectId, userId, role, team.length === 0);
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      setUserId("");
      setRole("");
      toast.success("Added to the project");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-sky-50 text-sky-500">
            <Users className="h-5 w-5" />
          </span>
          <h2 className="text-sm font-semibold text-slate-900">On this project</h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4" />
        </Button>
      </div>

      {team.length === 0 ? (
        <p className="px-5 py-6 text-center text-xs text-slate-400">
          Nobody assigned. Add whoever is building it — template tasks land on
          the right person once roles are set.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {team.map((m) => (
            <li key={m.id} className="group flex items-center gap-3 px-5 py-3">
              <Avatar
                name={m.profile?.full_name}
                src={m.profile?.avatar_url}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">
                  {m.profile?.full_name ?? "Unknown"}
                  {m.is_owner && (
                    <Crown className="ml-1.5 inline h-3.5 w-3.5 text-amber-500" />
                  )}
                </p>
                {m.role && <p className="text-xs text-slate-400">{m.role}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                {!m.is_owner && (
                  <button
                    type="button"
                    title="Make owner"
                    onClick={async () => {
                      const res = await setProjectOwner(projectId, m.id);
                      if (res.ok) router.refresh();
                      else toast.error(res.error);
                    }}
                    className="text-slate-300 hover:text-amber-500"
                  >
                    <Crown className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  title="Remove"
                  onClick={async () => {
                    const res = await removeProjectMember(m.id, projectId);
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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add someone to the project"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={add} loading={busy}>
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Who" required>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose someone…</option>
              {members
                .filter((m) => !onProject.has(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field
            label="Role"
            hint="Template tasks tagged with this role land on them automatically."
          >
            <Input
              list="project-roles"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Developer"
            />
            <datalist id="project-roles">
              {PROJECT_ROLES.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
        </div>
      </Modal>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Time (PLAN-5)                                                       */
/* ------------------------------------------------------------------ */

function TimeCard({
  projectId,
  entries,
  members,
  currency,
  labourCost,
}: {
  projectId: string;
  entries: TimeEntryRow[];
  members: MemberLite[];
  currency: string;
  labourCost: number;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [hours, setHours] = React.useState("");
  const [note, setNote] = React.useState("");
  const [who, setWho] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const total = entries.reduce((s, e) => s + e.minutes, 0);

  async function add() {
    const parsed = Number(hours);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("How many hours?");
      return;
    }
    setBusy(true);
    const res = await logTime({
      project_id: projectId,
      minutes: Math.round(parsed * 60),
      note: note || null,
      user_id: who || null,
    });
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      setHours("");
      setNote("");
      toast.success("Time logged");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-500">
            <Clock className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Time</h2>
            <p className="text-xs text-slate-400">
              {total > 0 ? formatMinutes(total) : "Nothing logged"}
              {labourCost > 0 ? ` · ${formatCurrency(labourCost, currency)}` : ""}
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="px-5 py-6 text-center text-xs text-slate-400">
          Log time as you go and the margin figure stops being a guess.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {entries.slice(0, 8).map((e) => (
            <li key={e.id} className="group flex items-center gap-3 px-5 py-2.5">
              <Avatar name={e.profile?.full_name} src={e.profile?.avatar_url} size="xs" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-slate-700">
                  <span className="font-semibold">{formatMinutes(e.minutes)}</span>
                  {e.note ? ` — ${e.note}` : ""}
                </p>
                <p className="text-[11px] text-slate-400">
                  {format(new Date(`${e.worked_on}T00:00:00`), "d MMM")}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const res = await deleteTimeEntry(e.id, projectId);
                  if (res.ok) router.refresh();
                  else toast.error(res.error);
                }}
                className="shrink-0 text-slate-300 opacity-0 transition hover:text-rose-600 group-hover:opacity-100"
                title="Delete entry"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Log time"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={add} loading={busy}>
              Log it
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Hours" required>
            <Input
              autoFocus
              type="number"
              step="0.25"
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="2.5"
            />
          </Field>
          <Field label="What on">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Homepage build"
            />
          </Field>
          <Field label="For" hint="Leave blank to log against yourself.">
            <Select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Me</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </section>
  );
}
