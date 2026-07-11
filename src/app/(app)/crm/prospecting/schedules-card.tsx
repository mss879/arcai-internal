"use client";

import * as React from "react";
import { toast } from "sonner";
import { CalendarClock, Pencil, Plus, Trash2, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type { ProspectScanSchedule } from "@/lib/types";

import { deleteScheduleAction, saveScheduleAction, type ScheduleInput } from "./actions";

/**
 * Recurring scans — the hunter-closer's cadence. Each schedule launches a
 * normal Find Leads scan on the automation tick; with auto-outreach on,
 * imported prospects fire lead_created automations (the cold first-touch
 * WhatsApp template) the moment they land.
 */
export function SchedulesCard({ schedules }: { schedules: ProspectScanSchedule[] }) {
  const [editing, setEditing] = React.useState<ScheduleInput | null>(null);
  const [deleting, setDeleting] = React.useState<ProspectScanSchedule | null>(null);
  const [saving, setSaving] = React.useState(false);

  const EMPTY: ScheduleInput = {
    label: "",
    area: "Colombo",
    category: "Restaurants",
    threshold: 60,
    max_results: 40,
    cadence_days: 7,
    auto_outreach: false,
    template_name: "",
    template_lang: "en",
    is_active: true,
  };

  async function handleSave() {
    if (!editing || saving) return;
    setSaving(true);
    const res = await saveScheduleAction(editing);
    setSaving(false);
    if (res.ok) {
      toast.success("Schedule saved.");
      setEditing(null);
    } else toast.error(res.error);
  }

  function toInput(s: ProspectScanSchedule): ScheduleInput {
    return {
      id: s.id,
      label: s.label,
      area: s.area,
      category: s.category,
      threshold: s.threshold,
      max_results: s.max_results,
      cadence_days: s.cadence_days,
      auto_outreach: s.auto_outreach,
      template_name: s.template_name ?? "",
      template_lang: s.template_lang,
      is_active: s.is_active,
    };
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <CalendarClock className="h-4 w-4 text-primary-500" />
            Autopilot schedules
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Scans that run themselves. With auto-outreach on, qualified prospects
            get your cold WhatsApp template the moment they&apos;re imported — and
            the AI agent closes whoever replies.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({ ...EMPTY })}>
          <Plus className="h-4 w-4" /> New schedule
        </Button>
      </div>

      {schedules.length > 0 && (
        <div className="mt-4 space-y-2">
          {schedules.map((s) => (
            <div
              key={s.id}
              className={cn(
                "flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5",
                !s.is_active && "opacity-55",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">
                  {s.label}
                  {s.auto_outreach && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-px text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                      <Zap className="h-3 w-3" /> auto-outreach
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {s.category} in {s.area} · every {s.cadence_days}d · next{" "}
                  {new Date(s.next_run_at).toLocaleDateString()}{" "}
                  {new Date(s.next_run_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void saveScheduleAction({ ...toInput(s), is_active: !s.is_active })
                  }
                >
                  {s.is_active ? "Pause" : "Resume"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(toInput(s))}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(s)}>
                  <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit schedule" : "New autopilot schedule"}
        description="Launches a Find Leads scan automatically on this cadence."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save schedule
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-xs font-medium text-slate-600">
              Label
              <Input
                value={editing.label}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                placeholder="e.g. Kandy restaurants weekly"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Area / city
                <Input
                  value={editing.area}
                  onChange={(e) => setEditing({ ...editing, area: e.target.value })}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Categories (comma-separated)
                <Input
                  value={editing.category}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Every X days
                <Input
                  type="number"
                  min={1}
                  value={editing.cadence_days}
                  onChange={(e) =>
                    setEditing({ ...editing, cadence_days: Number(e.target.value) })
                  }
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Score threshold
                <Input
                  type="number"
                  min={20}
                  max={90}
                  value={editing.threshold}
                  onChange={(e) =>
                    setEditing({ ...editing, threshold: Number(e.target.value) })
                  }
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium text-slate-600">
                Max businesses
                <Input
                  type="number"
                  min={5}
                  max={120}
                  value={editing.max_results}
                  onChange={(e) =>
                    setEditing({ ...editing, max_results: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <button
                type="button"
                onClick={() =>
                  setEditing({ ...editing, auto_outreach: !editing.auto_outreach })
                }
                className="flex items-center gap-2 text-xs font-medium text-slate-700"
              >
                <span
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    editing.auto_outreach ? "bg-primary-600" : "bg-slate-200",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                      editing.auto_outreach ? "left-[22px]" : "left-0.5",
                    )}
                  />
                </span>
                Auto-outreach: send the cold WhatsApp template on import
              </button>
              {editing.auto_outreach && (
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_140px]">
                  <label className="space-y-1.5 text-xs font-medium text-slate-600">
                    Approved Meta template name
                    <Input
                      value={editing.template_name}
                      onChange={(e) =>
                        setEditing({ ...editing, template_name: e.target.value })
                      }
                      placeholder="site_audit_intro"
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-slate-600">
                    Language
                    <Select
                      value={editing.template_lang}
                      onChange={(e) =>
                        setEditing({ ...editing, template_lang: e.target.value })
                      }
                    >
                      <option value="en">en</option>
                      <option value="en_US">en_US</option>
                      <option value="si">si</option>
                      <option value="ta">ta</option>
                    </Select>
                  </label>
                  <p className="text-[11px] leading-4 text-slate-400 sm:col-span-2">
                    Also install the &quot;Cold prospect first touch&quot; recipe under
                    Automation → Recipes and keep its template name in sync — it does
                    the actual send when each lead is imported.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete this schedule?"
        description={deleting ? `"${deleting.label}" will stop running. Past scans are kept.` : undefined}
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteScheduleAction(deleting.id);
          if (res.ok) toast.success("Schedule deleted.");
          else toast.error(res.error);
        }}
      />
    </section>
  );
}
