"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { Client, Project, ProjectStatus } from "@/lib/types";

import { saveProject, type ProjectInput } from "@/app/(app)/projects/actions";

export function ProjectFormModal({
  open,
  onClose,
  project,
  clients,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  clients: Pick<Client, "id" | "name" | "company">[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<ProjectInput>({ name: "" });

  React.useEffect(() => {
    if (!open) return;
    setForm(
      project
        ? {
            id: project.id,
            name: project.name,
            description: project.description ?? "",
            client_id: project.client_id,
            status: project.status,
            budget: project.budget,
            currency: project.currency,
            start_date: project.start_date,
            due_date: project.due_date,
          }
        : { name: "", status: "planning", currency: "USD" },
    );
  }, [open, project]);

  function set<K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    startTransition(async () => {
      const res = await saveProject(form);
      if (res.ok) {
        toast.success(project ? "Project updated" : "Project created");
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
      title={project ? "Edit project" : "New project"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Project name" required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Website redesign"
            autoFocus
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={form.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Client">
            <Select
              value={form.client_id ?? ""}
              onChange={(e) => set("client_id", e.target.value || null)}
            >
              <option value="">No client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` · ${c.company}` : ""}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Status">
            <Select
              value={form.status ?? "planning"}
              onChange={(e) => set("status", e.target.value as ProjectStatus)}
            >
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>

          <Field label="Budget">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.budget ?? ""}
              onChange={(e) =>
                set("budget", e.target.value ? Number(e.target.value) : null)
              }
              placeholder="0.00"
            />
          </Field>

          <Field label="Currency">
            <Input
              value={form.currency ?? "USD"}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
              maxLength={3}
            />
          </Field>

          <Field label="Start date">
            <Input
              type="date"
              value={form.start_date ?? ""}
              onChange={(e) => set("start_date", e.target.value || null)}
            />
          </Field>

          <Field label="Due date">
            <Input
              type="date"
              value={form.due_date ?? ""}
              onChange={(e) => set("due_date", e.target.value || null)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
