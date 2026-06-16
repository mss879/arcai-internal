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
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { TodoFormModal } from "@/components/todos/todo-form-modal";
import { PRIORITY_META } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { MemberLite, Todo } from "@/lib/types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Calendar({
  todos,
  members,
}: {
  todos: Todo[];
  members: MemberLite[];
}) {
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

  function openCreate(day: Date) {
    const at = new Date(day);
    at.setHours(9, 0, 0, 0);
    setCreating(at.toISOString());
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">
          {format(month, "MMMM yyyy")}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMonth((m) => subMonths(m, 1))}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => setMonth(new Date())}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
          >
            Today
          </button>
          <button
            onClick={() => setMonth((m) => addMonths(m, 1))}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            {d}
          </div>
        ))}

        {days.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const items = byDay.get(key) ?? [];
          const inMonth = isSameMonth(day, month);
          return (
            <div
              key={key}
              className={cn(
                "group relative min-h-[88px] rounded-xl border p-1.5 transition",
                inMonth
                  ? "border-slate-100 bg-white hover:border-primary-200"
                  : "border-transparent bg-slate-50/50",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "grid h-6 w-6 place-items-center rounded-full text-xs font-medium",
                    isToday(day)
                      ? "bg-primary-600 text-white"
                      : inMonth
                        ? "text-slate-600"
                        : "text-slate-300",
                  )}
                >
                  {format(day, "d")}
                </span>
                <button
                  onClick={() => openCreate(day)}
                  className="grid h-5 w-5 place-items-center rounded-md text-slate-300 opacity-0 transition hover:bg-primary-50 hover:text-primary-600 group-hover:opacity-100"
                  aria-label="Add task"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="mt-1 space-y-1">
                {items.slice(0, 3).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setEditing(t)}
                    className={cn(
                      "flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium transition hover:brightness-95",
                      t.status === "done"
                        ? "bg-slate-100 text-slate-400 line-through"
                        : "bg-primary-50 text-primary-700",
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
                ))}
                {items.length > 3 && (
                  <p className="px-1.5 text-[10px] font-medium text-slate-400">
                    +{items.length - 3} more
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
