"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { Client, WebsiteProject, WebsiteStatus } from "@/lib/types";

import { saveWebsiteProject, type WebsiteProjectInput } from "./actions";

export function WebsiteFormModal({
  open,
  onClose,
  site,
  clients,
}: {
  open: boolean;
  onClose: () => void;
  site?: WebsiteProject | null;
  clients: Pick<Client, "id" | "name" | "company">[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<WebsiteProjectInput>({
    name: "",
    url: "",
    progress: 0,
    status: "in_progress",
  });

  React.useEffect(() => {
    if (!open) return;
    setForm(
      site
        ? {
            id: site.id,
            name: site.name,
            url: site.url,
            client_id: site.client_id,
            progress: site.progress,
            status: site.status,
            notes: site.notes ?? "",
          }
        : {
            name: "",
            url: "",
            client_id: null,
            progress: 0,
            status: "in_progress",
            notes: "",
          },
    );
  }, [open, site]);

  function set<K extends keyof WebsiteProjectInput>(
    k: K,
    v: WebsiteProjectInput[K],
  ) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function submit() {
    startTransition(async () => {
      const res = await saveWebsiteProject(form);
      if (res.ok) {
        toast.success(site ? "Website updated" : "Website added");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  const progress = form.progress ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={site ? "Edit website" : "Add website"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {site ? "Save changes" : "Add website"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Site name" required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Acme Co. website"
            autoFocus
          />
        </Field>

        <Field label="Website URL" required hint="Staging or live link — https:// added automatically.">
          <Input
            value={form.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="acme.com"
            inputMode="url"
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
              value={form.status ?? "in_progress"}
              onChange={(e) => set("status", e.target.value as WebsiteStatus)}
            >
              <option value="in_progress">In progress</option>
              <option value="waiting_client">Waiting on client</option>
              <option value="launched">Launched (live)</option>
            </Select>
          </Field>
        </div>

        <Field label={`Progress — ${progress}%`}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={progress}
              onChange={(e) => set("progress", Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-primary-500"
            />
            <Input
              type="number"
              min={0}
              max={100}
              value={progress}
              onChange={(e) =>
                set(
                  "progress",
                  Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                )
              }
              className="w-20"
            />
          </div>
        </Field>

        <Field
          label="Notes"
          hint="What's outstanding, or what you're waiting on from the client."
        >
          <Textarea
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            placeholder="Waiting on logo files and homepage copy…"
          />
        </Field>
      </div>
    </Modal>
  );
}
