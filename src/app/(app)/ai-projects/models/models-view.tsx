"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarClock, Plus, Trash2 } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import type { AiModelKind, AiModelPrice } from "@/lib/types";
import { cn } from "@/lib/utils";

import { addModelPrice, deleteModelPrice, endModelPrice, setModelActive, type ModelPriceInput } from "./actions";

function price(n: number): string {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export function ModelsView({ rows, inUse, today }: { rows: AiModelPrice[]; inUse: Record<string, number>; today: string }) {
  const [adding, setAdding] = React.useState(false);
  const [ending, setEnding] = React.useState<AiModelPrice | null>(null);
  // The end date lives here rather than in the modal: opening the modal is
  // what resets it, and that is an event, not an effect.
  const [endDate, setEndDate] = React.useState(today);
  const [deleting, setDeleting] = React.useState<AiModelPrice | null>(null);

  const byModel = new Map<string, AiModelPrice[]>();
  for (const r of rows) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  const models = Array.from(byModel.entries()).sort(([a], [b]) => a.localeCompare(b));

  const current = (list: AiModelPrice[]) =>
    list.find((r) => r.effective_from <= today && (!r.effective_to || r.effective_to >= today)) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI model prices"
        description="USD per million tokens, as OpenAI lists them. A price change is a new dated row — old usage keeps the price it was costed with."
        actions={
          <>
            <Link href="/ai-projects" className="text-sm text-slate-500 hover:text-slate-900">
              ← AI projects
            </Link>
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add price
            </Button>
          </>
        }
      />

      <Alert variant="info">
        Check{" "}
        <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer" className="font-medium underline">
          OpenAI&apos;s pricing page
        </a>{" "}
        when a model launches or a promotion ends. Cached input is the discounted rate for a repeated prompt prefix; the
        agent&apos;s prompt is laid out so most of it qualifies.
      </Alert>

      {models.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-slate-500">
            No prices yet. Apply migration 0126 to seed the catalog, or add a model above.
          </CardContent>
        </Card>
      )}

      {models.map(([model, list]) => {
        const now = current(list);
        const active = list.some((r) => r.is_active);
        const projects = inUse[model] ?? 0;
        return (
          <Card key={model}>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{model}</span>
                  {list[0]?.label && <span className="text-sm font-normal text-slate-500">{list[0].label}</span>}
                  <Badge className={list[0]?.kind === "embedding" ? "bg-sky-50 text-sky-700 ring-sky-100" : "bg-primary-50 text-primary-700 ring-primary-100"}>
                    {list[0]?.kind}
                  </Badge>
                  {!active && <Badge>Retired</Badge>}
                  {projects > 0 && (
                    <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-100">
                      {projects} project{projects === 1 ? "" : "s"}
                    </Badge>
                  )}
                </CardTitle>
                <p className="mt-1 text-sm text-slate-500">
                  {now
                    ? `Today: ${price(now.input_per_m)} in · ${price(now.cached_input_per_m)} cached · ${price(now.output_per_m)} out`
                    : "No price covers today — usage on this model records at $0 until one does."}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (active && projects > 0 && !confirm(`${projects} project(s) use ${model}. They will fall back to the default model. Retire anyway?`)) return;
                  const res = await setModelActive(model, !active);
                  if (res.ok) toast.success(active ? "Retired" : "Available again");
                  else toast.error(res.error);
                }}
              >
                {active ? "Retire" : "Make available"}
              </Button>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 font-semibold">Effective</th>
                    <th className="py-2 font-semibold">Input</th>
                    <th className="py-2 font-semibold">Cached input</th>
                    <th className="py-2 font-semibold">Output</th>
                    <th className="py-2 font-semibold">Note</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const isNow = now?.id === r.id;
                    return (
                      <tr key={r.id} className={cn("border-t border-slate-100", isNow && "bg-primary-50/40")}>
                        <td className="py-2 pr-3 text-slate-700">
                          {r.effective_from} → {r.effective_to ?? "open"}
                          {isNow && <span className="ml-2 text-[11px] font-semibold uppercase text-primary-700">current</span>}
                        </td>
                        <td className="py-2 pr-3">{price(r.input_per_m)}</td>
                        <td className="py-2 pr-3">{price(r.cached_input_per_m)}</td>
                        <td className="py-2 pr-3">{price(r.output_per_m)}</td>
                        <td className="py-2 pr-3 text-slate-500">{r.note ?? ""}</td>
                        <td className="py-2 text-right">
                          <div className="inline-flex gap-1">
                            {!r.effective_to && (
                              <button
                                type="button"
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                aria-label="End this price"
                                onClick={() => {
                                  setEnding(r);
                                  setEndDate(today);
                                }}
                              >
                                <CalendarClock className="h-4 w-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              aria-label="Delete this price"
                              onClick={() => setDeleting(r)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}

      <AddPriceModal open={adding} onClose={() => setAdding(false)} knownModels={models.map(([m]) => m)} today={today} />

      <EndPriceModal row={ending} date={endDate} onDate={setEndDate} onClose={() => setEnding(null)} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this price row?"
        description="Usage already recorded keeps the prices it was costed with. Only this catalog row goes."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteModelPrice(deleting.id);
          if (res.ok) toast.success("Deleted");
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

function AddPriceModal({ open, onClose, knownModels, today }: { open: boolean; onClose: () => void; knownModels: string[]; today: string }) {
  const [form, setForm] = React.useState<ModelPriceInput>({
    model: "",
    kind: "chat",
    label: "",
    inputPerM: 0,
    cachedPerM: 0,
    outputPerM: 0,
    effectiveFrom: today,
    effectiveTo: "",
    note: "",
  });
  const [saving, setSaving] = React.useState(false);
  const set = <K extends keyof ModelPriceInput>(key: K, value: ModelPriceInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await addModelPrice(form);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.closedPrevious ? "Price added — the previous price was ended the day before." : "Price added");
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a price"
      description="A new dated row. If the model already has an open-ended price, it ends the day before this one starts."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="add-price" loading={saving}>
            Add price
          </Button>
        </>
      }
    >
      <form id="add-price" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Model id" required hint="Exactly as OpenAI names it.">
            <Input list="known-models" value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="gpt-5.6-luna" />
            <datalist id="known-models">
              {knownModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => set("kind", e.target.value as AiModelKind)}>
              <option value="chat">Chat</option>
              <option value="embedding">Embedding</option>
            </Select>
          </Field>
        </div>
        <Field label="Label" hint="Shown on the Agent tab's model picker.">
          <Input value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="GPT-5.6 Luna" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Input $/1M" required>
            <Input type="number" step="0.000001" min="0" value={form.inputPerM} onChange={(e) => set("inputPerM", Number(e.target.value))} />
          </Field>
          <Field label="Cached input $/1M">
            <Input type="number" step="0.000001" min="0" value={form.cachedPerM} onChange={(e) => set("cachedPerM", Number(e.target.value))} />
          </Field>
          <Field label="Output $/1M">
            <Input type="number" step="0.000001" min="0" value={form.outputPerM} onChange={(e) => set("outputPerM", Number(e.target.value))} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Effective from" required>
            <Input type="date" value={form.effectiveFrom} onChange={(e) => set("effectiveFrom", e.target.value)} />
          </Field>
          <Field label="Effective to" hint="Leave empty for open-ended.">
            <Input type="date" value={form.effectiveTo} onChange={(e) => set("effectiveTo", e.target.value)} />
          </Field>
        </div>
        <Field label="Note">
          <Input value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="Promotional price through 21 Nov 2026" />
        </Field>
      </form>
    </Modal>
  );
}

function EndPriceModal({
  row,
  date,
  onDate,
  onClose,
}: {
  row: AiModelPrice | null;
  date: string;
  onDate: (value: string) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = React.useState(false);

  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title="End this price"
      description={row ? `${row.model} from ${row.effective_from} — pick the last day it applies.` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            loading={saving}
            onClick={async () => {
              if (!row) return;
              setSaving(true);
              try {
                const res = await endModelPrice(row.id, date);
                if (res.ok) {
                  toast.success("Price ended");
                  onClose();
                } else toast.error(res.error);
              } finally {
                setSaving(false);
              }
            }}
          >
            End price
          </Button>
        </>
      }
    >
      <Field label="Last day">
        <Input type="date" value={date} onChange={(e) => onDate(e.target.value)} />
      </Field>
    </Modal>
  );
}
