"use client";

/**
 * The project's tasks (LOOP-4) and what waits on what (PLAN-11).
 *
 * `todos.project_id` has existed since 0022 and no screen ever showed it, so
 * linking a task to a project had no payoff anywhere. This is that payoff: the
 * work lives on the project, and a task can say what it's waiting for so a
 * launch date stops being a guess.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format, isBefore, startOfToday } from "date-fns";
import {
  CheckCircle2,
  Circle,
  Link2,
  ListChecks,
  Lock,
  Plus,
  Trash2,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { MemberLite, TodoPriority } from "@/lib/types";
import { cn } from "@/lib/utils";

import { deleteTodo, saveTodo, setTodoStatus } from "@/app/(app)/todos/actions";
import { setTaskDependency } from "@/app/(app)/projects/plan-actions";

export type ProjectTask = {
  id: string;
  title: string;
  status: string;
  priority: TodoPriority;
  due_date: string | null;
  assigned_to: string | null;
  depends_on_id: string | null;
};

export function TasksSection({
  projectId,
  tasks,
  members,
}: {
  projectId: string;
  tasks: ProjectTask[];
  members: MemberLite[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState("");
  const [due, setDue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [linking, setLinking] = React.useState<ProjectTask | null>(null);

  const byId = React.useMemo(
    () => new Map(tasks.map((t) => [t.id, t])),
    [tasks],
  );
  const memberById = React.useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  );

  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  /** A task can't be started while the thing it waits for is still open. */
  const isBlocked = (task: ProjectTask): ProjectTask | null => {
    if (!task.depends_on_id) return null;
    const dep = byId.get(task.depends_on_id);
    return dep && dep.status !== "done" ? dep : null;
  };

  async function add() {
    if (!title.trim()) return;
    setSaving(true);
    const res = await saveTodo({
      title,
      project_id: projectId,
      assigned_to: assignee || null,
      due_date: due ? `${due}T17:00:00` : null,
    });
    setSaving(false);
    if (res.ok) {
      setTitle("");
      setDue("");
      setAdding(false);
      toast.success("Task added");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  async function toggle(task: ProjectTask) {
    const blocker = isBlocked(task);
    if (blocker && task.status !== "done") {
      toast.error(`Waiting on "${blocker.title}"`);
      return;
    }
    const res = await setTodoStatus(task.id, task.status === "done" ? "todo" : "done");
    if (res.ok) router.refresh();
    else toast.error(res.error);
  }

  async function link(dependsOnId: string | null) {
    if (!linking) return;
    const res = await setTaskDependency(linking.id, dependsOnId, projectId);
    if (res.ok) {
      setLinking(null);
      toast.success(dependsOnId ? "Dependency set" : "Dependency cleared");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  const renderTask = (task: ProjectTask) => {
    const blocker = isBlocked(task);
    const assignee = task.assigned_to ? memberById.get(task.assigned_to) : null;
    const overdue =
      task.status !== "done" &&
      task.due_date &&
      isBefore(new Date(task.due_date), startOfToday());

    return (
      <li
        key={task.id}
        className="group flex items-start gap-3 px-5 py-3 transition hover:bg-slate-50/70"
      >
        <button
          type="button"
          onClick={() => toggle(task)}
          className="mt-0.5 shrink-0 text-slate-300 transition hover:text-emerald-500"
          aria-label={task.status === "done" ? "Reopen task" : "Mark done"}
        >
          {task.status === "done" ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : blocker ? (
            <Lock className="h-5 w-5 text-amber-400" />
          ) : (
            <Circle className="h-5 w-5" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-sm",
              task.status === "done"
                ? "text-slate-400 line-through"
                : "text-slate-800",
            )}
          >
            {task.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            {task.due_date && (
              <span className={cn(overdue && "font-semibold text-rose-500")}>
                {overdue ? "Overdue " : "Due "}
                {format(new Date(task.due_date), "d MMM")}
              </span>
            )}
            {blocker && (
              <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                Waiting on {blocker.title}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {assignee && (
            <Avatar
              name={assignee.full_name}
              src={assignee.avatar_url}
              size="sm"
            />
          )}
          <button
            type="button"
            onClick={() => setLinking(task)}
            title="What does this wait for?"
            className="text-slate-300 opacity-0 transition hover:text-primary-600 group-hover:opacity-100"
          >
            <Link2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={async () => {
              const res = await deleteTodo(task.id);
              if (res.ok) router.refresh();
              else toast.error(res.error);
            }}
            title="Delete task"
            className="text-slate-300 opacity-0 transition hover:text-rose-600 group-hover:opacity-100"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </li>
    );
  };

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-violet-50 text-violet-500">
            <ListChecks className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Tasks</h2>
            <p className="text-xs text-slate-400">
              {open.length} open · {done.length} done
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add task
        </Button>
      </div>

      {tasks.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          No tasks yet. Add them by hand, or apply a template to seed the whole
          plan at once.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {open.map(renderTask)}
          {done.map(renderTask)}
        </ul>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a task"
        footer={
          <>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={add} loading={saving}>
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="What needs doing" required>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Build the contact page"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Assign to">
              <Select
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Nobody yet</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due">
              <Input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!linking}
        onClose={() => setLinking(null)}
        title="What does this wait for?"
        description={linking?.title}
        footer={
          <Button variant="outline" onClick={() => setLinking(null)}>
            Close
          </Button>
        }
      >
        <Field label="Blocked by">
          <Select
            value={linking?.depends_on_id ?? ""}
            onChange={(e) => link(e.target.value || null)}
          >
            <option value="">Nothing — can start any time</option>
            {tasks
              .filter((t) => t.id !== linking?.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </Select>
        </Field>
      </Modal>
    </section>
  );
}
