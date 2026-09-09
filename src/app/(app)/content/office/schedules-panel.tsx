"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Clock, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { describeCadence } from "@/lib/agents/office-core";
import type { OfficeAgentView, OfficeBrandProfileRow, OfficeScheduleRow } from "@/lib/agents/office-types";
import type { OfficeCadence, OfficeMissionMode, SocialPlatform } from "@/lib/database.types";
import { cn } from "@/lib/utils";

import { createSchedule, deleteSchedule, toggleSchedule, updateSchedule, type ScheduleInput } from "../office-actions";
import { Toggle } from "./office-ui";

/**
 * Timers (0130): missions the office opens on its own. Unattended runs
 * advance on the five-minute tick and render a slide a tick, so a timer
 * should fire hours before the posts are due.
 */
export function SchedulesPanel({
  schedules,
  agents,
  clients,
  brandProfiles,
  isAdmin,
  ready,
}: {
  schedules: OfficeScheduleRow[];
  agents: OfficeAgentView[];
  clients: { id: string; name: string }[];
  brandProfiles: OfficeBrandProfileRow[];
  isAdmin: boolean;
  ready: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<OfficeScheduleRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function flip(s: OfficeScheduleRow) {
    setBusy(s.id);
    try {
      const res = await toggleSchedule(s.id, !s.is_active);
      if (!res.ok) return toast.error(res.error);
      toast.success(s.is_active ? "Timer paused." : "Timer on.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          Automated briefs on a timer. Each firing opens a mission exactly like pressing “Brief” yourself.
          {isAdmin ? "" : " Only an admin can add or change one."}
        </p>
        {isAdmin && (
          <Button size="sm" onClick={() => setEditing("new")} disabled={!ready}>
            <Plus className="h-4 w-4" /> New timer
          </Button>
        )}
      </div>
      {!schedules.length ? (
        <EmptyState icon={<Clock className="h-6 w-6" />} title="No timers yet" description="Create one to have the office prepare content every week without being asked." />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {schedules.map((s) => (
            <li key={s.id} className={cn("card bg-white p-4", !s.is_active && "opacity-70")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-slate-900">{s.name}</div>
                  <div className="text-xs text-slate-500">
                    {describeCadence(s)} · {s.mode === "direct" ? `${agents.find((a) => a.key === s.agent_key)?.name ?? s.agent_key} directly` : "via the Director"}
                    {s.options?.autoPublish ? " · auto-publish" : ""}
                  </div>
                </div>
                {isAdmin ? (
                  <Toggle checked={s.is_active} onChange={() => flip(s)} disabled={busy === s.id} label="Active" />
                ) : (
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1", s.is_active ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200")}>
                    {s.is_active ? "on" : "paused"}
                  </span>
                )}
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-700">{s.goal}</p>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>{s.is_active && s.next_run_at ? `Next: ${format(new Date(s.next_run_at), "EEE d MMM, HH:mm")}` : "Paused"}</span>
                {isAdmin && (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setDeleting(s.id)} aria-label="Delete timer">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ScheduleForm
          schedule={editing === "new" ? null : editing}
          agents={agents}
          clients={clients}
          brandProfiles={brandProfiles}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this timer?"
        description="Missions it already opened are kept."
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteSchedule(deleting);
          if (!res.ok) toast.error(res.error);
          else toast.success("Timer deleted.");
          setDeleting(null);
          router.refresh();
        }}
      />
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ScheduleForm({
  schedule,
  agents,
  clients,
  brandProfiles,
  isAdmin,
  onClose,
}: {
  schedule: OfficeScheduleRow | null;
  agents: OfficeAgentView[];
  clients: { id: string; name: string }[];
  brandProfiles: OfficeBrandProfileRow[];
  isAdmin: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [s, setS] = React.useState<ScheduleInput>({
    name: schedule?.name ?? "",
    goal: schedule?.goal ?? "",
    mode: schedule?.mode ?? "manager",
    agentKey: schedule?.agent_key ?? "research",
    cadence: schedule?.cadence ?? "weekly",
    everyN: schedule?.every_n ?? 3,
    runTime: (schedule?.run_time ?? "09:00").slice(0, 5),
    weekdays: schedule?.weekdays ?? [1],
    dayOfMonth: schedule?.day_of_month ?? 1,
    timezone: schedule?.timezone ?? "Asia/Colombo",
    options: schedule?.options ?? { platforms: ["instagram"], postCount: 2 },
    clientId: schedule?.client_id ?? null,
    brandProfileId: schedule?.brand_profile_id ?? null,
    isActive: schedule?.is_active ?? true,
  });
  const set = <K extends keyof ScheduleInput>(k: K, v: ScheduleInput[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const setOpt = (patch: Partial<ScheduleInput["options"]>) => setS((prev) => ({ ...prev, options: { ...prev.options, ...patch } }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = schedule ? await updateSchedule(schedule.id, s) : await createSchedule(s);
      if (!res.ok) return toast.error(res.error);
      toast.success(schedule ? "Timer saved." : "Timer created — the office will fire it on schedule.");
      onClose();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const platforms = s.options.platforms ?? [];

  return (
    <Modal open onClose={onClose} title={schedule ? "Edit timer" : "New timer"} size="lg">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={s.name} onChange={(e) => set("name", e.target.value)} placeholder="Weekly Instagram batch" />
          </Field>
          <Field label="Who runs it">
            <Select value={s.mode === "manager" ? "manager" : s.agentKey ?? ""} onChange={(e) => (e.target.value === "manager" ? set("mode", "manager") : (set("mode", "direct" as OfficeMissionMode), set("agentKey", e.target.value)))}>
              <option value="manager">The Director (plans and delegates)</option>
              {agents.filter((a) => a.key !== "manager").map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name} directly — {a.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="The brief" required>
          <Textarea rows={3} value={s.goal} onChange={(e) => set("goal", e.target.value)} placeholder="Plan and draft next week's carousels about AI automation for Sri Lankan SMEs." />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Cadence">
            <Select value={s.cadence} onChange={(e) => set("cadence", e.target.value as OfficeCadence)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="every_n_days">Every N days</option>
            </Select>
          </Field>
          <Field label="Time (Asia/Colombo)">
            <Input type="time" value={s.runTime} onChange={(e) => set("runTime", e.target.value)} />
          </Field>
          {s.cadence === "every_n_days" && (
            <Field label="Every N days">
              <Input type="number" min={1} max={60} value={s.everyN ?? 3} onChange={(e) => set("everyN", Number(e.target.value))} />
            </Field>
          )}
          {s.cadence === "monthly" && (
            <Field label="Day of month">
              <Input type="number" min={1} max={31} value={s.dayOfMonth ?? 1} onChange={(e) => set("dayOfMonth", Number(e.target.value))} />
            </Field>
          )}
        </div>
        {s.cadence === "weekly" && (
          <Field label="Days">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d, i) => {
                const n = i + 1;
                const on = s.weekdays.includes(n);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => set("weekdays", on ? s.weekdays.filter((x) => x !== n) : [...s.weekdays, n].sort())}
                    className={cn("rounded-lg px-3 py-1.5 text-xs font-semibold ring-1", on ? "bg-primary-50 text-primary-700 ring-primary-200" : "bg-white text-slate-600 ring-slate-200")}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Platforms">
            <div className="flex gap-1.5">
              {(["instagram", "facebook"] as SocialPlatform[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setOpt({ platforms: platforms.includes(p) ? platforms.filter((x) => x !== p) : [...platforms, p] })}
                  className={cn("rounded-lg px-3 py-2 text-xs font-semibold capitalize ring-1", platforms.includes(p) ? "bg-primary-50 text-primary-700 ring-primary-200" : "bg-white text-slate-600 ring-slate-200")}
                >
                  {p}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Posts per run">
            <Input type="number" min={1} max={6} value={s.options.postCount ?? 2} onChange={(e) => setOpt({ postCount: Number(e.target.value) })} />
          </Field>
          <Field label="Client">
            <Select value={s.clientId ?? ""} onChange={(e) => set("clientId", e.target.value || null)}>
              <option value="">Our own brand</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Brand profile">
            <Select value={s.brandProfileId ?? ""} onChange={(e) => set("brandProfileId", e.target.value || null)}>
              <option value="">Default</option>
              {brandProfiles.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1 text-xs text-slate-600">
            <label className="flex items-center gap-2">
              <Toggle checked={s.isActive} onChange={(v) => set("isActive", v)} label="Active" /> Active
            </label>
            {isAdmin && (
              <label className="flex items-center gap-2">
                <Toggle checked={Boolean(s.options.autoPublish)} onChange={(v) => setOpt({ autoPublish: v })} label="Auto-publish" /> Auto-publish (the Publisher queues posts itself)
              </label>
            )}
          </div>
        </div>
        <p className="text-xs text-slate-500">Unattended runs move one step every five minutes and render one slide a tick, so fire a timer hours before the posts are due — overnight for a morning review works well.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {schedule ? "Save" : "Create timer"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
