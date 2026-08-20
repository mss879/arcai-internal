"use client";

import * as React from "react";
import { format, subDays } from "date-fns";
import { Camera, Clock, ListChecks, MapPin, MonitorSmartphone } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LoginSession, MemberChange, Profile } from "@/lib/types";

import { getMemberActivity } from "./actions";
import type { MemberDevice } from "./team-view";

type TabKey = "logins" | "changes" | "analytics";

/** Minutes a session was active (login → last activity, floor 1). */
function sessionMins(s: LoginSession): number {
  return Math.max(
    1,
    Math.round(
      (new Date(s.last_active_at).getTime() -
        new Date(s.logged_in_at).getTime()) /
        60_000,
    ),
  );
}

function fmtMins(mins: number): string {
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function locationOf(s: LoginSession): string | null {
  const parts = [s.city, s.region, s.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Human names for the audited tables, for the Changes/Analytics tabs. */
const TABLE_LABELS: Record<string, string> = {
  leads: "lead",
  lead_activities: "lead activity",
  lead_outreach: "lead outreach",
  clients: "client",
  companies: "company",
  todos: "to-do",
  todo_subtasks: "subtask",
  crm_tasks: "CRM task",
  projects: "project",
  meetings: "meeting",
  meeting_attendees: "meeting attendee",
  invoices: "invoice",
  quotes: "quote",
  notices: "notice",
  proposals: "proposal",
  payments: "payment",
  payment_plans: "payment plan",
  payment_installments: "installment",
  expenses: "expense",
  cheques: "cheque",
  company_payments: "company payment",
  pipelines: "pipeline",
  pipeline_stages: "pipeline stage",
  wa_messages: "WhatsApp message",
  wa_contacts: "WhatsApp contact",
  sms_messages: "SMS",
  resources: "resource",
  carousel_posts: "carousel post",
  content_generations: "content draft",
};

function tableLabel(table: string): string {
  return TABLE_LABELS[table] ?? table.replace(/_/g, " ");
}

/** Screenshot alerts ride in member_changes but aren't "work". */
function isScreenshot(c: MemberChange): boolean {
  return c.table_name === "screenshots";
}

function describeChange(c: MemberChange): string {
  if (c.table_name === "wa_messages" && c.op === "created")
    return "Sent WhatsApp message";
  if (c.table_name === "sms_messages" && c.op === "created") return "Sent SMS";
  const verb =
    c.op === "created" ? "Created" : c.op === "updated" ? "Updated" : "Deleted";
  return `${verb} ${tableLabel(c.table_name)}`;
}

const OP_COLORS: Record<MemberChange["op"], string> = {
  created: "text-emerald-600",
  updated: "text-sky-600",
  deleted: "text-rose-600",
};

/**
 * Admin view of one member's work: Logins (sessions with device, duration,
 * IP and location, plus registered devices), Changes (every create/update/
 * delete they made, grouped per day), and Analytics (hours + changes per
 * day visualized, and where the work went). Last 30 days.
 */
export function ActivityModal({
  member,
  devices,
  onClose,
}: {
  member: Profile | null;
  devices: MemberDevice[];
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<TabKey>("logins");
  const [sessions, setSessions] = React.useState<LoginSession[] | null>(null);
  const [changes, setChanges] = React.useState<MemberChange[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!member) return;
    let cancelled = false;
    setTab("logins");
    setSessions(null);
    setChanges([]);
    setError(null);
    (async () => {
      const res = await getMemberActivity(member.id);
      if (cancelled) return;
      if (res.ok) {
        setSessions(res.sessions);
        setChanges(res.changes);
      } else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [member]);

  const sessionsByDay = React.useMemo(() => {
    const map = new Map<string, LoginSession[]>();
    for (const s of sessions ?? []) {
      const day = format(new Date(s.logged_in_at), "EEEE, MMM d, yyyy");
      const list = map.get(day);
      if (list) list.push(s);
      else map.set(day, [s]);
    }
    return map;
  }, [sessions]);

  const changesByDay = React.useMemo(() => {
    const map = new Map<string, MemberChange[]>();
    for (const c of changes) {
      const day = format(new Date(c.created_at), "EEEE, MMM d, yyyy");
      const list = map.get(day);
      if (list) list.push(c);
      else map.set(day, [c]);
    }
    return map;
  }, [changes]);

  const loading = sessions === null && !error;

  return (
    <Modal
      open={!!member}
      onClose={onClose}
      title={`Activity — ${member?.full_name || member?.username || ""}`}
      size="lg"
    >
      {member && (
        <div className="space-y-4">
          {/* Tab switcher */}
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
            {(
              [
                { key: "logins", label: "Logins" },
                { key: "changes", label: "Changes" },
                { key: "analytics", label: "Analytics" },
              ] as { key: TabKey; label: string }[]
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.key
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {error ? (
            <p className="py-6 text-sm text-rose-600">{error}</p>
          ) : loading ? (
            <div className="space-y-2 py-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>
          ) : tab === "logins" ? (
            <LoginsTab
              devices={devices}
              sessions={sessions ?? []}
              sessionsByDay={sessionsByDay}
            />
          ) : tab === "changes" ? (
            <ChangesTab changes={changes} changesByDay={changesByDay} />
          ) : (
            <AnalyticsTab sessions={sessions ?? []} changes={changes} />
          )}
        </div>
      )}
    </Modal>
  );
}

// ---- Logins -------------------------------------------------------------------

function LoginsTab({
  devices,
  sessions,
  sessionsByDay,
}: {
  devices: MemberDevice[];
  sessions: LoginSession[];
  sessionsByDay: Map<string, LoginSession[]>;
}) {
  return (
    <div className="space-y-4">
      {/* Registered devices */}
      <div className="rounded-2xl border border-slate-200/80">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <MonitorSmartphone className="h-4 w-4 text-primary-500" />
          <h4 className="text-sm font-semibold text-slate-900">
            Registered devices
          </h4>
          <span className="text-xs text-slate-400">({devices.length}/2)</span>
        </div>
        <div className="px-4 py-3">
          {devices.length === 0 ? (
            <p className="text-sm text-slate-400">No devices registered yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                >
                  <span className="text-sm font-medium text-slate-800">
                    {d.label}
                  </span>
                  <span className="text-xs text-slate-400">
                    Registered {format(new Date(d.created_at), "MMM d, yyyy")}
                    {d.last_used_at &&
                      ` · used ${format(new Date(d.last_used_at), "MMM d")}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Login history */}
      <div className="rounded-2xl border border-slate-200/80">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Clock className="h-4 w-4 text-primary-500" />
          <h4 className="text-sm font-semibold text-slate-900">
            Logins — last 30 days
          </h4>
          <span className="text-xs text-slate-400">({sessions.length})</span>
        </div>

        {sessions.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-400">
            No logins recorded yet. Sign-ins are tracked from the moment this
            update went live.
          </p>
        ) : (
          <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {Array.from(sessionsByDay.entries()).map(([day, list]) => {
              const totalMins = list.reduce((sum, s) => sum + sessionMins(s), 0);
              return (
                <div key={day} className="px-4 py-3">
                  <p className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {day}
                    <span className="font-normal normal-case tracking-normal text-slate-400">
                      {list.length} login{list.length === 1 ? "" : "s"} ·{" "}
                      {fmtMins(totalMins)} active
                    </span>
                  </p>
                  <ul className="mt-2 space-y-2">
                    {list.map((s) => (
                      <li key={s.id} className="rounded-xl bg-slate-50 px-3.5 py-2.5">
                        <p className="flex flex-wrap items-center gap-x-2 text-sm text-slate-800">
                          <span className="font-semibold">
                            {format(new Date(s.logged_in_at), "h:mm a")}
                          </span>
                          <span className="text-slate-400">→</span>
                          <span>
                            {format(new Date(s.last_active_at), "h:mm a")}
                          </span>
                          <span className="rounded-full bg-emerald-100 px-1.5 text-[11px] font-semibold text-emerald-700">
                            {fmtMins(sessionMins(s))}
                          </span>
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <MonitorSmartphone className="h-3.5 w-3.5 text-slate-400" />
                            {s.device_label ?? "Unregistered device"}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5 text-slate-400" />
                            {locationOf(s) ?? "Location unknown"}
                            {s.ip ? ` · ${s.ip}` : ""}
                          </span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Changes ------------------------------------------------------------------

function ChangesTab({
  changes,
  changesByDay,
}: {
  changes: MemberChange[];
  changesByDay: Map<string, MemberChange[]>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <ListChecks className="h-4 w-4 text-primary-500" />
        <h4 className="text-sm font-semibold text-slate-900">
          Changes — last 30 days
        </h4>
        <span className="text-xs text-slate-400">({changes.length})</span>
      </div>

      {changes.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400">
          No changes recorded yet. Creates, edits and deletes are tracked from
          the moment this update went live.
        </p>
      ) : (
        <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
          {Array.from(changesByDay.entries()).map(([day, list]) => {
            const shots = list.filter(isScreenshot).length;
            const workCount = list.length - shots;
            return (
              <div key={day} className="px-4 py-3">
                <p className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {day}
                  <span className="font-normal normal-case tracking-normal text-slate-400">
                    {workCount} change{workCount === 1 ? "" : "s"}
                    {shots > 0 && (
                      <span className="text-rose-500">
                        {" "}
                        · {shots} screenshot{shots === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                </p>
                <ul className="mt-2 space-y-1.5">
                  {list.map((c) =>
                    isScreenshot(c) ? (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-rose-50 px-3 py-2 text-sm ring-1 ring-inset ring-rose-100"
                      >
                        <span className="w-16 shrink-0 text-xs font-semibold text-rose-400">
                          {format(new Date(c.created_at), "h:mm a")}
                        </span>
                        <span className="inline-flex items-center gap-1.5 font-medium text-rose-700">
                          <Camera className="h-3.5 w-3.5" /> Screenshot
                          detected
                        </span>
                        {c.label && (
                          <span className="min-w-0 truncate text-rose-500">
                            {c.label}
                          </span>
                        )}
                      </li>
                    ) : (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-slate-50 px-3 py-2 text-sm"
                      >
                        <span className="w-16 shrink-0 text-xs font-semibold text-slate-400">
                          {format(new Date(c.created_at), "h:mm a")}
                        </span>
                        <span className={cn("font-medium", OP_COLORS[c.op])}>
                          {describeChange(c)}
                        </span>
                        {c.label && (
                          <span className="min-w-0 truncate text-slate-600">
                            “{c.label}”
                          </span>
                        )}
                        {c.op === "updated" &&
                          (c.changed_fields ?? []).slice(0, 4).map((f) => (
                            <span
                              key={f}
                              className="rounded-full bg-slate-200/70 px-1.5 text-[10px] font-medium text-slate-500"
                            >
                              {f.replace(/_/g, " ")}
                            </span>
                          ))}
                        {c.op === "updated" &&
                          (c.changed_fields?.length ?? 0) > 4 && (
                            <span className="text-[10px] text-slate-400">
                              +{(c.changed_fields?.length ?? 0) - 4} more
                            </span>
                          )}
                      </li>
                    ),
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Analytics ----------------------------------------------------------------

function AnalyticsTab({
  sessions,
  changes,
}: {
  sessions: LoginSession[];
  changes: MemberChange[];
}) {
  const stats = React.useMemo(() => {
    // Screenshot alerts live in the same trail but don't count as work.
    const work = changes.filter((c) => !isScreenshot(c));
    const screenshots = changes.length - work.length;

    const totalMins = sessions.reduce((sum, s) => sum + sessionMins(s), 0);
    const activeDayKeys = new Set(
      sessions.map((s) => format(new Date(s.logged_in_at), "yyyy-MM-dd")),
    );
    const days = Array.from({ length: 14 }, (_, i) => {
      const date = subDays(new Date(), 13 - i);
      return { date, key: format(date, "yyyy-MM-dd") };
    });
    const minsByDay = new Map<string, number>();
    for (const s of sessions) {
      const key = format(new Date(s.logged_in_at), "yyyy-MM-dd");
      minsByDay.set(key, (minsByDay.get(key) ?? 0) + sessionMins(s));
    }
    const changesByDayCount = new Map<string, number>();
    for (const c of work) {
      const key = format(new Date(c.created_at), "yyyy-MM-dd");
      changesByDayCount.set(key, (changesByDayCount.get(key) ?? 0) + 1);
    }
    const byArea = new Map<string, number>();
    for (const c of work) {
      const label = tableLabel(c.table_name);
      byArea.set(label, (byArea.get(label) ?? 0) + 1);
    }
    const areas = Array.from(byArea.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    return {
      totalMins,
      totalChanges: work.length,
      screenshots,
      activeDays: activeDayKeys.size,
      avgMins: activeDayKeys.size
        ? Math.round(totalMins / activeDayKeys.size)
        : 0,
      days,
      minsByDay,
      changesByDayCount,
      areas,
    };
  }, [sessions, changes]);

  const noData = sessions.length === 0 && changes.length === 0;
  if (noData) {
    return (
      <p className="rounded-2xl border border-slate-200/80 px-4 py-10 text-center text-sm text-slate-400">
        Nothing to analyze yet — hours and changes appear here as the member
        uses the system.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {stats.screenshots > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
          <Camera className="h-4 w-4 shrink-0" />
          {stats.screenshots} screenshot alert
          {stats.screenshots === 1 ? "" : "s"} in the last 30 days — see the
          Changes tab for when and where.
        </div>
      )}

      {/* Stat tiles (last 30 days) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Hours active" value={fmtMins(stats.totalMins)} accent />
        <StatTile label="Changes made" value={String(stats.totalChanges)} />
        <StatTile label="Days active" value={String(stats.activeDays)} />
        <StatTile label="Avg per active day" value={fmtMins(stats.avgMins)} />
      </div>
      <p className="-mt-2 text-right text-[11px] text-slate-400">
        Last 30 days · charts show the last 14
      </p>

      <BarChart
        title="Time on the system per day"
        color="bg-primary-500"
        days={stats.days}
        valueOf={(key) => stats.minsByDay.get(key) ?? 0}
        format={(v) => fmtMins(v)}
        shortFormat={(v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`)}
      />

      <BarChart
        title="Changes per day"
        color="bg-emerald-500"
        days={stats.days}
        valueOf={(key) => stats.changesByDayCount.get(key) ?? 0}
        format={(v) => `${v} change${v === 1 ? "" : "s"}`}
        shortFormat={(v) => String(v)}
      />

      {/* Where the work went */}
      <div className="rounded-2xl border border-slate-200/80 p-4">
        <h4 className="text-sm font-semibold text-slate-900">
          Where the work went
        </h4>
        {stats.areas.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">No changes recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {stats.areas.map(([label, count]) => {
              const max = stats.areas[0][1];
              return (
                <li key={label} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 truncate text-xs font-medium capitalize text-slate-600">
                    {label}
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-primary-500"
                      style={{ width: `${Math.max((count / max) * 100, 4)}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs font-semibold text-slate-700">
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        accent
          ? "border-primary-200 bg-primary-50/60"
          : "border-slate-200/80 bg-white",
      )}
    >
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold",
          accent ? "text-primary-700" : "text-slate-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function BarChart({
  title,
  color,
  days,
  valueOf,
  format: fmt,
  shortFormat,
}: {
  title: string;
  color: string;
  days: { date: Date; key: string }[];
  valueOf: (key: string) => number;
  format: (v: number) => string;
  shortFormat: (v: number) => string;
}) {
  const max = Math.max(1, ...days.map((d) => valueOf(d.key)));
  return (
    <div className="rounded-2xl border border-slate-200/80 p-4">
      <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
      <div className="mt-3 flex items-end gap-1.5">
        {days.map((d) => {
          const v = valueOf(d.key);
          const pct = v > 0 ? Math.max((v / max) * 100, 5) : 0;
          return (
            <div
              key={d.key}
              className="flex flex-1 flex-col items-center gap-1"
              title={`${format(d.date, "EEE, MMM d")} — ${fmt(v)}`}
            >
              <span className="h-3.5 text-[10px] leading-none text-slate-400">
                {v > 0 ? shortFormat(v) : ""}
              </span>
              <div className="flex h-20 w-full items-end">
                <div
                  className={cn("w-full rounded-t", v > 0 ? color : "bg-slate-100")}
                  style={{ height: v > 0 ? `${pct}%` : "3px" }}
                />
              </div>
              <span className="text-[10px] text-slate-400">
                {format(d.date, "d")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
