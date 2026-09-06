"use client";

import * as React from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpRight, ClipboardList } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { WebLeadStatus } from "@/lib/types";
import type { LedgerEntry, LedgerSummary } from "@/lib/web-analytics/ledger";

/**
 * The lead ledger: every website conversion in the window, reconciled.
 *
 * This is the list the conversion number IS. Each row is one conversion the
 * site recorded — an enquiry, a chat lead, a WhatsApp / call / email click —
 * with where it came from, who it turned out to be in the CRM, and a verdict:
 * lead, test, spam, or not yet reviewed. Changing the verdict here changes
 * the conversion figures everywhere else on the page, because they are all
 * computed from these rows.
 */

type Filter = "all" | "review" | "counted" | "clicks" | "excluded";

const STATUS_TONE: Record<WebLeadStatus, string> = {
  unreviewed: "bg-amber-50 text-amber-700 ring-amber-200",
  lead: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  test: "bg-slate-100 text-slate-600 ring-slate-200",
  spam: "bg-rose-50 text-rose-700 ring-rose-200",
};

const STATUS_LABEL: Record<WebLeadStatus, string> = {
  unreviewed: "Needs review",
  lead: "Lead",
  test: "Test",
  spam: "Spam",
};

const CATEGORY_TONE: Record<string, string> = {
  enquiry: "bg-primary-50 text-primary-700 ring-primary-200",
  contact_click: "bg-sky-50 text-sky-700 ring-sky-200",
  other: "bg-slate-50 text-slate-600 ring-slate-200",
};

const OUTCOME_TONE: Record<LedgerEntry["outcome"], string> = {
  won: "bg-emerald-600 text-white ring-emerald-600",
  lost: "bg-slate-200 text-slate-600 ring-slate-300",
  open: "bg-white text-slate-600 ring-slate-200",
  none: "",
};

const num = (n: number) => n.toLocaleString();

/** Does this row count as a conversion on the dashboard? Same rule as the server's. */
const counts = (e: LedgerEntry) =>
  e.status === "lead" || (e.status === "unreviewed" && e.category === "enquiry");

export function LedgerPanel({
  entries,
  summary,
  days,
  siteUrl,
  onSetStatus,
}: {
  /** Null when the ledger table has not been created yet. */
  entries: LedgerEntry[] | null;
  summary: LedgerSummary | null;
  days: number;
  siteUrl: string;
  onSetStatus: (id: string, status: WebLeadStatus) => Promise<void>;
}) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [busy, setBusy] = React.useState<string | null>(null);

  if (entries === null || summary === null) {
    return (
      <EmptyState
        icon={<ClipboardList className="h-6 w-6" />}
        title="The lead ledger is not set up yet"
        description="Run supabase/migrations/0125_web_lead_ledger.sql in the CRM project's SQL editor, then press Rebuild history on the Setup tab. Every conversion the website ever recorded will be reconciled here, and the conversion figures on the other tabs will start reading from it."
      />
    );
  }

  const visible = entries.filter((e) => {
    switch (filter) {
      case "review":
        return e.status === "unreviewed";
      case "counted":
        return counts(e);
      case "clicks":
        return e.category === "contact_click";
      case "excluded":
        return e.status === "spam" || e.status === "test";
      default:
        return true;
    }
  });

  const change = async (id: string, status: WebLeadStatus) => {
    setBusy(id);
    try {
      await onSetStatus(id, status);
    } finally {
      setBusy(null);
    }
  };

  // The reconciliation sentence: every row is in exactly one of these buckets.
  const confirmedClicks = summary.by_kind
    .filter((k) => k.category === "contact_click")
    .reduce((n, k) => n + k.counted, 0);
  const clicksToConfirm = Math.max(0, summary.contact_clicks - confirmedClicks);
  const other = Math.max(
    0,
    summary.rows - summary.counted - summary.spam - summary.test - clicksToConfirm,
  );

  const tiles: { label: string; value: number; hint?: string; tone?: string }[] = [
    { label: "Conversion events", value: summary.events, hint: `${num(summary.rows)} distinct` },
    {
      label: "Counted as conversions",
      value: summary.counted,
      hint: "confirmed leads + unreviewed enquiries",
      tone: "text-emerald-700",
    },
    { label: "Enquiries", value: summary.enquiries, hint: "forms and chat, spam and tests removed" },
    {
      label: "Contact clicks",
      value: summary.contact_clicks,
      hint: `WhatsApp, call, email · ${num(summary.unreviewed_contact_clicks)} to confirm`,
    },
    { label: "Spam", value: summary.spam, tone: "text-rose-700" },
    { label: "Tests", value: summary.test },
    {
      label: "Needs review",
      value: summary.unreviewed,
      hint: `${num(summary.unreviewed_enquiries)} enquiries`,
      tone: summary.unreviewed ? "text-amber-700" : undefined,
    },
    {
      label: "Matched to a CRM lead",
      value: summary.matched,
      hint: summary.unmatched_enquiries
        ? `${num(summary.unmatched_enquiries)} enquiries unmatched`
        : "every genuine enquiry has a lead",
    },
    { label: "Qualified", value: summary.qualified, hint: "confirmed, or hot / warm in the CRM" },
    { label: "Won", value: summary.won, hint: summary.lost ? `${num(summary.lost)} lost` : undefined },
  ];

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-slate-700">
            Every conversion in the last {days} days, reconciled
          </p>
          <p className="text-xs text-slate-400">
            {num(summary.rows)} rows = {num(summary.counted)} counted + {num(clicksToConfirm)} contact
            clicks to confirm + {num(summary.spam)} spam + {num(summary.test)} tests
            {other > 0 ? ` + ${num(other)} other` : ""}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl bg-slate-50 px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{t.label}</p>
              <p className={cn("text-xl font-semibold tabular-nums text-slate-900", t.tone)}>
                {num(t.value)}
              </p>
              {t.hint && <p className="text-[11px] text-slate-400">{t.hint}</p>}
            </div>
          ))}
        </div>
        {summary.by_kind.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {summary.by_kind.map((k) => (
              <Badge key={k.kind} className={cn("ring-1", CATEGORY_TONE[k.category] ?? CATEGORY_TONE.other)}>
                {k.kind.replace(/_/g, " ")} · {num(k.rows)}
                {k.counted !== k.rows && (
                  <span className="ml-1 opacity-70">({num(k.counted)} counted)</span>
                )}
              </Badge>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", `All (${num(entries.length)})`],
            ["review", `Needs review (${num(entries.filter((e) => e.status === "unreviewed").length)})`],
            ["counted", `Counted (${num(entries.filter(counts).length)})`],
            ["clicks", `Contact clicks (${num(entries.filter((e) => e.category === "contact_click").length)})`],
            ["excluded", `Spam & tests (${num(entries.filter((e) => e.status === "spam" || e.status === "test").length)})`],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition",
              filter === key
                ? "border-primary-500 bg-primary-500 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!visible.length ? (
        <EmptyState
          icon={<ClipboardList className="h-6 w-6" />}
          title={entries.length ? "Nothing under this filter" : "No conversions in this window"}
          description={
            entries.length
              ? "Pick another filter above."
              : "Conversions appear here on the next sync. If the site has had enquiries and this is empty, press Rebuild history on the Setup tab."
          }
        />
      ) : (
        <div className="space-y-2">
          {visible.map((e) => (
            <div
              key={e.id}
              className={cn(
                "rounded-2xl border bg-white p-4 shadow-sm",
                e.status === "spam" || e.status === "test"
                  ? "border-slate-100 opacity-70"
                  : "border-slate-200",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={cn("ring-1", CATEGORY_TONE[e.category] ?? CATEGORY_TONE.other)}>
                      {e.kind.replace(/_/g, " ")}
                    </Badge>
                    <Badge className={cn("ring-1", STATUS_TONE[e.status])}>{STATUS_LABEL[e.status]}</Badge>
                    {counts(e) && (
                      <span className="text-[11px] font-medium text-emerald-600">counted</span>
                    )}
                    {e.occurrences > 1 && (
                      <span className="text-[11px] text-slate-400">×{e.occurrences}</span>
                    )}
                    {e.outcome !== "none" && (
                      <Badge className={cn("ring-1", OUTCOME_TONE[e.outcome])}>{e.outcome}</Badge>
                    )}
                    {e.qualified && (
                      <Badge className="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                        qualified
                      </Badge>
                    )}
                    <span className="text-xs text-slate-400">
                      {formatDistanceToNow(new Date(e.occurred_at), { addSuffix: true })}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    {e.lead ? (
                      <Link
                        href={`/crm/lead/${e.lead.id}`}
                        className="inline-flex items-center gap-1 font-medium text-primary-700 hover:underline"
                      >
                        {e.contact_name || e.lead.contact_name || e.lead.title}
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    ) : e.contact_name || e.contact_email || e.identified_email ? (
                      <span className="font-medium text-slate-800">
                        {e.contact_name || e.contact_email || e.identified_email}
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        {e.category === "contact_click"
                          ? "Anonymous — confirm below if the conversation happened"
                          : "No CRM lead matched yet"}
                      </span>
                    )}
                    {e.contact_email && e.contact_email !== e.contact_name && (
                      <span className="text-xs text-slate-500">{e.contact_email}</span>
                    )}
                    {e.contact_phone && <span className="text-xs text-slate-500">{e.contact_phone}</span>}
                    {!e.contact_email && e.identified_email && e.identified_email !== e.contact_name && (
                      <span className="text-xs text-slate-500">{e.identified_email}</span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    {e.path && (
                      <a
                        href={`${siteUrl}${e.path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:underline"
                      >
                        {e.path}
                      </a>
                    )}
                    {e.entry_path && e.entry_path !== e.path && <span>landed on {e.entry_path}</span>}
                    {e.channel && <span>{e.channel.replace(/_/g, " ")}</span>}
                    {(e.utm_source || e.utm_campaign) && (
                      <span>
                        {[e.utm_source, e.utm_campaign].filter(Boolean).join(" / ")}
                      </span>
                    )}
                    {e.referrer_domain && <span>via {e.referrer_domain}</span>}
                    {e.country && <span>{e.country}</span>}
                    {e.device_type && <span>{e.device_type}</span>}
                    {e.match_method && e.lead && <span>matched by {e.match_method.replace(/_/g, " ")}</span>}
                  </div>

                  {e.status_reason && (
                    <p className="mt-1.5 text-xs italic text-slate-400">{e.status_reason}</p>
                  )}
                </div>

                <label className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-slate-400">
                  verdict
                  <select
                    value={e.status}
                    disabled={busy === e.id}
                    onChange={(ev) => void change(e.id, ev.target.value as WebLeadStatus)}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-xs font-medium ring-1 ring-inset focus:outline-none",
                      STATUS_TONE[e.status],
                      busy === e.id && "opacity-50",
                    )}
                  >
                    <option value="unreviewed">Needs review</option>
                    <option value="lead">Lead</option>
                    <option value="spam">Spam</option>
                    <option value="test">Test</option>
                  </select>
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
