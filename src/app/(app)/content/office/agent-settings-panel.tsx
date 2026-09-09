"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { responsesEffortFor } from "@/lib/ai/reasoning-core";
import type { OfficeAgentView } from "@/lib/agents/office-types";
import type { OfficeEffort } from "@/lib/database.types";
import { cn } from "@/lib/utils";

import { saveAgentSettings } from "../office-actions";
import { AgentDot, Toggle, usd } from "./office-ui";

export type ModelChoice = { model: string; inputPerM: number; outputPerM: number };

const EFFORTS: OfficeEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Who runs on what (0130). Admins change an agent's model (from the price
 * catalog), its reasoning effort (only the values that model accepts on the
 * Responses API), its persona notes and its name; members see the roster.
 */
export function AgentSettingsPanel({ agents, models, isAdmin }: { agents: OfficeAgentView[]; models: ModelChoice[]; isAdmin: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {agents.map((a) => (
        <AgentCard key={a.key} agent={a} models={models} isAdmin={isAdmin} />
      ))}
    </div>
  );
}

function AgentCard({ agent, models, isAdmin }: { agent: OfficeAgentView; models: ModelChoice[]; isAdmin: boolean }) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [s, setS] = React.useState({
    name: agent.name,
    title: agent.title,
    model: agent.overridden ? agent.model : "",
    reasoningEffort: agent.effort as string,
    instructions: agent.instructions,
    color: agent.color,
    enabled: agent.enabled,
  });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const effectiveModel = s.model || agent.chain[0];
  const legal = EFFORTS.filter((e) => responsesEffortFor(effectiveModel, e) === e || responsesEffortFor(effectiveModel, e) === null);
  const price = models.find((m) => m.model === effectiveModel);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await saveAgentSettings(agent.key, {
        name: s.name,
        title: s.title,
        model: s.model || null,
        reasoningEffort: s.reasoningEffort || null,
        instructions: s.instructions,
        color: s.color,
        enabled: s.enabled,
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`${s.name} saved — the next task uses these settings.`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className={cn("card bg-white p-4", !agent.enabled && "opacity-80")}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold text-white" style={{ background: s.color }}>
          {s.name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900">{agent.name}</span>
            <span className="text-xs text-slate-500">{agent.title}</span>
            {!agent.enabled && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">paused</span>}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{agent.description}</p>
          <p className="mt-1 text-xs text-slate-500">
            <AgentDot color={agent.color} className="mr-1.5" />
            Runs on <span className="font-mono text-slate-700">{agent.model}</span>
            {agent.chain.length > 1 ? <span className="text-slate-400"> → falls back to {agent.chain.slice(1).join(" → ")}</span> : null}
            {price ? <span className="text-slate-400"> · {usd(price.inputPerM)}/{usd(price.outputPerM)} per 1M in/out</span> : null}
            {agent.webSearch ? " · web search" : ""}
          </p>
        </div>
        {isAdmin && <Toggle checked={s.enabled} onChange={(v) => set("enabled", v)} label="Enabled" />}
      </div>

      {isAdmin && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={s.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Title">
              <Input value={s.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model" hint={s.model ? undefined : `Default: ${agent.chain[0]}`}>
              <Select value={s.model} onChange={(e) => set("model", e.target.value)}>
                <option value="">Default ({agent.chain[0]})</option>
                {models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reasoning effort">
              <Select value={s.reasoningEffort} onChange={(e) => set("reasoningEffort", e.target.value)}>
                {legal.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Standing instructions" hint="Added to every task this agent gets.">
            <Textarea rows={2} value={s.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="e.g. Always mention we are based in Colombo." />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              Colour
              <input type="color" value={s.color} onChange={(e) => set("color", e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-slate-200" />
            </label>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
