"use client";

import * as React from "react";
import { toast } from "sonner";
import { Mail, UserPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { hostOf, shortDateTime } from "@/lib/ai-projects/format";
import type { AiLeadStatus } from "@/lib/types";

import { resendLeadEmail, updateLeadStatus } from "./conversation-actions";

export type LeadRow = {
  id: string;
  createdAt: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  interest: string | null;
  pageUrl: string | null;
  status: AiLeadStatus;
  notifiedAt: string | null;
  notifyError: string | null;
};

const STATUS: Record<AiLeadStatus, { label: string; className: string }> = {
  new: { label: "New", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  contacted: { label: "Contacted", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  archived: { label: "Archived", className: "bg-slate-100 text-slate-500 ring-slate-200" },
};

export function LeadsPanel({ projectId, leads, notificationEmail }: { projectId: string; leads: LeadRow[]; notificationEmail: string | null }) {
  useRealtimeSync("ai_leads");
  const [busy, setBusy] = React.useState<string | null>(null);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Details the agent collected for the client
        {notificationEmail ? <>, each emailed to <span className="font-medium text-slate-700">{notificationEmail}</span>.</> : ". No notification email is set, so nothing is emailed — add one on the Agent tab."}
      </p>

      {leads.length === 0 ? (
        <EmptyState icon={<UserPlus className="h-6 w-6" />} title="No leads yet" description="When a visitor shares their name and a way to reach them, the lead lands here and in the client's inbox." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3 font-semibold">Lead</th>
                <th className="hidden px-5 py-3 font-semibold md:table-cell">Wants</th>
                <th className="px-5 py-3 font-semibold">Emailed</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-900">{l.name ?? "—"}{l.company ? <span className="font-normal text-slate-500"> · {l.company}</span> : null}</p>
                    <p className="text-xs text-slate-500">
                      {[l.email, l.phone].filter(Boolean).join(" · ") || "no contact"}
                    </p>
                    <p className="text-xs text-slate-400">{shortDateTime(l.createdAt)}{l.pageUrl ? ` · ${hostOf(l.pageUrl)}` : ""}</p>
                  </td>
                  <td className="hidden max-w-xs px-5 py-3 text-slate-600 md:table-cell">{l.interest ?? "—"}</td>
                  <td className="px-5 py-3">
                    {l.notifiedAt ? (
                      <span className="text-xs text-emerald-700">Sent {shortDateTime(l.notifiedAt)}</span>
                    ) : (
                      <span className="text-xs text-rose-600" title={l.notifyError ?? undefined}>{l.notifyError ? "Failed" : "Not sent"}</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <Select
                      value={l.status}
                      className="h-9 max-w-36 text-xs"
                      onChange={async (e) => {
                        const res = await updateLeadStatus(projectId, l.id, e.target.value as AiLeadStatus);
                        if (!res.ok) toast.error(res.error);
                      }}
                    >
                      {(Object.keys(STATUS) as AiLeadStatus[]).map((s) => (
                        <option key={s} value={s}>{STATUS[s].label}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === l.id}
                      onClick={async () => {
                        setBusy(l.id);
                        try {
                          const res = await resendLeadEmail(projectId, l.id);
                          if (res.ok) toast.success("Sent to the client");
                          else toast.error(res.error);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      <Mail className="h-3.5 w-3.5" /> {l.notifiedAt ? "Resend" : "Send"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(STATUS) as AiLeadStatus[]).map((s) => (
          <Badge key={s} className={STATUS[s].className}>{STATUS[s].label}: {leads.filter((l) => l.status === s).length}</Badge>
        ))}
      </div>
    </div>
  );
}
