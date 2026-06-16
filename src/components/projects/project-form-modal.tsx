"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Wallet, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { Client, Project, ProjectStatus } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";

import { saveProject, type ProjectInput } from "@/app/(app)/projects/actions";
import { ClientFormModal } from "@/app/(app)/clients/clients-view";

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
  const [isAddingClient, setIsAddingClient] = React.useState(false);

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
            total_value: project.total_value ?? 0,
            deposit_paid: project.deposit_paid ?? 0,
            service_type: project.service_type ?? null,
          }
        : { name: "", status: "planning", currency: "LKR", total_value: 0, deposit_paid: 0, service_type: null },
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
      size="lg"
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
            rows={2}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <Field label="Client" className="sm:col-span-2">
            <div className="flex gap-2">
              <Select
                value={form.client_id ?? ""}
                onChange={(e) => set("client_id", e.target.value || null)}
                className="flex-grow"
              >
                <option value="">No client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company ? ` · ${c.company}` : ""}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddingClient(true)}
                className="px-3"
                title="Add new client"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </Field>

          <Field label="Status" className="sm:col-span-1">
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

          <Field label="Service Type" className="sm:col-span-1">
            <Select
              value={form.service_type ?? ""}
              onChange={(e) => set("service_type", e.target.value || null)}
            >
              <option value="">Select type</option>
              <option value="business_website">Business Website</option>
              <option value="ecommerce_website">E-commerce Website</option>
              <option value="social_media_marketing">Social Media Marketing</option>
            </Select>
          </Field>

          <Field label="Total Value" className="sm:col-span-1">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.total_value ?? ""}
              onChange={(e) =>
                set("total_value", e.target.value ? Number(e.target.value) : 0)
              }
              placeholder="0.00"
            />
          </Field>

          <Field label="Deposit Paid" className="sm:col-span-1">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.deposit_paid ?? ""}
              onChange={(e) =>
                set("deposit_paid", e.target.value ? Number(e.target.value) : 0)
              }
              placeholder="0.00"
            />
          </Field>

          <div className="sm:col-span-2 rounded-2xl bg-slate-50 border border-slate-200/80 p-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-500/10 text-primary-600">
                <Wallet className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Wallet Indicator</p>
                <p className="text-[11px] font-medium text-slate-400">Balance to pay</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-base font-extrabold text-slate-800">
                {formatCurrency(
                  Math.max(0, (form.total_value ?? 0) - (form.deposit_paid ?? 0)),
                  form.currency || "LKR"
                )}
              </p>
            </div>
          </div>

          <Field label="Currency" className="sm:col-span-2">
            <Input
              value={form.currency ?? "USD"}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
              maxLength={3}
            />
          </Field>

          <Field label="Start date" className="sm:col-span-1">
            <Input
              type="date"
              value={form.start_date ?? ""}
              onChange={(e) => set("start_date", e.target.value || null)}
            />
          </Field>

          <Field label="Due date" className="sm:col-span-1">
            <Input
              type="date"
              value={form.due_date ?? ""}
              onChange={(e) => set("due_date", e.target.value || null)}
            />
          </Field>
        </div>
      </div>
      <ClientFormModal
        open={isAddingClient}
        client={null}
        onClose={() => setIsAddingClient(false)}
        onSaved={(newClient) => {
          if (newClient?.id) {
            set("client_id", newClient.id);
          }
          router.refresh();
        }}
      />
    </Modal>
  );
}
