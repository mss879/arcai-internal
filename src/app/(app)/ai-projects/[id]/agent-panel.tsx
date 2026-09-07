"use client";

import * as React from "react";
import { toast } from "sonner";
import { Bot, ImagePlus, Trash2 } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import {
  REASONING_EFFORTS,
  SUGGESTED_QUESTIONS_MAX,
  SUGGESTED_QUESTION_MAX_CHARS,
  SYSTEM_PROMPT_MAX_CHARS,
  isReasoningModelName,
  type AgentSettingsInput,
} from "@/lib/ai-projects/chat-core";
import { TOOLS_EXCLUDE_REASONING_FROM, gpt5Minor } from "@/lib/ai/reasoning-core";
import { STORAGE_BUCKETS } from "@/lib/constants";
import { uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";

import { saveAgentSettings, setAvatarUrl, type AgentLimitsInput } from "./agent-actions";

export type ModelOption = {
  model: string;
  label: string | null;
  inputPerM: number;
  outputPerM: number;
};

export type AgentPanelData = {
  id: string;
  avatarUrl: string | null;
  settings: AgentSettingsInput;
  limits: AgentLimitsInput;
  models: ModelOption[];
  /** 0127 — one line about what the client's backend adds, so this tab and
   *  the Backend tab never disagree about what the agent can do. */
  backendSummary?: string | null;
};

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary-600" : "bg-slate-300",
        )}
      >
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-4.5" : "left-0.5")} />
      </button>
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

function ColourField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const valid = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={valid ? value : "#f97316"}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-12 cursor-pointer rounded-xl border border-slate-200 bg-white p-1"
          aria-label={`${label} picker`}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="#f97316" className="font-mono" />
        {value && (
          <button type="button" className="text-xs text-slate-400 hover:text-slate-700" onClick={() => onChange("")}>
            clear
          </button>
        )}
      </div>
    </Field>
  );
}

export function AgentPanel({ data }: { data: AgentPanelData }) {
  const [s, setS] = React.useState<AgentSettingsInput>(data.settings);
  const [limits, setLimits] = React.useState<AgentLimitsInput>(data.limits);
  const [saving, setSaving] = React.useState(false);
  const [avatarUrl, setAvatarUrl_] = React.useState(data.avatarUrl);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const set = <K extends keyof AgentSettingsInput>(key: K, value: AgentSettingsInput[K]) => setS((prev) => ({ ...prev, [key]: value }));
  const reasoning = isReasoningModelName(s.model);
  const chosen = data.models.find((m) => m.model === s.model);
  const modelKnown = Boolean(chosen);
  // From GPT-5.4 on, OpenAI refuses `reasoning_effort` in the same request as
  // function tools, so `reasoningEffortFor` sends "none" whenever this agent
  // advertises any. Say so here rather than let the owner pick an effort the
  // agent will never use. Reactive to the toggles below, on purpose.
  const minor = gpt5Minor(s.model);
  const hasTools =
    s.leadCaptureEnabled || s.handoffEnabled || s.bookingEnabled || Boolean(data.backendSummary);
  const toolsForceNoReasoning =
    reasoning && hasTools && minor !== null && minor >= TOOLS_EXCLUDE_REASONING_FROM;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await saveAgentSettings(data.id, s, limits);
      if (res.ok) toast.success("Agent saved — live within a minute.");
      else toast.error(res.error);
    } finally {
      setSaving(false);
    }
  }

  async function onAvatar(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return void toast.error("Pick an image file.");
    if (file.size > AVATAR_MAX_BYTES) return void toast.error("Keep the avatar under 2 MB.");
    setUploading(true);
    try {
      const { publicUrl } = await uploadFile(STORAGE_BUCKETS.avatars, file, `ai-projects/${data.id}`);
      const res = await setAvatarUrl(data.id, publicUrl);
      if (!res.ok) return void toast.error(res.error);
      setAvatarUrl_(publicUrl);
      toast.success("Avatar updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const questions = [...s.suggestedQuestions, "", "", "", ""].slice(0, SUGGESTED_QUESTIONS_MAX);

  return (
    <form onSubmit={save} className="space-y-6">
      {!modelKnown && (
        <Alert variant="error">
          This project&apos;s model ({s.model}) is not available in the catalog any more. Pick another before saving; until
          then replies use the default model.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Identity</CardTitle>
              <CardDescription>How the agent introduces itself.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <span
                className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl text-white"
                style={{ backgroundColor: s.primaryColor || "#f97316" }}
              >
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Bot className="h-7 w-7" />
                )}
              </span>
              <div className="flex flex-wrap gap-2">
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onAvatar(e.target.files?.[0])} />
                <Button type="button" variant="outline" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
                  <ImagePlus className="h-4 w-4" /> {avatarUrl ? "Change avatar" : "Upload avatar"}
                </Button>
                {avatarUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const res = await setAvatarUrl(data.id, null);
                      if (res.ok) setAvatarUrl_(null);
                      else toast.error(res.error);
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> Remove
                  </Button>
                )}
              </div>
            </div>
            <Field label="Agent name" required hint="Shown in the widget header and used in the prompt.">
              <Input value={s.agentName} onChange={(e) => set("agentName", e.target.value)} placeholder="Ava" />
            </Field>
            <Field label="Welcome message" hint="The first bubble a visitor sees.">
              <Textarea rows={2} value={s.welcomeMessage} onChange={(e) => set("welcomeMessage", e.target.value)} placeholder="Hi! I can answer questions about our services and pricing. What can I help with?" />
            </Field>
            <Field label="Suggested questions" hint={`Up to ${SUGGESTED_QUESTIONS_MAX} chips shown before the first message, ${SUGGESTED_QUESTION_MAX_CHARS} characters each.`}>
              <div className="space-y-2">
                {questions.map((q, i) => (
                  <Input
                    key={i}
                    value={q}
                    maxLength={SUGGESTED_QUESTION_MAX_CHARS}
                    onChange={(e) => {
                      const next = [...questions];
                      next[i] = e.target.value;
                      set("suggestedQuestions", next);
                    }}
                    placeholder={["What do you offer?", "How much does it cost?", "Where are you located?", "How do I book?"][i]}
                  />
                ))}
              </div>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Brain</CardTitle>
              <CardDescription>The model and the instructions it follows.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Model" required hint={chosen ? `$${chosen.inputPerM}/1M in · $${chosen.outputPerM}/1M out. Cheaper models answer faster; dearer ones reason better.` : undefined}>
              <Select value={s.model} onChange={(e) => set("model", e.target.value)}>
                {!modelKnown && <option value={s.model}>{s.model} (not in catalog)</option>}
                {data.models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.label ? `${m.label} — ${m.model}` : m.model} · ${m.inputPerM} in / ${m.outputPerM} out
                  </option>
                ))}
              </Select>
            </Field>
            {reasoning ? (
              <Field
                label="Reasoning effort"
                hint={
                  toolsForceNoReasoning
                    ? "Ignored while this agent has tools. From GPT-5.4 on, OpenAI will not let a model think and call a tool in the same reply, so this agent answers with reasoning off. Turn off lead capture, booking, hand-off and any custom tools to use this — or pick a GPT-5 model, which allows both."
                    : "Reasoning models think before they answer. Low keeps replies quick; higher costs more tokens and time."
                }
              >
                <Select
                  value={s.reasoningEffort}
                  disabled={toolsForceNoReasoning}
                  onChange={(e) => set("reasoningEffort", e.target.value)}
                >
                  {REASONING_EFFORTS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label={`Temperature · ${s.temperature.toFixed(2)}`} hint="0 is precise and repetitive, 1 is varied. 0.3–0.6 suits a sales assistant.">
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={s.temperature}
                  onChange={(e) => set("temperature", Number(e.target.value))}
                  className="w-full accent-primary-600"
                />
              </Field>
            )}
            <Field
              label="Instructions (system prompt)"
              hint={`${s.systemPrompt.length.toLocaleString("en-US")} / ${SYSTEM_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters. Tone, what to push, what to avoid, house facts. The guardrails and knowledge are added automatically.`}
            >
              <Textarea
                rows={12}
                value={s.systemPrompt}
                onChange={(e) => set("systemPrompt", e.target.value)}
                placeholder={"You are warm and concise. Lead with the benefit, then the price.\nWe are closed on Poya days.\nNever promise same-day delivery."}
                className="font-mono text-[13px]"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Look</CardTitle>
              <CardDescription>Match the client&apos;s brand.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ColourField label="Primary colour" value={s.primaryColor} onChange={(v) => set("primaryColor", v)} hint="Launcher, header and buttons." />
            <div className="grid gap-4 sm:grid-cols-2">
              <ColourField label="Visitor bubble" value={s.userBubbleColor} onChange={(v) => set("userBubbleColor", v)} hint="Defaults to the primary colour." />
              <ColourField label="Agent bubble" value={s.agentBubbleColor} onChange={(v) => set("agentBubbleColor", v)} hint="Defaults to light grey." />
            </div>
            <Field label="Position">
              <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
                {(["left", "right"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => set("widgetPosition", p)}
                    className={cn("rounded-lg px-4 py-1.5 text-sm font-medium", s.widgetPosition === p ? "bg-primary-600 text-white" : "text-slate-600 hover:bg-slate-100")}
                  >
                    Bottom {p}
                  </button>
                ))}
              </div>
            </Field>
            <Toggle checked={s.showBranding} onChange={(v) => set("showBranding", v)} label="Show “Powered by ARC AI”" hint="A small line under the composer." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Abilities</CardTitle>
              <CardDescription>What the agent may do beyond answering.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Notification email" hint="Captured leads and hand-off transcripts go here — usually the client's inbox." required={s.leadCaptureEnabled || s.handoffEnabled}>
              <Input type="email" value={s.notificationEmail} onChange={(e) => set("notificationEmail", e.target.value)} placeholder="owner@client.com" />
            </Field>
            <Toggle checked={s.leadCaptureEnabled} onChange={(v) => set("leadCaptureEnabled", v)} label="Capture leads" hint="Collects name, email and phone conversationally and emails them to the client." />
            <Toggle checked={s.handoffEnabled} onChange={(v) => set("handoffEnabled", v)} label="Human hand-off" hint="“Talk to a person” emails the transcript to the client." />
            <Toggle checked={s.bookingEnabled} onChange={(v) => set("bookingEnabled", v)} label="Offer a booking link" hint="The agent offers this link when a visitor wants a call or appointment." />
            {data.backendSummary && (
              <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs text-slate-500">
                {data.backendSummary} Manage those on the <span className="font-medium text-slate-700">Backend</span> tab.
              </p>
            )}
            {s.bookingEnabled && (
              <Field label="Booking link" required>
                <Input value={s.bookingUrl} onChange={(e) => set("bookingUrl", e.target.value)} placeholder="https://calendly.com/…" />
              </Field>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Limits</CardTitle>
            <CardDescription>The cost circuit breakers. A forged snippet cannot spend past these.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Messages per minute, per visitor" hint="Ten is plenty for a person; a script hits this at once.">
            <Input type="number" min={1} max={60} value={limits.rateLimitPerMinute} onChange={(e) => setLimits((l) => ({ ...l, rateLimitPerMinute: Number(e.target.value) }))} />
          </Field>
          <Field label="Messages per day, whole project" hint="Past this the widget asks visitors to leave their details instead.">
            <Input type="number" min={10} max={100000} value={limits.dailyMessageCap} onChange={(e) => setLimits((l) => ({ ...l, dailyMessageCap: Number(e.target.value) }))} />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={saving} size="lg">
          Save agent
        </Button>
      </div>
    </form>
  );
}
