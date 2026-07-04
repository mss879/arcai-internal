"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckSquare, Tag, Trash2, UserRound, X } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Select } from "@/components/ui/input";
import { cn, formatCurrency } from "@/lib/utils";
import { daysInactive } from "@/components/crm/lead-card";
import type { LeadWithAssignee, MemberLite, PipelineStage } from "@/lib/types";

import { bulkUpdateLeads, type BulkAction } from "@/app/(app)/crm/actions";

/** Table view with multi-select bulk actions (move, assign, tag, trash). */
export function LeadTable({
  leads,
  stages,
  members,
  staleAfterDays,
}: {
  leads: LeadWithAssignee[];
  stages: PipelineStage[];
  members: MemberLite[];
  staleAfterDays: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [confirmTrash, setConfirmTrash] = React.useState(false);
  const [bulkStage, setBulkStage] = React.useState("");
  const [bulkAssignee, setBulkAssignee] = React.useState("");
  const [bulkTag, setBulkTag] = React.useState("");

  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  const allSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)));
  }

  async function runBulk(action: BulkAction, successMsg: string) {
    setBusy(true);
    const res = await bulkUpdateLeads(Array.from(selected), action);
    setBusy(false);
    if (res.ok) {
      toast.success(`${successMsg} (${res.affected} leads).`);
      setSelected(new Set());
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="space-y-3">
      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary-200 bg-primary-50/70 px-4 py-2.5">
          <CheckSquare className="h-4 w-4 text-primary-600" />
          <span className="text-sm font-semibold text-primary-700">
            {selected.size} selected
          </span>

          <span className="mx-1 h-5 w-px bg-primary-200" />

          <Select
            value={bulkStage}
            onChange={(e) => setBulkStage(e.target.value)}
            className="h-9 w-40 py-1.5 text-xs"
          >
            <option value="">Move to stage…</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          {bulkStage && (
            <Button
              size="sm"
              loading={busy}
              onClick={() =>
                runBulk({ kind: "move_stage", stage_id: bulkStage }, "Moved")
              }
            >
              Move
            </Button>
          )}

          <Select
            value={bulkAssignee}
            onChange={(e) => setBulkAssignee(e.target.value)}
            className="h-9 w-40 py-1.5 text-xs"
          >
            <option value="">Assign to…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.username}
              </option>
            ))}
          </Select>
          {bulkAssignee && (
            <Button
              size="sm"
              loading={busy}
              onClick={() => runBulk({ kind: "assign", user_id: bulkAssignee }, "Assigned")}
            >
              <UserRound className="h-3.5 w-3.5" />
              Assign
            </Button>
          )}

          <div className="flex items-center gap-1">
            <Input
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              placeholder="tag…"
              className="h-9 w-28 py-1.5 text-xs"
            />
            {bulkTag.trim() && (
              <Button
                size="sm"
                variant="outline"
                loading={busy}
                onClick={() =>
                  runBulk({ kind: "add_tag", tag: bulkTag.trim().toLowerCase() }, "Tagged")
                }
              >
                <Tag className="h-3.5 w-3.5" />
                Tag
              </Button>
            )}
          </div>

          <span className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-600 hover:bg-rose-50"
              onClick={() => setConfirmTrash(true)}
              disabled={busy}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Trash
            </Button>
            <button
              onClick={() => setSelected(new Set())}
              className="grid h-7 w-7 place-items-center rounded-lg text-primary-400 hover:bg-primary-100"
              aria-label="Clear selection"
            >
              <X className="h-4 w-4" />
            </button>
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-400">
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-slate-300 text-primary-600"
                  aria-label="Select all"
                />
              </th>
              <th className="px-3 py-2.5 font-semibold">Lead</th>
              <th className="px-3 py-2.5 font-semibold">Stage</th>
              <th className="px-3 py-2.5 text-right font-semibold">Value</th>
              <th className="px-3 py-2.5 font-semibold">Score</th>
              <th className="px-3 py-2.5 font-semibold">Tags</th>
              <th className="px-3 py-2.5 font-semibold">Owner</th>
              <th className="px-3 py-2.5 text-right font-semibold">Idle</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {leads.map((lead) => {
              const idle = daysInactive(lead);
              const stale = lead.status === "open" && idle >= staleAfterDays;
              return (
                <tr
                  key={lead.id}
                  className={cn("hover:bg-slate-50/70", selected.has(lead.id) && "bg-primary-50/40")}
                >
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(lead.id)}
                      onChange={() => toggle(lead.id)}
                      className="h-4 w-4 rounded border-slate-300 text-primary-600"
                      aria-label={`Select ${lead.title}`}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/crm/lead/${lead.id}`}
                      className="font-medium text-slate-800 hover:text-primary-600"
                    >
                      {lead.title}
                    </Link>
                    <p className="text-xs text-slate-400">
                      {[lead.contact_name, lead.contact_phone].filter(Boolean).join(" · ")}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">
                    {lead.status === "won" ? (
                      <span className="font-semibold text-emerald-600">Won</span>
                    ) : lead.status === "lost" ? (
                      <span className="font-semibold text-slate-400">Lost</span>
                    ) : (
                      (stageName.get(lead.stage_id ?? "") ?? "—")
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium text-slate-700">
                    {lead.value != null ? formatCurrency(Number(lead.value), lead.currency) : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    {lead.score === "hot" && "🔥"}
                    {lead.score === "warm" && "🌤"}
                    {lead.score === "cold" && "🧊"}
                    {!lead.score && <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {(lead.tags ?? []).slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {lead.assignee ? (
                      <Avatar
                        name={lead.assignee.full_name}
                        src={lead.assignee.avatar_url}
                        size="xs"
                      />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2.5 text-right text-xs",
                      stale ? "font-semibold text-amber-600" : "text-slate-400",
                    )}
                  >
                    {idle}d
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {leads.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            No leads match the current filters.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        onConfirm={() => runBulk({ kind: "trash" }, "Moved to trash")}
        title={`Move ${selected.size} lead${selected.size === 1 ? "" : "s"} to trash?`}
        description="They can be restored from CRM → Trash."
      />
    </div>
  );
}
