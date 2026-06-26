"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { differenceInCalendarDays, format } from "date-fns";
import { CalendarClock, FolderKanban, ListChecks } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { PRIORITY_META } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { TodoWithRelations } from "@/lib/types";

/** Short, human due label, e.g. "Today", "Tomorrow", "3d overdue", "Mar 4". */
export function dueMeta(due: string) {
  const d = new Date(due);
  const days = differenceInCalendarDays(d, new Date());
  let label: string;
  if (days === 0) label = "Today";
  else if (days === 1) label = "Tomorrow";
  else if (days === -1) label = "Yesterday";
  else if (days < 0) label = `${Math.abs(days)}d overdue`;
  else if (days <= 6) label = format(d, "EEE");
  else label = format(d, "MMM d");
  return { label, overdue: days < 0 };
}

export function TodoCardContent({
  todo,
  dragging,
  onClick,
}: {
  todo: TodoWithRelations;
  dragging?: boolean;
  onClick?: () => void;
}) {
  const done = todo.status === "done";
  const subtasks = todo.subtasks ?? [];
  const subDone = subtasks.filter((s) => s.is_done).length;
  const due = todo.due_date ? dueMeta(todo.due_date) : null;

  return (
    <div
      onClick={onClick}
      className={cn(
        "group cursor-pointer rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-[0_4px_20px_rgb(0,0,0,0.03)] transition-all duration-200",
        dragging
          ? "rotate-2 scale-[1.03] shadow-xl border-primary-300 ring-4 ring-primary-100/30"
          : "hover:border-primary-300 hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] hover:-translate-y-0.5",
        done && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            PRIORITY_META[todo.priority].dot,
          )}
          title={`${PRIORITY_META[todo.priority].label} priority`}
        />
        <p
          className={cn(
            "text-[13px] font-semibold leading-snug tracking-tight text-slate-800 group-hover:text-primary-600",
            done && "text-slate-400 line-through",
          )}
        >
          {todo.title}
        </p>
      </div>

      {todo.project && (
        <span className="mt-2 inline-flex max-w-full items-center gap-1 rounded-lg bg-primary-50 px-2 py-0.5 text-[10px] font-semibold text-primary-600">
          <FolderKanban className="h-3 w-3 shrink-0" />
          <span className="truncate">{todo.project.name}</span>
        </span>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-400">
        {due && (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-medium",
              due.overdue && !done && "text-rose-500",
            )}
          >
            <CalendarClock className="h-3.5 w-3.5" />
            {due.label}
          </span>
        )}
        {subtasks.length > 0 && (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-medium",
              subDone === subtasks.length && "text-emerald-500",
            )}
          >
            <ListChecks className="h-3.5 w-3.5" />
            {subDone}/{subtasks.length}
          </span>
        )}
        {todo.assignee && (
          <span className="ml-auto">
            <Avatar
              name={todo.assignee.full_name}
              src={todo.assignee.avatar_url}
              size="xs"
            />
          </span>
        )}
      </div>
    </div>
  );
}

export function SortableTodoCard({
  todo,
  onClick,
}: {
  todo: TodoWithRelations;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: todo.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      {...attributes}
      {...listeners}
      className="touch-none"
    >
      <TodoCardContent todo={todo} onClick={onClick} />
    </div>
  );
}
