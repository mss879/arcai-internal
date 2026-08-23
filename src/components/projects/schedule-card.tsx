"use client";

/**
 * The payment schedule for a project (MON-3).
 *
 * Payment plans and their installments already existed, and finance.ts already
 * texts a reminder before each due date and chases the day after one goes
 * overdue. They just had no project to belong to, so a 40/40/20 split for a
 * job had to be typed into a different screen and mentally linked back.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format, isBefore, startOfToday } from "date-fns";
import { CalendarClock, Check, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn, formatCurrency } from "@/lib/utils";

import {
  createPaymentPlan,
  setInstallmentPaid,
} from "@/app/(app)/finance/actions";

export type ScheduleInstallment = {
  id: string;
  seq: number;
  amount: number;
  due_date: string;
  status: string;
};

/** The splits an agency actually uses, so nobody types three rows by hand. */
const PRESETS = [
  { label: "50 / 50", parts: [50, 50] },
  { label: "40 / 40 / 20", parts: [40, 40, 20] },
  { label: "50 / 25 / 25", parts: [50, 25, 25] },
  { label: "Three equal", parts: [34, 33, 33] },
] as const;

export function ScheduleCard({
  projectId,
  projectName,
  currency,
  totalValue,
  clientId,
  clientName,
  clientPhone,
  installments,
  planTitle,
}: {
  projectId: string;
  projectName: string;
  currency: string;
  totalValue: number;
  clientId: string | null;
  clientName: string;
  clientPhone: string | null;
  installments: ScheduleInstallment[];
  planTitle: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [preset, setPreset] = React.useState(1);
  const [firstDue, setFirstDue] = React.useState(
    new Date().toISOString().slice(0, 10),
  );
  const [gapDays, setGapDays] = React.useState("30");
  const [remindDays, setRemindDays] = React.useState("3");
  const [saving, setSaving] = React.useState(false);

  const parts = PRESETS[preset].parts;
  const rows = React.useMemo(() => {
    const base = new Date(`${firstDue}T00:00:00`);
    const gap = Number(gapDays) || 0;
    // The last part absorbs the rounding, so the split always sums to the
    // total instead of being a rupee or two short.
    const rounded = parts.map(
      (pct) => Math.round(((totalValue * pct) / 100) * 100) / 100,
    );
    return parts.map((pct, i) => {
      const isLast = i === parts.length - 1;
      const amount = isLast
        ? Math.round(
            (totalValue - rounded.slice(0, -1).reduce((s, v) => s + v, 0)) * 100,
          ) / 100
        : rounded[i];
      const due = new Date(base);
      due.setDate(due.getDate() + gap * i);
      return { pct, amount, due_date: due.toISOString().slice(0, 10) };
    });
  }, [parts, firstDue, gapDays, totalValue]);

  async function create() {
    if (totalValue <= 0) {
      toast.error("Give the project a total value first.");
      return;
    }
    setSaving(true);
    const res = await createPaymentPlan({
      title: projectName,
      project_id: projectId,
      client_id: clientId,
      contact_name: clientName || projectName,
      phone: clientPhone,
      total: totalValue,
      remind_days_before: remindDays.trim() ? Number(remindDays) : null,
      installments: rows.map((r) => ({
        amount: r.amount,
        due_date: r.due_date,
      })),
    });
    setSaving(false);
    if (res.ok) {
      setOpen(false);
      toast.success("Schedule created — reminders will go out automatically");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  const paid = installments.filter((i) => i.status === "paid").length;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-sky-50 text-sky-500">
            <CalendarClock className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Payment schedule
            </h2>
            <p className="text-xs text-slate-400">
              {installments.length === 0
                ? "Split the value and let the reminders run themselves"
                : `${paid} of ${installments.length} settled${planTitle ? ` · ${planTitle}` : ""}`}
            </p>
          </div>
        </div>
        {installments.length === 0 && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Set one up
          </Button>
        )}
      </div>

      {installments.length === 0 ? (
        <p className="px-5 py-6 text-center text-xs text-slate-400">
          A schedule texts the client before each due date and chases the day
          after one is missed — without anyone remembering to.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {installments.map((inst) => {
            const overdue =
              inst.status !== "paid" &&
              isBefore(new Date(`${inst.due_date}T23:59:59`), startOfToday());
            return (
              <li
                key={inst.id}
                className="flex items-center justify-between gap-3 px-5 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-slate-800">
                    Installment {inst.seq}
                  </p>
                  <p
                    className={cn(
                      "text-xs",
                      overdue ? "font-semibold text-rose-500" : "text-slate-400",
                    )}
                  >
                    {overdue ? "Overdue since " : "Due "}
                    {format(new Date(`${inst.due_date}T00:00:00`), "d MMM yyyy")}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums text-slate-900">
                    {formatCurrency(inst.amount, currency)}
                  </span>
                  {inst.status === "paid" ? (
                    <Badge className="bg-emerald-50 text-emerald-600 ring-emerald-200">
                      <Check className="h-3 w-3" /> Paid
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const res = await setInstallmentPaid(inst.id, true);
                        if (res.ok) {
                          toast.success("Marked paid");
                          router.refresh();
                        } else toast.error(res.error);
                      }}
                    >
                      Mark paid
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Set up a payment schedule"
        description={`Splits ${formatCurrency(totalValue, currency)} and schedules the reminders.`}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={saving}>
              Create schedule
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Split">
            <Select
              value={String(preset)}
              onChange={(e) => setPreset(Number(e.target.value))}
            >
              {PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="First due">
              <Input
                type="date"
                value={firstDue}
                onChange={(e) => setFirstDue(e.target.value)}
              />
            </Field>
            <Field label="Days apart">
              <Input
                type="number"
                min={1}
                value={gapDays}
                onChange={(e) => setGapDays(e.target.value)}
              />
            </Field>
            <Field label="Remind before" hint="Days. Blank = no reminder.">
              <Input
                type="number"
                min={0}
                value={remindDays}
                onChange={(e) => setRemindDays(e.target.value)}
              />
            </Field>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              What gets created
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {rows.map((r, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="text-slate-600">
                    {r.pct}% ·{" "}
                    {format(new Date(`${r.due_date}T00:00:00`), "d MMM yyyy")}
                  </span>
                  <span className="font-medium tabular-nums text-slate-900">
                    {formatCurrency(r.amount, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Modal>
    </section>
  );
}
