"use client";

import * as React from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OfficeSpend } from "@/lib/agents/office-types";
import { cn } from "@/lib/utils";

import { saveOfficeSettings } from "../office-actions";
import { usd } from "./office-ui";

/** Today's agent spend against the daily cap (0130). Admins edit the cap inline. */
export function SpendMeter({ spend, isAdmin }: { spend: OfficeSpend; isAdmin: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [cap, setCap] = React.useState(String(spend.capUsd));
  const [saving, setSaving] = React.useState(false);
  const pct = spend.capUsd > 0 ? Math.min(100, (spend.todayUsd / spend.capUsd) * 100) : 0;
  const over = spend.capUsd > 0 && spend.todayUsd >= spend.capUsd;

  async function save() {
    setSaving(true);
    try {
      const res = await saveOfficeSettings({ dailyCapUsd: Number(cap) });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Daily cap is now ${usd(Number(cap))}.`);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">AI spend today</div>
          <div className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900">
            {usd(spend.todayUsd)}
            <span className="ml-1 text-sm font-normal text-slate-400">of {spend.capUsd > 0 ? usd(spend.capUsd) : "no cap"}</span>
          </div>
        </div>
        {isAdmin && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit the daily cap">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={cn("h-full rounded-full transition-all", over ? "bg-rose-500" : pct > 75 ? "bg-amber-500" : "bg-primary-500")} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>{usd(spend.monthUsd)} this month</span>
        {over && <span className="font-medium text-rose-600">Cap reached — new work waits for tomorrow</span>}
      </div>
      {editing && (
        <div className="mt-3 flex items-center gap-2">
          <Input type="number" min={0} step={1} value={cap} onChange={(e) => setCap(e.target.value)} className="h-9" />
          <Button size="sm" onClick={save} disabled={saving}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
