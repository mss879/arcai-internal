"use client";

/**
 * The switches that make a project run itself (MON-5/6/11, PLAN-12).
 *
 * Deliberately one card rather than five scattered toggles: they all answer
 * the same question — what should happen to this project without anyone
 * remembering to do it.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings2 } from "lucide-react";

import { Field, Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";

import {
  saveProjectAutomationSettings,
  type ProjectAutomationSettings,
} from "@/app/(app)/projects/actions";

export function ProjectSettingsCard({
  projectId,
  currency,
  settings,
}: {
  projectId: string;
  currency: string;
  settings: {
    expense_cap: number | null;
    deposit_required_percent: number | null;
    is_retainer: boolean;
    retainer_day: number | null;
    auto_invoice_on_delivery: boolean;
    aftercare_enabled: boolean;
    balance_chase_paused: boolean;
    balance_chase_count: number;
  };
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    expense_cap: settings.expense_cap?.toString() ?? "",
    deposit_required_percent: settings.deposit_required_percent?.toString() ?? "",
    is_retainer: settings.is_retainer,
    retainer_day: settings.retainer_day?.toString() ?? "1",
    auto_invoice_on_delivery: settings.auto_invoice_on_delivery,
    aftercare_enabled: settings.aftercare_enabled,
    balance_chase_paused: settings.balance_chase_paused,
  });

  async function save(patch?: Partial<typeof form>) {
    const next = { ...form, ...patch };
    setForm(next);
    setSaving(true);

    const payload: ProjectAutomationSettings = {
      expense_cap: next.expense_cap.trim() ? Number(next.expense_cap) : null,
      deposit_required_percent: next.deposit_required_percent.trim()
        ? Number(next.deposit_required_percent)
        : null,
      is_retainer: next.is_retainer,
      retainer_day: next.is_retainer ? Number(next.retainer_day) || 1 : null,
      auto_invoice_on_delivery: next.auto_invoice_on_delivery,
      aftercare_enabled: next.aftercare_enabled,
      balance_chase_paused: next.balance_chase_paused,
    };

    const res = await saveProjectAutomationSettings(projectId, payload);
    setSaving(false);
    if (res.ok) {
      toast.success("Saved");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500">
          <Settings2 className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Runs by itself</h2>
          <p className="text-xs text-slate-400">
            What happens to this project without anyone remembering
          </p>
        </div>
      </div>

      <div className="space-y-5 px-5 py-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Cost cap"
            hint={`Alerts the team once when costs pass it. Blank uses the internal budget.`}
          >
            <Input
              type="number"
              inputMode="decimal"
              placeholder="e.g. 40000"
              value={form.expense_cap}
              onChange={(e) => setForm({ ...form, expense_cap: e.target.value })}
              onBlur={() => save()}
            />
          </Field>

          <Field
            label="Deposit before build (%)"
            hint="Warns when the project is moved into Build below this. Blank = no check."
          >
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              placeholder="e.g. 50"
              value={form.deposit_required_percent}
              onChange={(e) =>
                setForm({ ...form, deposit_required_percent: e.target.value })
              }
              onBlur={() => save()}
            />
          </Field>
        </div>

        <Toggle
          label="Invoice the balance on delivery"
          description="When the stage hits Delivered, raise an invoice for the contract value plus any unbilled extras, minus what's been paid."
          checked={form.auto_invoice_on_delivery}
          onChange={(v) => save({ auto_invoice_on_delivery: v })}
        />

        <Toggle
          label="Chase the balance after delivery"
          description={
            settings.balance_chase_count > 0
              ? `On at 7, 14 and 21 days. ${settings.balance_chase_count} reminder${settings.balance_chase_count === 1 ? "" : "s"} sent so far.`
              : "Texts the client at 7, 14 and 21 days after delivery while a balance is outstanding, each message firmer than the last."
          }
          checked={!form.balance_chase_paused}
          onChange={(v) => save({ balance_chase_paused: !v })}
        />

        <Toggle
          label="Monthly aftercare tasks"
          description="Once delivered, generate the maintenance to-dos (backups, updates, uptime) at the start of every month."
          checked={form.aftercare_enabled}
          onChange={(v) => save({ aftercare_enabled: v })}
        />

        <div>
          <Toggle
            label="Recurring retainer"
            description="Create next month's project automatically, carrying this one's template forward."
            checked={form.is_retainer}
            onChange={(v) => save({ is_retainer: v })}
          />
          {form.is_retainer && (
            <div className="mt-3 max-w-[220px] pl-1">
              <Field label="Day of the month" hint="1–28, so it exists every month.">
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={form.retainer_day}
                  onChange={(e) => setForm({ ...form, retainer_day: e.target.value })}
                  onBlur={() => save()}
                />
              </Field>
            </div>
          )}
        </div>

        {settings.expense_cap ? (
          <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
            Cap is {formatCurrency(settings.expense_cap, currency)}.
          </p>
        ) : null}

        {saving && <p className="text-xs text-slate-400">Saving…</p>}
      </div>
    </section>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 ${
          checked ? "bg-primary-600" : "bg-slate-200"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
