"use client";

import * as React from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
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

  function openCreate(day: Date) {
    const at = new Date(day);
    at.setHours(9, 0, 0, 0);
    setCreating(at.toISOString());
  }

  return (
    <div className="glass rounded-3xl border border-white/30 p-6 shadow-xl relative overflow-hidden backdrop-blur-xl saturate-150">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-800 tracking-tight">
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
            onClick={() => setMonth(new Date())}
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

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="pb-2 text-center text-xs font-bold uppercase tracking-wider text-slate-500/80"
          >
            {d}
          </div>
        ))}

        {days.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const items = byDay.get(key) ?? [];
          const dayBookings = bookingsByDay.get(key) ?? [];
          const inMonth = isSameMonth(day, month);

          const dayEvents = [
            ...items.map((t) => ({
              id: t.id,
              type: "todo" as const,
              data: t,
              time: t.due_date ? new Date(t.due_date) : null,
            })),
            ...dayBookings.map((b) => ({
              id: b.id,
              type: "booking" as const,
              data: b,
              time: new Date(`${b.booking_date}T${b.start_time}:00`),
            })),
          ].sort((a, b) => {
            const aDone = a.type === "todo" && a.data.status === "done";
            const bDone = b.type === "todo" && b.data.status === "done";

            if (aDone && !bDone) return 1;
            if (!aDone && bDone) return -1;

            if (!a.time) return 1;
            if (!b.time) return -1;
            return a.time.getTime() - b.time.getTime();
          });
          const hasEvents = dayEvents.length > 0;
          const isPastDay = startOfDay(day) < today;

          return (
            <div
              key={key}
              className={cn(
                "group relative rounded-2xl border p-2 transition duration-300 ease-in-out",
                hasEvents ? "min-h-[125px]" : "min-h-[62px]",
                inMonth
                  ? isPastDay
                    ? "border-slate-200/40 bg-slate-100/40 text-slate-400/80 opacity-60"
                    : "border-white/25 bg-white/35 hover:bg-white/55 hover:border-primary-400 hover:shadow-md"
                  : "border-transparent bg-white/5 opacity-30",
              )}
            >
              <div className="flex items-center justify-between mb-1.5">
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
                    onClick={() => openCreate(day)}
                    className="grid h-5 w-5 place-items-center rounded-md text-slate-400 opacity-0 transition hover:bg-primary-500/20 hover:text-primary-800 group-hover:opacity-100"
                    aria-label="Add task"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="space-y-1">
                {dayEvents.slice(0, 3).map((event) => {
                  if (event.type === "todo") {
                    const t = event.data;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setEditing(t)}
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
