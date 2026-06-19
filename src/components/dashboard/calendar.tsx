"use client";

import * as React from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight, Plus, Clock } from "lucide-react";

import { TodoFormModal } from "@/components/todos/todo-form-modal";
import { PRIORITY_META } from "@/lib/constants";
import { cn, formatTime12 } from "@/lib/utils";
import type { MemberLite, Todo } from "@/lib/types";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CalendarBooking = {
  id: string;
  booking_date: string;
  start_time: string;
  client_name: string;
  link?: { title: string } | null;
};

type DayEvent =
  | { id: string; type: "todo"; data: Todo; time: Date | null }
  | { id: string; type: "booking"; data: CalendarBooking; time: Date };

/** Small status dot colour for the compact (mobile) day view. */
function dotClass(event: DayEvent): string {
  if (event.type === "booking") return "bg-cyan-500";
  const t = event.data;
  if (t.status === "done") return "bg-slate-400";
  if (t.status === "in_progress") return "bg-amber-500";
  return PRIORITY_META[t.priority].dot;
}

export function Calendar({
  todos,
  members,
  bookings = [],
}: {
  todos: Todo[];
  members: MemberLite[];
  bookings?: CalendarBooking[];
}) {
  useRealtimeSyncTables(["todos", "meeting_bookings"]);

  const today = React.useMemo(() => startOfDay(new Date()), []);
  const [month, setMonth] = React.useState(() => new Date());
  const [selected, setSelected] = React.useState(() => startOfDay(new Date()));
  const [editing, setEditing] = React.useState<Todo | null>(null);
  const [creating, setCreating] = React.useState<string | null>(null);

  const days = React.useMemo(() => {
    const start = startOfWeek(startOfMonth(month));
    const end = endOfWeek(endOfMonth(month));
    return eachDayOfInterval({ start, end });
  }, [month]);

  const byDay = React.useMemo(() => {
    const map = new Map<string, Todo[]>();
    for (const t of todos) {
      if (!t.due_date) continue;
      const key = format(new Date(t.due_date), "yyyy-MM-dd");
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return map;
  }, [todos]);

  const bookingsByDay = React.useMemo(() => {
    const map = new Map<string, CalendarBooking[]>();
    for (const b of bookings) {
      const key = b.booking_date;
      const arr = map.get(key) ?? [];
      arr.push(b);
      map.set(key, arr);
    }
    return map;
  }, [bookings]);

  // Sorted events for a given yyyy-MM-dd key (shared by the grid and agenda).
  const eventsForKey = React.useCallback(
    (key: string): DayEvent[] => {
      const items = byDay.get(key) ?? [];
      const dayBookings = bookingsByDay.get(key) ?? [];
      return [
        ...items.map(
          (t): DayEvent => ({
            id: t.id,
            type: "todo",
            data: t,
            time: t.due_date ? new Date(t.due_date) : null,
          }),
        ),
        ...dayBookings.map(
          (b): DayEvent => ({
            id: b.id,
            type: "booking",
            data: b,
            time: new Date(`${b.booking_date}T${b.start_time}:00`),
          }),
        ),
      ].sort((a, b) => {
        const aDone = a.type === "todo" && a.data.status === "done";
        const bDone = b.type === "todo" && b.data.status === "done";
        if (aDone && !bDone) return 1;
        if (!aDone && bDone) return -1;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.getTime() - b.time.getTime();
      });
    },
    [byDay, bookingsByDay],
  );

  function openCreate(day: Date) {
    const at = new Date(day);
    at.setHours(9, 0, 0, 0);
    setCreating(at.toISOString());
  }

  const selectedEvents = eventsForKey(format(selected, "yyyy-MM-dd"));
  const selectedIsPast = startOfDay(selected) < today;

  return (
    <div className="glass rounded-3xl border border-white/30 p-3 shadow-xl relative overflow-hidden backdrop-blur-xl saturate-150 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-5">
        <h2 className="text-base font-bold text-slate-800 tracking-tight sm:text-lg">
          {format(month, "MMMM yyyy")}
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setMonth((m) => subMonths(m, 1))}
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/20 bg-white/40 text-slate-600 hover:bg-white/60 transition shadow-sm"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              setMonth(new Date());
              setSelected(startOfDay(new Date()));
            }}
            className="rounded-lg border border-white/20 bg-white/40 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white/60 transition shadow-sm"
          >
            Today
          </button>
          <button
            onClick={() => setMonth((m) => addMonths(m, 1))}
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/20 bg-white/40 text-slate-600 hover:bg-white/60 transition shadow-sm"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="pb-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500/80 sm:pb-2 sm:text-xs"
          >
            <span className="sm:hidden">{d[0]}</span>
            <span className="hidden sm:inline">{d}</span>
          </div>
        ))}

        {days.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const dayEvents = eventsForKey(key);
          const inMonth = isSameMonth(day, month);
          const hasEvents = dayEvents.length > 0;
          const isPastDay = startOfDay(day) < today;
          const isSelected = isSameDay(day, selected);

          return (
            <div
              key={key}
              onClick={() => setSelected(startOfDay(day))}
              role="button"
              tabIndex={0}
              aria-label={format(day, "EEEE, MMMM d")}
              className={cn(
                "group relative cursor-pointer rounded-xl border p-1.5 transition duration-300 ease-in-out sm:rounded-2xl sm:p-2",
                hasEvents
                  ? "min-h-[54px] sm:min-h-[125px]"
                  : "min-h-[54px] sm:min-h-[62px]",
                inMonth
                  ? isPastDay
                    ? "border-slate-200/40 bg-slate-100/40 text-slate-400/80 opacity-60"
                    : "border-white/25 bg-white/35 hover:bg-white/55 hover:border-primary-400 hover:shadow-md"
                  : "border-transparent bg-white/5 opacity-30",
                isSelected &&
                  "ring-2 ring-primary-400 ring-offset-1 ring-offset-white/40 sm:ring-1",
              )}
            >
              <div className="flex items-center justify-between sm:mb-1.5">
                <span
                  className={cn(
                    "grid h-6 w-6 place-items-center rounded-full text-xs font-bold transition-transform group-hover:scale-105",
                    isToday(day)
                      ? "bg-gradient-to-br from-primary-500 to-primary-600 text-white shadow-md font-extrabold"
                      : inMonth
                        ? isPastDay
                          ? "text-slate-400 font-normal"
                          : "text-slate-700"
                        : "text-slate-400/50",
                  )}
                >
                  {format(day, "d")}
                </span>
                {!isPastDay && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openCreate(day);
                    }}
                    className="hidden h-5 w-5 place-items-center rounded-md text-slate-400 opacity-0 transition hover:bg-primary-500/20 hover:text-primary-800 group-hover:opacity-100 sm:grid"
                    aria-label="Add task"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Mobile: compact event dots */}
              {hasEvents && (
                <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
                  {dayEvents.slice(0, 4).map((event) => (
                    <span
                      key={event.id}
                      className={cn("h-1.5 w-1.5 rounded-full", dotClass(event))}
                    />
                  ))}
                  {dayEvents.length > 4 && (
                    <span className="text-[9px] font-bold leading-none text-slate-400">
                      +{dayEvents.length - 4}
                    </span>
                  )}
                </div>
              )}

              {/* Desktop: full event chips */}
              <div className="hidden space-y-1 sm:block">
                {dayEvents.slice(0, 3).map((event) => {
                  if (event.type === "todo") {
                    const t = event.data;
                    return (
                      <button
                        key={t.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(t);
                        }}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-lg text-left transition hover:brightness-95 cursor-pointer",
                          t.status === "done"
                            ? "bg-slate-200/40 text-slate-500/70 line-through text-[10px] py-0.5 px-1.5 font-medium opacity-60"
                            : t.status === "in_progress"
                              ? "bg-amber-500/10 border border-amber-500/25 text-amber-950 text-[11px] py-0.5 px-1.5 font-bold shadow-xs animate-slow-flash"
                              : "bg-primary-500/10 border border-primary-500/20 text-primary-950 text-[11px] py-0.5 px-1.5 font-bold shadow-xs",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            PRIORITY_META[t.priority].dot,
                          )}
                        />
                        <span className="truncate">{t.title}</span>
                      </button>
                    );
                  } else {
                    const b = event.data;
                    return (
                      <div
                        key={b.id}
                        title={`Meeting with ${b.client_name} - ${b.link?.title || "Meeting"}`}
                        className="flex w-full items-center gap-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 text-left text-[11px] font-bold text-cyan-950 truncate shadow-xs"
                      >
                        <Clock className="h-3.5 w-3.5 shrink-0 text-cyan-700" />
                        <span className="truncate">
                          {formatTime12(b.start_time)} {b.client_name}
                        </span>
                      </div>
                    );
                  }
                })}
                {dayEvents.length > 3 && (
                  <p className="px-1.5 text-[10px] font-semibold text-slate-400/90">
                    +{dayEvents.length - 3} more
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile: agenda for the selected day */}
      <div className="mt-4 sm:hidden">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-700">
            {isToday(selected) ? "Today" : format(selected, "EEE, MMM d")}
          </h3>
          {!selectedIsPast && (
            <button
              onClick={() => openCreate(selected)}
              className="flex items-center gap-1 rounded-lg border border-primary-500/30 bg-primary-500/10 px-2.5 py-1 text-xs font-semibold text-primary-800 transition active:scale-95"
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          )}
        </div>

        {selectedEvents.length === 0 ? (
          <p className="rounded-xl border border-white/30 bg-white/30 px-3 py-4 text-center text-xs text-slate-500">
            Nothing scheduled.
          </p>
        ) : (
          <div className="space-y-1.5">
            {selectedEvents.map((event) => {
              if (event.type === "todo") {
                const t = event.data;
                return (
                  <button
                    key={t.id}
                    onClick={() => setEditing(t)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition active:scale-[0.99]",
                      t.status === "done"
                        ? "bg-slate-200/50 text-slate-500 line-through"
                        : t.status === "in_progress"
                          ? "border border-amber-500/30 bg-amber-500/10 text-amber-950 font-semibold"
                          : "border border-primary-500/20 bg-primary-500/10 text-primary-950 font-semibold",
                    )}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        PRIORITY_META[t.priority].dot,
                      )}
                    />
                    <span className="min-w-0 flex-1 break-words">{t.title}</span>
                  </button>
                );
              }
              const b = event.data;
              return (
                <div
                  key={b.id}
                  className="flex w-full items-center gap-2 rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-left text-sm font-semibold text-cyan-950"
                >
                  <Clock className="h-4 w-4 shrink-0 text-cyan-700" />
                  <span className="min-w-0 flex-1 break-words">
                    {formatTime12(b.start_time)} · {b.client_name}
                    {b.link?.title ? ` (${b.link.title})` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TodoFormModal
        open={!!editing || !!creating}
        onClose={() => {
          setEditing(null);
          setCreating(null);
        }}
        members={members}
        todo={editing}
        defaultDue={creating}
      />
    </div>
  );
}
