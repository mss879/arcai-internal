"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { format, isPast } from "date-fns";
import { toast } from "sonner";
import {
  CalendarClock,
  Check,
  ListChecks,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dropdown, DropdownItem } from "@/components/ui/dropdown";
import { EmptyState } from "@/components/ui/empty-state";
import { MentionText } from "@/components/ui/mention-text";
import { PageHeader } from "@/components/ui/page-header";
import { TodoFormModal } from "@/components/todos/todo-form-modal";
import { PRIORITY_META, TODO_STATUS_META } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { MemberLite, TodoStatus, TodoWithRelations } from "@/lib/types";

import { deleteTodo, setTodoStatus } from "./actions";

const FILTERS: { key: TodoStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

export function TodosView({
  todos,
  members,
}: {
  todos: TodoWithRelations[];
  members: MemberLite[];
}) {
  const router = useRouter();
  const [items, setItems] = React.useState(todos);
  const [filter, setFilter] = React.useState<TodoStatus | "all">("all");
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<TodoWithRelations | null>(null);
  const [toDelete, setToDelete] = React.useState<TodoWithRelations | null>(null);

  React.useEffect(() => setItems(todos), [todos]);

  const visible = items
    .filter((t) => filter === "all" || t.status === filter)
    .sort((a, b) => {
      if (a.status === "done" && b.status !== "done") return 1;
      if (b.status === "done" && a.status !== "done") return -1;
      return PRIORITY_META[a.priority].order - PRIORITY_META[b.priority].order;
    });

  async function toggle(t: TodoWithRelations) {
    const next: TodoStatus = t.status === "done" ? "todo" : "done";
    setItems((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)),
    );
    const res = await setTodoStatus(t.id, next);
    if (!res.ok) {
      toast.error(res.error);
      setItems(todos);
    } else {
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="To-Dos"
        description="Shared tasks with priority, @mentions and calendar due dates."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New task
          </Button>
        }
      />

      <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-lg px-3.5 py-1.5 text-sm font-medium transition",
              filter === f.key
                ? "bg-primary-600 text-white shadow-sm"
                : "text-slate-500 hover:text-slate-800",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-6 w-6" />}
          title="Nothing here yet"
          description="Create a task and assign it to a teammate."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New task
            </Button>
          }
        />
      ) : (
        <div className="space-y-2.5">
          <AnimatePresence initial={false}>
            {visible.map((t) => {
              const done = t.status === "done";
              const overdue =
                !done && t.due_date && isPast(new Date(t.due_date));
              return (
                <motion.div
                  key={t.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.18 }}
                  className="group flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-soft)]"
                >
                  <button
                    onClick={() => toggle(t)}
                    className={cn(
                      "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 transition",
                      done
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : "border-slate-300 hover:border-primary-400",
                    )}
                    aria-label="Toggle complete"
                  >
                    {done && <Check className="h-3 w-3" strokeWidth={3} />}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn("h-2 w-2 rounded-full", PRIORITY_META[t.priority].dot)}
                        title={`${PRIORITY_META[t.priority].label} priority`}
                      />
                      <p
                        className={cn(
                          "font-medium text-slate-900",
                          done && "text-slate-400 line-through",
                        )}
                      >
                        {t.title}
                      </p>
                      {t.status === "in_progress" && (
                        <Badge className={TODO_STATUS_META.in_progress.badge}>
                          In progress
                        </Badge>
                      )}
                    </div>

                    {t.description && (
                      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-slate-500">
                        <MentionText text={t.description} />
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                      {t.due_date && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1",
                            overdue && "font-medium text-rose-500",
                          )}
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                          {format(new Date(t.due_date), "MMM d, p")}
                          {overdue && " · overdue"}
                        </span>
                      )}
                      {t.assignee && (
                        <span className="inline-flex items-center gap-1.5">
                          <Avatar
                            name={t.assignee.full_name}
                            src={t.assignee.avatar_url}
                            size="xs"
                          />
                          {t.assignee.full_name || t.assignee.username}
                        </span>
                      )}
                    </div>
                  </div>

                  <Dropdown
                    trigger={
                      <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    }
                  >
                    <DropdownItem
                      icon={<Pencil className="h-4 w-4" />}
                      onClick={() => setEditing(t)}
                    >
                      Edit
                    </DropdownItem>
                    <DropdownItem
                      destructive
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setToDelete(t)}
                    >
                      Delete
                    </DropdownItem>
                  </Dropdown>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      <TodoFormModal
        open={creating || !!editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        members={members}
        todo={editing}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete task"
        description={`Delete "${toDelete?.title}"?`}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await deleteTodo(toDelete.id);
          if (res.ok) {
            toast.success("Task deleted");
            router.refresh();
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}
