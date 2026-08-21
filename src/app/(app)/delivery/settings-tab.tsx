"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { DELIVERY_STAGES, DELIVERY_STAGE_META } from "@/lib/constants";
import type { DeliverySettings } from "@/lib/types";

import { saveDeliverySettings, type DeliverySettingsInput } from "./actions";

/** Stages worth a client-facing milestone message. Onboarding is excluded —
 * the kickoff/welcome message IS that stage's communication. */
const MILESTONE_STAGES = DELIVERY_STAGES.filter((s) => s !== "onboarding");

export function SettingsTab({ settings }: { settings: DeliverySettings | null }) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState<DeliverySettingsInput>({
    chaser_enabled: settings?.chaser_enabled ?? false,
    chaser_interval_days: settings?.chaser_interval_days ?? 3,
    chaser_max_touches: settings?.chaser_max_touches ?? 3,
    chaser_message: settings?.chaser_message ?? "",
    chaser_template_name: settings?.chaser_template_name ?? "",
    chaser_template_lang: settings?.chaser_template_lang ?? "en",
    stalled_days: settings?.stalled_days ?? 5,
    stalled_alerts_enabled: settings?.stalled_alerts_enabled ?? true,
    onboarding_template_name: settings?.onboarding_template_name ?? "",
    onboarding_template_lang: settings?.onboarding_template_lang ?? "en",
    welcome_message: settings?.welcome_message ?? "",
    milestone_notify_enabled: settings?.milestone_notify_enabled ?? true,
    milestone_messages: settings?.milestone_messages ?? {},
    google_review_url: settings?.google_review_url ?? "",
  });

  function set<K extends keyof DeliverySettingsInput>(
    key: K,
    value: DeliverySettingsInput[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    const res = await saveDeliverySettings(form);
    setSaving(false);
    if (res.ok) {
      toast.success("Delivery settings saved.");
      router.refresh();
    } else toast.error(res.error);
  }

  if (!settings) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-700">
        Delivery settings not found — run migration <code>0084_delivery_core.sql</code>{" "}
        in Supabase first.
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Onboarding kickoff */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <h3 className="text-sm font-semibold text-slate-900">Onboarding kickoff</h3>
        <p className="mt-0.5 text-xs text-slate-400">
          What the client receives the moment onboarding starts. Tokens:{" "}
          <code>{"{{name}}"}</code>, <code>{"{{project_name}}"}</code>,{" "}
          <code>{"{{portal_link}}"}</code>, <code>{"{{first_item}}"}</code>.
        </p>
        <div className="mt-4 space-y-4">
          <Field label="Welcome message (sent when they've written within 24h)">
            <Textarea
              rows={3}
              value={form.welcome_message}
              onChange={(e) => set("welcome_message", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Kickoff template name"
              hint="Used when their 24h WhatsApp window is closed. Create it in Meta WhatsApp Manager first (Utility, {{1}} = name) and wait for approval — e.g. arc_onboarding_start."
            >
              <Input
                value={form.onboarding_template_name ?? ""}
                onChange={(e) => set("onboarding_template_name", e.target.value)}
                placeholder="arc_onboarding_start"
              />
            </Field>
            <Field label="Template language">
              <Input
                value={form.onboarding_template_lang}
                onChange={(e) => set("onboarding_template_lang", e.target.value)}
                placeholder="en"
              />
            </Field>
          </div>
        </div>
      </section>

      {/* Content chaser */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Content chaser</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Automatic WhatsApp nudges listing exactly what&apos;s still missing. Owns ALL
              missing-asset reminders (the agent never nags in-chat). Respects quiet
              hours and per-project pause. Tokens: <code>{"{{name}}"}</code>,{" "}
              <code>{"{{missing_items}}"}</code>, <code>{"{{portal_link}}"}</code>,{" "}
              <code>{"{{project_name}}"}</code>.
            </p>
          </div>
          <Toggle
            checked={form.chaser_enabled}
            onChange={(v) => set("chaser_enabled", v)}
          />
        </div>
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nudge every (days)">
              <Input
                type="number"
                min={1}
                max={30}
                value={form.chaser_interval_days}
                onChange={(e) => set("chaser_interval_days", Number(e.target.value))}
              />
            </Field>
            <Field label="Max nudges per item">
              <Input
                type="number"
                min={1}
                max={10}
                value={form.chaser_max_touches}
                onChange={(e) => set("chaser_max_touches", Number(e.target.value))}
              />
            </Field>
          </div>
          <Field label="Chaser message">
            <Textarea
              rows={3}
              value={form.chaser_message}
              onChange={(e) => set("chaser_message", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Chaser template name (optional)"
              hint="Only needed for clients whose 24h window closed; without one, those nudges become team tasks instead."
            >
              <Input
                value={form.chaser_template_name ?? ""}
                onChange={(e) => set("chaser_template_name", e.target.value)}
                placeholder="arc_asset_chase"
              />
            </Field>
            <Field label="Template language">
              <Input
                value={form.chaser_template_lang}
                onChange={(e) => set("chaser_template_lang", e.target.value)}
                placeholder="en"
              />
            </Field>
          </div>
        </div>
      </section>

      {/* Milestones */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Milestone messages to the client
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Sent (with a &quot;View progress&quot; button to their portal) when a project enters
              a stage — once per project per stage, only for stages with a message
              written, only while their 24h window is open (otherwise it becomes a team
              task). Tokens: <code>{"{{name}}"}</code>, <code>{"{{project_name}}"}</code>
              , <code>{"{{portal_link}}"}</code>.
            </p>
          </div>
          <Toggle
            checked={form.milestone_notify_enabled}
            onChange={(v) => set("milestone_notify_enabled", v)}
          />
        </div>
        <div className="mt-4 space-y-4">
          {MILESTONE_STAGES.map((stage) => (
            <Field key={stage} label={DELIVERY_STAGE_META[stage].label}>
              <Textarea
                rows={2}
                value={form.milestone_messages[stage] ?? ""}
                onChange={(e) =>
                  set("milestone_messages", {
                    ...form.milestone_messages,
                    [stage]: e.target.value,
                  })
                }
                placeholder={
                  stage === "build"
                    ? "Hi {{name}}! We have everything we need — the build of {{project_name}} starts today 🚀"
                    : stage === "review"
                      ? "Hi {{name}}! {{project_name}} is ready for your review — take a look and tell us what you think 🎨"
                      : stage === "delivered"
                        ? "🎉 {{project_name}} is delivered! It's been a pleasure, {{name}} — anything you need, we're one message away."
                        : ""
                }
              />
            </Field>
          ))}
        </div>
      </section>

      {/* Stalled + misc */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Stalled-project alerts
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              When a mid-delivery project sees no changes for this many days, the team
              gets a notification and a task.
            </p>
          </div>
          <Toggle
            checked={form.stalled_alerts_enabled}
            onChange={(v) => set("stalled_alerts_enabled", v)}
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Stalled after (days)">
            <Input
              type="number"
              min={1}
              max={60}
              value={form.stalled_days}
              onChange={(e) => set("stalled_days", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Google review link"
            hint="Paste it into the review-ask recipe's message; kept here so it's always at hand."
          >
            <Input
              value={form.google_review_url ?? ""}
              onChange={(e) => set("google_review_url", e.target.value)}
              placeholder="https://g.page/r/…/review"
            />
          </Field>
        </div>
      </section>

      <div className="flex justify-end">
        <Button onClick={handleSave} loading={saving}>
          Save settings
        </Button>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-primary-600" : "bg-slate-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}
