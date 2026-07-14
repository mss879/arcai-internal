"use client";

import * as React from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { BarChart3, Loader2, MailX, Send, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  coldEmailAnalytics,
  type ColdEmailAnalytics,
  type ColdEmailRow,
} from "@/app/(app)/crm/outreach/analytics-actions";

type Filter = "sent" | "problem" | "all";

/**
 * "Cold email analytics" — a toolbar button that opens a popup listing every
 * lead we've actually emailed, and how each one landed.
 *
 * Loads on OPEN rather than with the CRM page: it's a few hundred rows across
 * four tables and nobody should pay for it on every board render.
 */
export function ColdEmailAnalyticsButton() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BarChart3 className="h-4 w-4" />
        Cold email
      </Button>
      {open && <AnalyticsModal onClose={() => setOpen(false)} />}
    </>
  );
}

function AnalyticsModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = React.useState<ColdEmailAnalytics | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>("sent");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await coldEmailAnalytics();
      if (cancelled) return;
      if (res.ok) setData(res.analytics);
      else setError(res.error ?? "Could not load analytics.");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = React.useMemo(() => {
    if (!data) return [];
    if (filter === "sent") return data.rows.filter((r) => r.outcome === "sent");
    if (filter === "problem") return data.rows.filter((r) => r.outcome !== "sent");
    return data.rows;
  }, [data, filter]);

  const problems = (data?.bounced ?? 0) + (data?.complained ?? 0);

  return (
    <Modal
      open
      onClose={onClose}
      title="Cold email analytics"
      description="Every lead the AI has emailed, and how it landed."
      size="lg"
    >
      {error ? (
        <p className="rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
          {error}
        </p>
      ) : !data ? (
        <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Delivered" value={data.sent} tone="emerald" icon={<Send className="h-3.5 w-3.5" />} />
            <Stat label="Sent today" value={data.sentToday} tone="slate" />
            <Stat label="Awaiting approval" value={data.awaitingApproval} tone="primary" />
            <Stat
              label="Bounced / spam"
              value={problems}
              tone={problems > 0 ? "rose" : "slate"}
              icon={problems > 0 ? <ShieldAlert className="h-3.5 w-3.5" /> : undefined}
            />
          </div>

          {(data.inProgress > 0 || data.skipped > 0 || data.failed > 0) && (
            <p className="text-xs text-slate-500">
              {data.inProgress > 0 && `${data.inProgress} still being researched/written. `}
              {data.skipped > 0 && `${data.skipped} skipped (no deliverable address). `}
              {data.failed > 0 && `${data.failed} failed to send.`}
            </p>
          )}

          {data.rows.length > 0 && (
            <div className="flex items-center gap-1.5">
              <FilterTab active={filter === "sent"} onClick={() => setFilter("sent")}>
                Delivered ({data.sent})
              </FilterTab>
              {problems > 0 && (
                <FilterTab active={filter === "problem"} onClick={() => setFilter("problem")}>
                  Bounced / spam ({problems})
                </FilterTab>
              )}
              <FilterTab active={filter === "all"} onClick={() => setFilter("all")}>
                All ({data.rows.length})
              </FilterTab>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <MailX className="h-6 w-6 text-slate-300" />
              <p className="text-sm font-medium text-slate-600">
                {data.rows.length === 0
                  ? "No cold emails have been sent yet"
                  : "Nothing in this view"}
              </p>
              {data.rows.length === 0 && (
                <p className="max-w-sm text-xs text-slate-400">
                  Start a campaign from CRM → ⋯ → Email campaigns, or draft one
                  from any individual lead.
                </p>
              )}
            </div>
          ) : (
            <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Lead</th>
                    <th className="px-3 py-2 font-medium">Subject</th>
                    <th className="px-3 py-2 font-medium">Sent</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <Row key={`${r.leadId}-${r.sentAt}`} row={r} onNavigate={onClose} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Never imply we know something we don't. */}
          {!data.opensTracked && data.rows.length > 0 && (
            <p className="text-xs text-slate-400">
              Open and click tracking isn&apos;t enabled, so replies are the only
              response signal here. Delivered means Resend accepted it and it
              didn&apos;t bounce.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Row({ row, onNavigate }: { row: ColdEmailRow; onNavigate: () => void }) {
  return (
    <tr className="hover:bg-slate-50/70">
      <td className="px-3 py-2">
        <Link
          href={`/crm/lead/${row.leadId}`}
          onClick={onNavigate}
          className="font-medium text-slate-800 hover:text-primary-600"
        >
          {row.company}
        </Link>
        <span className="block truncate text-xs text-slate-400" title={row.to.join(", ")}>
          {row.to.join(", ")}
        </span>
        {row.campaign && (
          <span className="block truncate text-[11px] text-slate-300">{row.campaign}</span>
        )}
      </td>
      <td className="max-w-[220px] px-3 py-2">
        <span className="block truncate text-slate-600" title={row.subject}>
          {row.subject || "—"}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
        {row.sentAt
          ? formatDistanceToNow(new Date(row.sentAt), { addSuffix: true })
          : "—"}
      </td>
      <td className="px-3 py-2">
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
            row.outcome === "sent"
              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
              : row.outcome === "bounced"
                ? "bg-amber-50 text-amber-700 ring-amber-200"
                : "bg-rose-50 text-rose-700 ring-rose-200",
          )}
        >
          {row.outcome === "sent"
            ? "delivered"
            : row.outcome === "bounced"
              ? "bounced"
              : "marked spam"}
        </span>
      </td>
    </tr>
  );
}

const TONES: Record<string, string> = {
  emerald: "text-emerald-700 bg-emerald-50 ring-emerald-200",
  rose: "text-rose-700 bg-rose-50 ring-rose-200",
  primary: "text-primary-700 bg-primary-50 ring-primary-200",
  slate: "text-slate-700 bg-slate-50 ring-slate-200",
};

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: keyof typeof TONES | string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl px-3 py-2.5 ring-1 ring-inset", TONES[tone] ?? TONES.slate)}>
      <div className="flex items-center gap-1.5 text-lg font-semibold leading-none">
        {icon}
        {value}
      </div>
      <div className="mt-1 text-[11px] opacity-80">{label}</div>
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-2.5 py-1 text-xs font-medium transition",
        active
          ? "bg-slate-800 text-white"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200",
      )}
    >
      {children}
    </button>
  );
}
