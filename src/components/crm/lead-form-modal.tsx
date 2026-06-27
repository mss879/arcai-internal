"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { Client, Lead, MemberLite, PipelineStage } from "@/lib/types";

import { saveLead, type LeadInput } from "@/app/(app)/crm/actions";

export function LeadFormModal({
  open,
  onClose,
  pipelineId,
  stages,
  defaultStageId,
  members,
  clients,
  lead,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  members: MemberLite[];
  clients: Pick<Client, "id" | "name" | "company">[];
  lead?: Lead | null;
  onDelete?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<LeadInput>({
    pipeline_id: pipelineId,
    stage_id: defaultStageId ?? stages[0]?.id ?? "",
    title: "",
  });

  React.useEffect(() => {
    if (!open) return;
    setForm(
      lead
        ? {
            id: lead.id,
            pipeline_id: pipelineId,
            stage_id: lead.stage_id ?? stages[0]?.id ?? "",
            title: lead.title,
            company: lead.company ?? "",
            contact_name: lead.contact_name ?? "",
            contact_email: lead.contact_email ?? "",
            contact_phone: lead.contact_phone ?? "",
            value: lead.value,
            currency: lead.currency,
            notes: lead.notes ?? "",
            assigned_to: lead.assigned_to,
            client_id: lead.client_id,
          }
        : {
            pipeline_id: pipelineId,
            stage_id: defaultStageId ?? stages[0]?.id ?? "",
            title: "",
            currency: "LKR",
          },
    );
  }, [open, lead, pipelineId, defaultStageId, stages]);

  function set<K extends keyof LeadInput>(k: K, v: LeadInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    startTransition(async () => {
      const res = await saveLead(form);
      if (res.ok) {
        toast.success(lead ? "Lead updated" : "Lead added");
        router.refresh();
        onClose();
      } else toast.error(res.error);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={lead ? "Edit lead" : "New lead"}
      size="lg"
      footer={
        <>
          {lead && onDelete && (
            <Button
              variant="ghost"
              onClick={onDelete}
              disabled={pending}
              className="mr-auto text-rose-600 hover:bg-rose-50 hover:text-rose-700"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {lead ? "Save changes" : "Add lead"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Deal / opportunity name"
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Company">
            <Input
              value={form.company ?? ""}
              onChange={(e) => set("company", e.target.value)}
            />
          </Field>
          <Field label="Value">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.value ?? ""}
              onChange={(e) =>
                set("value", e.target.value ? Number(e.target.value) : null)
              }
              placeholder="0.00"
            />
          </Field>
          <Field label="Contact name">
            <Input
              value={form.contact_name ?? ""}
              onChange={(e) => set("contact_name", e.target.value)}
            />
          </Field>
          <Field label="Contact email">
            <Input
              type="email"
              value={form.contact_email ?? ""}
              onChange={(e) => set("contact_email", e.target.value)}
            />
          </Field>
          <Field label="Contact phone">
            <Input
              value={form.contact_phone ?? ""}
              onChange={(e) => set("contact_phone", e.target.value)}
            />
          </Field>
          <Field label="Stage">
            <Select
              value={form.stage_id}
              onChange={(e) => set("stage_id", e.target.value)}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assign to">
            <Select
              value={form.assigned_to ?? ""}
              onChange={(e) => set("assigned_to", e.target.value || null)}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || m.username}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Link client">
            <Select
              value={form.client_id ?? ""}
              onChange={(e) => set("client_id", e.target.value || null)}
            >
              <option value="">No client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Notes">
          <Textarea
            rows={3}
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
