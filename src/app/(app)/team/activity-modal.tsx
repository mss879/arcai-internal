"use client";

import * as React from "react";
import { format } from "date-fns";
import { Clock, MapPin, MonitorSmartphone } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import type { LoginSession, Profile } from "@/lib/types";

import { getMemberActivity } from "./actions";
import type { MemberDevice } from "./team-view";

/** "38 min" / "2h 05m" between login and last activity (floor 1 min). */
function activeFor(s: LoginSession): string {
  const mins = Math.max(
    1,
    Math.round(
      (new Date(s.last_active_at).getTime() -
        new Date(s.logged_in_at).getTime()) /
        60_000,
    ),
  );
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function locationOf(s: LoginSession): string | null {
  const parts = [s.city, s.region, s.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Admin view of one member's sign-in history: every login of the last 30
 * days grouped by day — time in, how long they stayed active, which
 * registered device, and where from (IP + network location) — plus the
 * member's registered devices at the top.
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
  const [sessions, setSessions] = React.useState<LoginSession[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!member) return;
    let cancelled = false;
    setSessions(null);
    setError(null);
    (async () => {
      const res = await getMemberActivity(member.id);
      if (cancelled) return;
      if (res.ok) setSessions(res.sessions);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [member]);

  const byDay = React.useMemo(() => {
    const map = new Map<string, LoginSession[]>();
    for (const s of sessions ?? []) {
      const day = format(new Date(s.logged_in_at), "EEEE, MMM d, yyyy");
      const list = map.get(day);
      if (list) list.push(s);
      else map.set(day, [s]);
    }
    return map;
  }, [sessions]);

  return (
    <Modal
      open={!!member}
      onClose={onClose}
      title={`Activity — ${member?.full_name || member?.username || ""}`}
      size="lg"
    >
      {member && (
        <div className="space-y-5">
          {/* Registered devices */}
          <div className="rounded-2xl border border-slate-200/80">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <MonitorSmartphone className="h-4 w-4 text-primary-500" />
              <h4 className="text-sm font-semibold text-slate-900">
                Registered devices
              </h4>
              <span className="text-xs text-slate-400">
                ({devices.length}/2)
              </span>
            </div>
            <div className="px-4 py-3">
              {devices.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No devices registered yet.
                </p>
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
              {sessions && (
                <span className="text-xs text-slate-400">
                  ({sessions.length})
                </span>
              )}
            </div>

            {error ? (
              <p className="px-4 py-6 text-sm text-rose-600">{error}</p>
            ) : sessions === null ? (
              <div className="space-y-2 px-4 py-4">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : sessions.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                No logins recorded yet. Sign-ins are tracked from the moment
                this update went live.
              </p>
            ) : (
              <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                {Array.from(byDay.entries()).map(([day, list]) => {
                  const totalMins = list.reduce(
                    (sum, s) =>
                      sum +
                      Math.max(
                        1,
                        Math.round(
                          (new Date(s.last_active_at).getTime() -
                            new Date(s.logged_in_at).getTime()) /
                            60_000,
                        ),
                      ),
                    0,
                  );
                  return (
                    <div key={day} className="px-4 py-3">
                      <p className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {day}
                        <span className="font-normal normal-case tracking-normal text-slate-400">
                          {list.length} login{list.length === 1 ? "" : "s"} ·{" "}
                          {totalMins < 60
                            ? `${totalMins} min`
                            : `${Math.floor(totalMins / 60)}h ${String(totalMins % 60).padStart(2, "0")}m`}{" "}
                          active
                        </span>
                      </p>
                      <ul className="mt-2 space-y-2">
                        {list.map((s) => (
                          <li
                            key={s.id}
                            className="rounded-xl bg-slate-50 px-3.5 py-2.5"
                          >
                            <p className="flex flex-wrap items-center gap-x-2 text-sm text-slate-800">
                              <span className="font-semibold">
                                {format(new Date(s.logged_in_at), "h:mm a")}
                              </span>
                              <span className="text-slate-400">→</span>
                              <span>
                                {format(new Date(s.last_active_at), "h:mm a")}
                              </span>
                              <span className="rounded-full bg-emerald-100 px-1.5 text-[11px] font-semibold text-emerald-700">
                                {activeFor(s)}
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
      )}
    </Modal>
  );
}
