"use client";

import * as React from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import type {
  NotificationChannelPrefs,
  NotificationType,
} from "@/lib/database.types";

import type { NotificationPrefsInput } from "@/lib/notification-prefs";

import { saveNotificationPrefs } from "./actions";

/**
 * Who gets told what, and when.
 *
 * Before this the only control anyone had was turning push off entirely, so
 * the choice was "every alert on every channel" or "nothing" — and people
 * chose nothing, which is how an alert that matters gets missed.
 *
 * Two rules the UI has to make obvious, because they are the ones people are
 * surprised by:
 *   • The bell is never silenced by a channel switch. In-app is the record of
 *     what happened; muting is per-thread, from the bell itself.
 *   • Quiet hours hold back the push, not the notification — and an urgent
 *     one (a hand-off, a failed payment) comes through anyway.
 */

const TYPES: { key: NotificationType; label: string; hint: string }[] = [
  { key: "inbox", label: "Conversations", hint: "A thread assigned to you, or a hand-off." },
  { key: "approval", label: "Approvals", hint: "Something is waiting on your decision." },
  { key: "assignment", label: "Assignments", hint: "A to-do or a meeting you were added to." },
  { key: "mention", label: "Mentions", hint: "Someone wrote your name." },
  { key: "commission", label: "Commission", hint: "Money allocated to you." },
  { key: "assistant", label: "Arcus", hint: "Briefings and nudges." },
  { key: "system", label: "Everything else", hint: "Bounces, alerts, reminders." },
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function NotificationPrefsCard({
  initial,
}: {
  initial: NotificationPrefsInput;
}) {
  const [form, setForm] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);

  function channel(type: NotificationType, key: "push" | "email"): boolean {
    const chosen = (form.channels as NotificationChannelPrefs)[type]?.[key];
    // Same defaults as the server: push on, email off.
    return chosen ?? key === "push";
  }

  function toggle(type: NotificationType, key: "push" | "email") {
    setForm((f) => {
      const channels = { ...(f.channels as NotificationChannelPrefs) };
      const forType = { ...(channels[type] ?? {}) };
      forType[key] = !(forType[key] ?? key === "push");
      channels[type] = forType;
      return { ...f, channels };
    });
  }

  async function save() {
    setSaving(true);
    const res = await saveNotificationPrefs(form);
    setSaving(false);
    if (res.ok) toast.success("Saved.");
    else toast.error(res.error);
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-500">
          <BellRing className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Notifications</h3>
          <p className="text-xs text-slate-500">
            The bell always keeps a record — these choose what else reaches you.
          </p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="pb-2 text-left font-medium">Kind</th>
              <th className="pb-2 text-center font-medium">Push</th>
              <th className="pb-2 text-center font-medium">Email</th>
            </tr>
          </thead>
          <tbody>
            {TYPES.map((t) => (
              <tr key={t.key} className="border-t border-slate-50">
                <td className="py-2 pr-3">
                  <span className="font-medium text-slate-800">{t.label}</span>
                  <span className="block text-xs text-slate-400">{t.hint}</span>
                </td>
                {(["push", "email"] as const).map((key) => (
                  <td key={key} className="py-2 text-center">
                    <input
                      type="checkbox"
                      checked={channel(t.key, key)}
                      onChange={() => toggle(t.key, key)}
                      className="h-4 w-4 rounded border-slate-300 text-primary-600"
                      aria-label={`${t.label} ${key}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="border-t border-slate-100 pt-4">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              checked={form.quietHoursEnabled}
              onChange={(e) =>
                setForm((f) => ({ ...f, quietHoursEnabled: e.target.checked }))
              }
              className="h-4 w-4 rounded border-slate-300 text-primary-600"
            />
            Quiet hours
          </label>
          <p className="mt-1 text-xs text-slate-400">
            Holds back the push, never the notification. Something urgent — a
            hand-off, a failed payment — still comes through.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              From
              <Select
                value={String(form.quietHoursStart)}
                disabled={!form.quietHoursEnabled}
                onChange={(e) =>
                  setForm((f) => ({ ...f, quietHoursStart: Number(e.target.value) }))
                }
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-slate-600">
              Until
              <Select
                value={String(form.quietHoursEnd)}
                disabled={!form.quietHoursEnabled}
                onChange={(e) =>
                  setForm((f) => ({ ...f, quietHoursEnd: Number(e.target.value) }))
                }
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </div>

        <div className="space-y-2 border-t border-slate-100 pt-4">
          <p className="text-sm font-medium text-slate-800">Digests</p>
          {(
            [
              ["digestDaily", "A morning briefing, by email"],
              ["digestWeekly", "The Monday weekly digest, by email"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-primary-600"
              />
              {label}
            </label>
          ))}
        </div>

        {form.mutedLinks.length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-800">Muted</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {form.mutedLinks.map((link) => (
                <button
                  key={link}
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      mutedLinks: f.mutedLinks.filter((l) => l !== link),
                    }))
                  }
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200"
                  title="Unmute"
                >
                  {link} ×
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end border-t border-slate-100 pt-4">
          <Button onClick={save} loading={saving} disabled={saving}>
            Save preferences
          </Button>
        </div>
      </div>
    </div>
  );
}
