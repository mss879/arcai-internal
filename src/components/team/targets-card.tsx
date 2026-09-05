"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Target } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import type { TargetKind } from "@/lib/database.types";
import type { TargetProgress } from "@/lib/targets";
import { cn, formatCurrency } from "@/lib/utils";

import { saveTargets } from "@/app/(app)/team/target-actions";

/**
 * What the month was supposed to look like, and how it is going.
 *
 * Ordered by how far behind, so the thing that needs attention is the thing
 * read first — and percentages are uncapped, because beating a target is
 * worth seeing rather than flattening into a full bar.
 */

const KINDS: { value: TargetKind; label: string; money: boolean }[] = [
  { value: "revenue", label: "Revenue", money: true },
  { value: "deals_won", label: "Deals won", money: false },
  { value: "deliveries", label: "Projects delivered", money: false },
  { value: "leads", label: "New leads", money: false },
  { value: "hours", label: "Hours logged", money: false },
];

function label(kind: TargetKind): string {
  return KINDS.find((k) => k.value === kind)?.label ?? kind;
}

function isMoney(kind: TargetKind): boolean {
  return KINDS.find((k) => k.value === kind)?.money ?? false;
}

export function TargetsCard({
  progress,
  members,
  period,
  canEdit,
}: {
  progress: TargetProgress[];
  members: { id: string; full_name: string | null }[];
  /** `YYYY-MM-01`. */
  period: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Target className="h-4 w-4 text-primary-500" />
          This month&apos;s targets
        </h3>
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Set targets
          </Button>
        )}
      </div>

      {progress.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No targets set for this month.{" "}
          {canEdit
            ? "Set one and “are we having a good month?” gets answered with a number instead of a feeling."
            : "An admin can set them."}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {progress.map((p) => (
            <li key={`${p.kind}-${p.userId ?? "team"}`}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate text-slate-700">
                  {p.name ? `${p.name} · ` : ""}
                  {label(p.kind)}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {isMoney(p.kind)
                    ? `${formatCurrency(p.actual)} / ${formatCurrency(p.target)}`
                    : `${p.actual} / ${p.target}`}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    p.percent >= 100
                      ? "bg-emerald-500"
                      : p.percent >= 60
                        ? "bg-primary-500"
                        : "bg-amber-500",
                  )}
                  style={{ width: `${Math.min(100, Math.max(2, p.percent))}%` }}
                />
              </div>
              <p className="mt-0.5 text-[11px] text-slate-400">{p.percent}%</p>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <TargetsModal
          open={open}
          onClose={() => setOpen(false)}
          members={members}
          period={period}
          existing={progress}
        />
      )}
    </div>
  );
}

function TargetsModal({
  open,
  onClose,
  members,
  period,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  members: { id: string; full_name: string | null }[];
  period: string;
  existing: TargetProgress[];
}) {
  const router = useRouter();
  const [who, setWho] = React.useState("");
  const [kind, setKind] = React.useState<TargetKind>("revenue");
  const [amount, setAmount] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Show what is already set for the chosen combination, so editing a target
  // is editing rather than guessing what it was.
  React.useEffect(() => {
    if (!open) return;
    const match = existing.find((e) => e.kind === kind && (e.userId ?? "") === who);
    setAmount(match ? String(match.target) : "");
  }, [open, who, kind, existing]);

  async function save() {
    setSaving(true);
    const res = await saveTargets([
      { userId: who || null, period, kind, amount: Number(amount) || 0 },
    ]);
    setSaving(false);
    if (res.ok) {
      toast.success(Number(amount) > 0 ? "Target set." : "Target removed.");
      onClose();
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set a target"
      description={`For ${period.slice(0, 7)}. Setting it to 0 removes it.`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={saving}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="For">
          <Select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">The whole team</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name ?? "Someone"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What">
          <Select value={kind} onChange={(e) => setKind(e.target.value as TargetKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={isMoney(kind) ? "Amount (LKR)" : "How many"}>
          <Input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <p className="text-xs text-slate-400">
          Revenue counts the same money the Finance page does — received, not
          invoiced — and lands on whoever owns the project it came from.
        </p>
      </div>
    </Modal>
  );
}
