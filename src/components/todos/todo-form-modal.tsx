"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { MentionTextarea } from "@/components/ui/mention-textarea";
import { Modal } from "@/components/ui/modal";
import { PRIORITY_META } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { MemberLite, Todo, TodoPriority, TodoStatus } from "@/lib/types";

import { saveTodo, type TodoInput } from "@/app/(app)/todos/actions";

const PRIORITIES: TodoPriority[] = ["low", "medium", "high", "urgent"];

function toLocalInput(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function TodoFormModal({
  open,
  onClose,
  members,
  todo,
  defaultDue,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  members: MemberLite[];
  todo?: Todo | null;
  defaultDue?: string | null;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priority, setPriority] = React.useState<TodoPriority>("medium");
  const [status, setStatus] = React.useState<TodoStatus>("todo");
  const [assignee, setAssignee] = React.useState("");
  const [due, setDue] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setTitle(todo?.title ?? "");
    setDescription(todo?.description ?? "");
    setPriority(todo?.priority ?? "medium");
    setStatus(todo?.status ?? "todo");
    setAssignee(todo?.assigned_to ?? "");
    setDue(toLocalInput(todo?.due_date ?? defaultDue ?? null));
  }, [open, todo, defaultDue]);

  function submit() {
    if (!title.trim()) {
      toast.error("Give the task a title.");
      return;
    }
    const input: TodoInput = {
      id: todo?.id,
      title,
      description,
      priority,
      status,
      assigned_to: assignee || null,
      due_date: due ? new Date(due).toISOString() : null,
    };
    startTransition(async () => {
      const res = await saveTodo(input);
      if (res.ok) {
        toast.success(todo ? "Task updated" : "Task created");
        onSaved?.();
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={todo ? "Edit task" : "New task"}
      description="Use @ to mention a teammate. Add a due date to put it on the calendar."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {todo ? "Save changes" : "Create task"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            autoFocus
          />
        </Field>

        <Field label="Details">
          <MentionTextarea
            value={description}
            onChange={setDescription}
            members={members}
            placeholder="Add details… mention people with @"
          />
        </Field>

        <Field label="Priority">
          <div className="grid grid-cols-4 gap-2">
            {PRIORITIES.map((p) => {
              const meta = PRIORITY_META[p];
              const activeState = priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-medium transition",
                    activeState
                      ? "border-primary-300 bg-primary-50 text-primary-700 ring-2 ring-primary-100"
                      : "border-slate-200 text-slate-500 hover:bg-slate-50",
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Assign to">
            <Select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || m.username}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Due date">
            <Input
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
        </div>

        {todo && (
          <Field label="Status">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as TodoStatus)}
            >
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </Select>
          </Field>
        )}

        {assignee && (
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <Avatar
              name={
                members.find((m) => m.id === assignee)?.full_name ?? "User"
              }
              size="xs"
            />
            Assigned to{" "}
            <span className="font-medium text-slate-700">
              {members.find((m) => m.id === assignee)?.full_name}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
