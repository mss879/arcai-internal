"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bot, Eye, Loader2, Sparkles, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import type { OfficeAgentView, OfficeBrandProfileRow } from "@/lib/agents/office-types";
import type { SocialPlatform } from "@/lib/database.types";
import { cn } from "@/lib/utils";

import { assignAgentTask, briefManager } from "../office-actions";
import { AgentDot, Toggle } from "./office-ui";

/**
 * The two ways to put the office to work (0130): brief the Director, who
 * plans and delegates; or hand one agent a task directly.
 */
export function ControlDock({
  agents,
  clients,
  brandProfiles,
  isAdmin,
  ready,
  presetAgent,
  onPresetConsumed,
  onCreated,
}: {
  agents: OfficeAgentView[];
  clients: { id: string; name: string }[];
  brandProfiles: OfficeBrandProfileRow[];
  isAdmin: boolean;
  ready: boolean;
  presetAgent: string | null;
  onPresetConsumed: () => void;
  onCreated: (missionId: string) => void;
}) {
  const router = useRouter();
  const [mode, setMode] = React.useState<"brief" | "assign">("brief");
  const [saving, setSaving] = React.useState(false);

  // Brief
  const [goal, setGoal] = React.useState("");
  const [platforms, setPlatforms] = React.useState<SocialPlatform[]>(["instagram"]);
  const [postCount, setPostCount] = React.useState(2);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [brandProfileId, setBrandProfileId] = React.useState("");
  const [autoPublish, setAutoPublish] = React.useState(false);

  // Assign
  const [agentKey, setAgentKey] = React.useState<string>("research");
  const [instructions, setInstructions] = React.useState("");

  React.useEffect(() => {
    if (!presetAgent) return;
    setMode("assign");
    setAgentKey(presetAgent);
    onPresetConsumed();
  }, [presetAgent, onPresetConsumed]);

  const manager = agents.find((a) => a.key === "manager");
  const specialists = agents.filter((a) => a.key !== "manager");

  // 0132 — members watch the office; only an admin puts it to work.
  if (!isAdmin) {
    return (
      <div className="card flex flex-wrap items-center gap-3 bg-white px-4 py-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
          <Eye className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">You&apos;re watching the office</div>
          <p className="text-xs text-slate-500">
            Walk the floor, open any robot and read every mission. Briefing {manager?.name ?? "the Director"} and approving work are an admin&apos;s to do.
          </p>
        </div>
      </div>
    );
  }

  const togglePlatform = (p: SocialPlatform) =>
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  async function submitBrief(e: React.FormEvent) {
    e.preventDefault();
    if (goal.trim().length < 8) return toast.error("Say a little more about what you want made.");
    setSaving(true);
    try {
      const res = await briefManager({
        goal,
        options: {
          platforms,
          postCount,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          autoPublish,
        },
        clientId: clientId || null,
        brandProfileId: brandProfileId || null,
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`${manager?.name ?? "The Director"} has the brief — watch the floor.`);
      setGoal("");
      onCreated(res.missionId);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function submitAssign(e: React.FormEvent) {
    e.preventDefault();
    if (instructions.trim().length < 8) return toast.error("Say what the agent should do.");
    setSaving(true);
    try {
      const res = await assignAgentTask({
        agentKey,
        instructions,
        options: { platforms, dateFrom: dateFrom || null, dateTo: dateTo || null },
        clientId: clientId || null,
        brandProfileId: brandProfileId || null,
      });
      if (!res.ok) return toast.error(res.error);
      const a = agents.find((x) => x.key === agentKey);
      toast.success(`${a?.name ?? "The agent"} is on it.`);
      setInstructions("");
      onCreated(res.missionId);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const chosen = specialists.find((a) => a.key === agentKey) ?? specialists[0];

  return (
    <div className="card overflow-hidden bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 pt-3">
        <ModeTab active={mode === "brief"} onClick={() => setMode("brief")} icon={<Sparkles className="h-4 w-4" />}>
          Brief the Director
        </ModeTab>
        <ModeTab active={mode === "assign"} onClick={() => setMode("assign")} icon={<UserRound className="h-4 w-4" />}>
          Assign to one agent
        </ModeTab>
        {!ready && (
          <span className="ml-auto mb-2 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
            Apply migration 0130 to wake the office
          </span>
        )}
      </div>

      {mode === "brief" ? (
        <form onSubmit={submitBrief} className="grid gap-4 p-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            <Field label="What do you want made?" required>
              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={4}
                placeholder="e.g. Three Instagram carousels for next week about how Sri Lankan SMEs can start with AI automation — practical, no hype, end with a DM call to action."
                disabled={!ready}
              />
            </Field>
            <p className="text-xs text-slate-500">
              {manager?.name ?? "Astra"} plans the work, briefs the team, has every draft checked, and hands you the result to approve. Nothing is posted until you say so
              {isAdmin ? " (unless you turn auto-publish on)." : "."}
            </p>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Platforms">
                <div className="flex gap-1.5">
                  {(["instagram", "facebook"] as SocialPlatform[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePlatform(p)}
                      className={cn(
                        "rounded-lg px-3 py-2 text-xs font-semibold capitalize ring-1 transition-colors",
                        platforms.includes(p) ? "bg-primary-50 text-primary-700 ring-primary-200" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Posts">
                <Input type="number" min={1} max={6} value={postCount} onChange={(e) => setPostCount(Math.max(1, Math.min(6, Number(e.target.value) || 1)))} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client">
                <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                  <option value="">Our own brand</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Brand profile">
                <Select value={brandProfileId} onChange={(e) => setBrandProfileId(e.target.value)}>
                  <option value="">Default</option>
                  {brandProfiles.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3">
              {isAdmin ? (
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <Toggle checked={autoPublish} onChange={setAutoPublish} label="Auto-publish" />
                  Let the Publisher queue posts itself
                </label>
              ) : (
                <span />
              )}
              <Button type="submit" disabled={saving || !ready}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Brief {manager?.name ?? "Astra"}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <form onSubmit={submitAssign} className="grid gap-4 p-4 lg:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-700">Who</div>
            <div className="grid gap-1">
              {specialists.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setAgentKey(a.key)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm ring-1 transition-colors",
                    agentKey === a.key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50",
                    !a.enabled && "opacity-50",
                  )}
                >
                  <AgentDot color={a.color} />
                  <span className="font-semibold">{a.name}</span>
                  <span className={cn("text-xs", agentKey === a.key ? "text-slate-300" : "text-slate-500")}>{a.title}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <Field label={`What should ${chosen?.name ?? "they"} do?`} required>
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={6}
                placeholder={placeholderFor(agentKey)}
                disabled={!ready}
              />
            </Field>
            {chosen && (
              <p className="text-xs text-slate-500">
                <Bot className="mr-1 inline h-3.5 w-3.5" />
                {chosen.description} Runs on <span className="font-mono">{chosen.model}</span>.
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={saving || !ready || !chosen?.enabled}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRound className="h-4 w-4" />}
                Hand it to {chosen?.name ?? "them"}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

function placeholderFor(agentKey: string): string {
  switch (agentKey) {
    case "research":
      return "Research what Sri Lankan SMEs are asking about AI automation this month — angles, objections, numbers worth quoting.";
    case "planner":
      return "Plan four Instagram posts for the last two weeks of September across our pillars.";
    case "writer":
      return "Write one carousel about the three tasks an SME should automate first. Post date 2026-09-16.";
    case "designer":
      return "Art-direct and draft the carousel from the copy in the last mission, bold typographic vs illustrative.";
    case "brand":
      return "Review the caption below against our voice and rewrite anything that drifts.";
    case "qa":
      return "Check the draft with post id … for facts, limits and brand fit.";
    case "publisher":
      return "Propose posting times for this week's approved carousels.";
    default:
      return "";
  }
}

function ModeTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
        active ? "border-primary-500 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
