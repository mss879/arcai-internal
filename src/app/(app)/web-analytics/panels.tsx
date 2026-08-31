"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Globe,
  MessageSquare,
  Route,
  ScrollText,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type {
  WebChatSession,
  WebDaily,
  WebJourney,
  WebSession,
} from "@/lib/types";


export type Breakdown = { key: string; count: number }[];

export type PageRow = {
  path: string;
  title: string | null;
  pageviews: number;
  visitors: number;
  entries: number;
  exits: number;
  bounces: number;
  avgSeconds: number;
  avgScroll: number;
  conversions: number;
  formStarts: number;
  formAbandons: number;
  rageClicks: number;
  ctaClicks: number;
};

// -- small shared pieces ----------------------------------------------------

export function secs(seconds: number): string {
  if (!seconds) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

const num = (n: number): string => n.toLocaleString();

function pctChange(now: number, before: number): number | null {
  if (!before) return now ? 100 : null;
  return Number((((now - before) / before) * 100).toFixed(1));
}

/**
 * A headline number with its change against the previous window.
 *
 * `goodIsUp` exists because half of these metrics are better when they
 * fall. Bounce rate rising by 12% is red; sessions rising by 12% is
 * green, and colouring both the same way would train the eye to ignore
 * the colour.
 */
export function Stat({
  label,
  value,
  previous,
  current,
  suffix,
  goodIsUp = true,
  hint,
}: {
  label: string;
  value: string;
  previous?: number;
  current?: number;
  suffix?: string;
  goodIsUp?: boolean;
  hint?: string;
}) {
  const change =
    previous !== undefined && current !== undefined ? pctChange(current, previous) : null;
  const positive = change !== null && (goodIsUp ? change >= 0 : change <= 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value}
        {suffix && <span className="ml-0.5 text-base font-normal text-slate-400">{suffix}</span>}
      </p>
      {change !== null && (
        <p
          className={cn(
            "mt-1 inline-flex items-center gap-1 text-xs font-medium",
            positive ? "text-emerald-600" : "text-rose-600",
          )}
        >
          {change >= 0 ? (
            <TrendingUp className="h-3.5 w-3.5" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5" />
          )}
          {change >= 0 ? "+" : ""}
          {change}% vs previous
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * The daily trend, drawn as an inline SVG area.
 *
 * No chart library: this is one series of at most 365 points, and the
 * whole shape is four lines of path arithmetic. Pulling in a charting
 * dependency for it would cost more in bundle size than the page.
 */
export function TrendChart({
  rows,
  metric,
  label,
}: {
  rows: WebDaily[];
  metric: keyof WebDaily;
  label: string;
}) {
  const points = rows.map((r) => Number(r[metric] ?? 0));
  if (!points.length) {
    return (
      <div className="grid h-48 place-items-center rounded-2xl border border-dashed border-slate-200 text-sm text-slate-400">
        No data for this window yet.
      </div>
    );
  }

  const w = 800;
  const h = 180;
  const pad = 8;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);

  const line = points.map((v, i) => `${pad + i * step},${y(v)}`).join(" ");
  const area = `${pad},${h - pad} ${line} ${pad + (points.length - 1) * step},${h - pad}`;

  const peak = Math.max(...points);
  const peakIdx = points.indexOf(peak);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-medium text-slate-700">{label}</p>
        <p className="text-xs text-slate-400">
          peak {num(peak)} on {rows[peakIdx]?.day}
        </p>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-44 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} over ${rows.length} days`}
      >
        <polygon points={area} className="fill-primary-500/10" />
        <polyline
          points={line}
          fill="none"
          className="stroke-primary-500"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-slate-400">
        <span>{rows[0]?.day}</span>
        <span>{rows[rows.length - 1]?.day}</span>
      </div>
    </div>
  );
}

/** A ranked breakdown with proportional bars. */
export function BarList({
  title,
  rows,
  limit = 10,
  emptyLabel = "Nothing recorded yet.",
}: {
  title: string;
  rows: Breakdown;
  limit?: number;
  emptyLabel?: string;
}) {
  const shown = rows.slice(0, limit);
  const max = Math.max(...shown.map((r) => r.count), 1);
  const total = rows.reduce((n, r) => n + r.count, 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="mb-3 text-sm font-medium text-slate-700">{title}</p>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">{emptyLabel}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((row) => (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-slate-700" title={row.key}>
                  {row.key}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {num(row.count)}
                  <span className="ml-1 text-xs text-slate-400">
                    {total ? `${Math.round((row.count / total) * 100)}%` : ""}
                  </span>
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-primary-500/70"
                  style={{ width: `${(row.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -- overview ---------------------------------------------------------------

export function FunnelPanel({
  funnel,
}: {
  funnel: { stage: string; sessions: number; rate: number }[];
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="mb-1 text-sm font-medium text-slate-700">From arrival to enquiry</p>
      <p className="mb-3 text-xs text-slate-400">
        Stages of intent, not a fixed page sequence — the site has many entry points and no
        single checkout.
      </p>
      <ul className="space-y-2">
        {funnel.map((stage, idx) => {
          const previous = funnel[idx - 1];
          const dropped = previous ? previous.sessions - stage.sessions : 0;
          return (
            <li key={stage.stage}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-slate-700">{stage.stage}</span>
                <span className="tabular-nums text-slate-500">
                  {num(stage.sessions)}{" "}
                  <span className="text-xs text-slate-400">({stage.rate}%)</span>
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-primary-500"
                  style={{ width: `${stage.rate}%` }}
                />
              </div>
              {previous && dropped > 0 && (
                <p className="mt-0.5 text-[11px] text-rose-500">
                  {num(dropped)} lost from the step above
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// -- pages ------------------------------------------------------------------

export function PagesPanel({ pages }: { pages: PageRow[] }) {
  if (!pages.length) {
    return (
      <EmptyState
        icon={<ScrollText className="h-6 w-6" />}
        title="No page data yet"
        description="Once the tracker is live on the website and the first sync has run, every page's traffic, reading time and scroll depth appears here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[880px] text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Page</th>
            <th className="px-3 py-3 text-right font-medium">Views</th>
            <th className="px-3 py-3 text-right font-medium">Entries</th>
            <th className="px-3 py-3 text-right font-medium">Exits</th>
            <th className="px-3 py-3 text-right font-medium">Avg time</th>
            <th className="px-3 py-3 text-right font-medium">Scroll</th>
            <th className="px-3 py-3 text-right font-medium">Forms</th>
            <th className="px-3 py-3 text-right font-medium">Conv.</th>
            <th className="px-4 py-3 text-right font-medium">Rage</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {pages.map((page) => (
            <tr key={page.path} className="hover:bg-slate-50/60">
              <td className="max-w-[300px] px-4 py-2.5">
                <p className="truncate font-medium text-slate-800" title={page.path}>
                  {page.path}
                </p>
                {page.title && (
                  <p className="truncate text-xs text-slate-400" title={page.title}>
                    {page.title}
                  </p>
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                {num(page.pageviews)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                {num(page.entries)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                {num(page.exits)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                {secs(page.avgSeconds)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                {page.avgScroll}%
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                {page.formStarts > 0 ? (
                  <span title={`${page.formAbandons} abandoned`}>
                    {page.formStarts}
                    {page.formAbandons > 0 && (
                      <span className="text-rose-500"> −{page.formAbandons}</span>
                    )}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums font-medium text-emerald-600">
                {page.conversions || "—"}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                {page.rageClicks > 0 ? (
                  <span className="text-amber-600">{page.rageClicks}</span>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -- journeys ---------------------------------------------------------------

export function JourneysPanel({
  paths,
  transitions,
}: {
  paths: WebJourney[];
  transitions: WebJourney[];
}) {
  const exits = transitions
    .filter((t) => !t.to_path)
    .sort((a, b) => b.drop_offs - a.drop_offs)
    .slice(0, 12);
  const moves = transitions
    .filter((t) => t.to_path)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 20);

  if (!paths.length && !transitions.length) {
    return (
      <EmptyState
        icon={<Route className="h-6 w-6" />}
        title="No journeys mapped yet"
        description="Journeys need at least a few multi-page visits. They are recomputed over a rolling 30-day window on every sync."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-medium text-slate-700">The routes people actually take</p>
        <p className="mb-3 text-xs text-slate-400">
          Whole visits, in order, most common first. Repeat views of the same page are
          collapsed.
        </p>
        {paths.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            No multi-page journeys recorded yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {paths.slice(0, 18).map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50/70 px-3 py-2"
              >
                <span className="flex flex-wrap items-center gap-1 text-sm text-slate-700">
                  {(p.path_sequence ?? "").split(" → ").map((step, idx, all) => (
                    <React.Fragment key={`${p.id}-${idx}`}>
                      <code className="rounded bg-white px-1.5 py-0.5 text-xs ring-1 ring-slate-200">
                        {step}
                      </code>
                      {idx < all.length - 1 && (
                        <ArrowRight className="h-3 w-3 text-slate-300" />
                      )}
                    </React.Fragment>
                  ))}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-slate-500">
                  {num(p.sessions)} visits
                  {p.conversions > 0 && (
                    <span className="ml-2 font-medium text-emerald-600">
                      {p.conversions} converted
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium text-slate-700">Most common next steps</p>
          <p className="mb-3 text-xs text-slate-400">
            From a page, where people go next.
          </p>
          <ul className="space-y-1.5">
            {moves.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  <code className="truncate rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
                    {t.from_path}
                  </code>
                  <ArrowRight className="h-3 w-3 shrink-0 text-slate-300" />
                  <code className="truncate rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
                    {t.to_path}
                  </code>
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">{t.sessions}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium text-slate-700">Where visits end</p>
          <p className="mb-3 text-xs text-slate-400">
            The pages people leave from. High numbers on a page meant to lead somewhere are
            the leaks worth fixing first.
          </p>
          <ul className="space-y-1.5">
            {exits.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                <code className="truncate rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
                  {t.from_path}
                </code>
                <span className="shrink-0 tabular-nums text-rose-600">
                  {num(t.drop_offs)}
                  <span className="ml-1 text-xs text-slate-400">
                    of {num(t.sessions)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// -- visitors ---------------------------------------------------------------

const CHANNEL_TONE: Record<string, string> = {
  organic: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  paid_search: "bg-amber-50 text-amber-700 ring-amber-200",
  paid_social: "bg-amber-50 text-amber-700 ring-amber-200",
  social: "bg-sky-50 text-sky-700 ring-sky-200",
  email: "bg-violet-50 text-violet-700 ring-violet-200",
  referral: "bg-slate-100 text-slate-700 ring-slate-200",
  ai_assistant: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
  direct: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function SessionsPanel({
  sessions,
  emptyTitle,
  emptyDescription,
}: {
  sessions: WebSession[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (!sessions.length) {
    return (
      <EmptyState
        icon={<Users className="h-6 w-6" />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <div
          key={s.session_id}
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={cn("ring-1", CHANNEL_TONE[s.channel] ?? CHANNEL_TONE.direct)}>
                {s.channel.replace(/_/g, " ")}
              </Badge>
              <Badge>{s.device_type}</Badge>
              {(s.city || s.country) && (
                <Badge>
                  {[s.city, s.country ?? s.country_code].filter(Boolean).join(", ")}
                </Badge>
              )}
              {s.converted && (
                <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                  {s.conversion_kind ?? "converted"}
                </Badge>
              )}
              {s.chat_engaged && (
                <Badge className="bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200">
                  chatted ×{s.chat_message_count}
                </Badge>
              )}
              {s.identified_email && (
                <Badge className="bg-sky-50 text-sky-700 ring-sky-200">
                  {s.identified_email}
                </Badge>
              )}
            </div>
            <span className="text-xs text-slate-400">
              {formatDistanceToNow(new Date(s.first_seen_at), { addSuffix: true })}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
            <code className="rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
              {s.entry_path}
            </code>
            {s.exit_path && s.exit_path !== s.entry_path && (
              <>
                <ArrowRight className="h-3 w-3 text-slate-300" />
                <code className="rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
                  {s.exit_path}
                </code>
              </>
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>{s.page_count} pages</span>
            <span>{secs(s.engaged_seconds)} engaged</span>
            <span>{s.max_scroll_pct}% scrolled</span>
            {s.browser && (
              <span>
                {s.browser} on {s.os ?? "unknown"}
              </span>
            )}
            {s.referrer_domain && <span>via {s.referrer_domain}</span>}
            {s.utm_campaign && <span>campaign: {s.utm_campaign}</span>}
            {s.rage_clicks > 0 && (
              <span className="text-amber-600">{s.rage_clicks} rage clicks</span>
            )}
            {s.forms_abandoned > 0 && (
              <span className="text-rose-600">{s.forms_abandoned} forms abandoned</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// -- website AI agent -------------------------------------------------------

export function ChatPanel({ chats }: { chats: WebChatSession[] }) {
  const [open, setOpen] = React.useState<string | null>(null);

  if (!chats.length) {
    return (
      <EmptyState
        icon={<MessageSquare className="h-6 w-6" />}
        title="No conversations pulled yet"
        description="The website's AI agent transcripts are mirrored on every sync. If the site has had chats and this is empty, check the sync status on the Setup tab."
      />
    );
  }

  return (
    <div className="space-y-2">
      {chats.map((chat) => {
        const isOpen = open === chat.id;
        const signals = (chat.buying_signals ?? []) as string[];
        return (
          <div
            key={chat.id}
            className="rounded-2xl border border-slate-200 bg-white shadow-sm"
          >
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : chat.id)}
              className="flex w-full flex-col gap-2 p-4 text-left"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {chat.topic && (
                    <Badge className="bg-primary-50 text-primary-700 ring-primary-200">
                      {chat.topic}
                    </Badge>
                  )}
                  {chat.intent && <Badge>{chat.intent}</Badge>}
                  {chat.sentiment && (
                    <Badge
                      className={cn(
                        chat.sentiment === "positive" &&
                          "bg-emerald-50 text-emerald-700 ring-emerald-200",
                        chat.sentiment === "negative" &&
                          "bg-rose-50 text-rose-700 ring-rose-200",
                      )}
                    >
                      {chat.sentiment}
                    </Badge>
                  )}
                  <Badge>{chat.message_count} messages</Badge>
                  {chat.captured_email && (
                    <Badge className="bg-sky-50 text-sky-700 ring-sky-200">
                      {chat.captured_email}
                    </Badge>
                  )}
                  {signals.length > 0 && (
                    <Badge className="bg-amber-50 text-amber-700 ring-amber-200">
                      {signals.length} buying signal{signals.length === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-slate-400">
                  {formatDistanceToNow(new Date(chat.started_at), { addSuffix: true })}
                </span>
              </div>
              <p className="text-sm text-slate-700">
                {chat.summary || chat.first_user_message || "(no visitor message)"}
              </p>
            </button>

            {isOpen && (
              <div className="border-t border-slate-100 p-4">
                {signals.length > 0 && (
                  <div className="mb-3 rounded-xl bg-amber-50 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
                      Buying signals
                    </p>
                    <ul className="mt-1 list-inside list-disc text-sm text-amber-900">
                      {signals.map((sig, i) => (
                        <li key={i}>{String(sig)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                  {chat.transcript || "(transcript unavailable)"}
                </pre>
                {chat.ip_location && (
                  <p className="mt-2 text-xs text-slate-400">From {chat.ip_location}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// -- setup / sync -----------------------------------------------------------

export function SyncPanel({
  status,
  site,
  sourceReady,
}: {
  status: {
    stream: string;
    lastRunAt: string | null;
    lastOkAt: string | null;
    rowsSynced: number;
    lastError: string | null;
  }[];
  site: string;
  sourceReady: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Globe className="h-4 w-4 text-slate-400" />
          <p className="text-sm font-medium text-slate-700">
            Source: <span className="font-mono text-xs">{site}</span>
          </p>
          {sourceReady ? (
            <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
              <CheckCircle2 className="h-3 w-3" /> connected
            </Badge>
          ) : (
            <Badge className="bg-rose-50 text-rose-700 ring-rose-200">
              <AlertTriangle className="h-3 w-3" /> not configured
            </Badge>
          )}
        </div>

        {status.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">
            No sync has run yet. Use “Sync now” above to pull the first batch.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 font-medium">Stream</th>
                <th className="py-2 text-right font-medium">Rows</th>
                <th className="py-2 text-right font-medium">Last run</th>
                <th className="py-2 text-right font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {status.map((row) => (
                <tr key={row.stream}>
                  <td className="py-2 font-medium text-slate-700">{row.stream}</td>
                  <td className="py-2 text-right tabular-nums text-slate-500">
                    {num(row.rowsSynced)}
                  </td>
                  <td className="py-2 text-right text-xs text-slate-400">
                    {row.lastRunAt
                      ? formatDistanceToNow(new Date(row.lastRunAt), { addSuffix: true })
                      : "never"}
                  </td>
                  <td className="py-2 text-right">
                    {row.lastError ? (
                      <span className="text-xs text-rose-600" title={row.lastError}>
                        error
                      </span>
                    ) : (
                      <span className="text-xs text-emerald-600">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {status.some((r) => r.lastError) && (
          <div className="mt-3 space-y-1">
            {status
              .filter((r) => r.lastError)
              .map((r) => (
                <p key={r.stream} className="text-xs text-rose-600">
                  <strong>{r.stream}:</strong> {r.lastError}
                </p>
              ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="mb-2 text-sm font-medium text-slate-700">How the data gets here</p>
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-slate-600">
          <li>
            The tracker on <span className="font-mono text-xs">{site}</span> records every
            page view, click, scroll, form interaction, chat message and Core Web Vital into
            the website&apos;s own Supabase project.
          </li>
          <li>
            This CRM reads that project directly with its service-role key — every stream
            incremental, every write idempotent.
          </li>
          <li>
            The days that changed are rolled up into daily, per-page and journey tables, and
            new conversations are read and labelled.
          </li>
          <li>
            Sessions carrying an email are matched against leads and clients already in the
            CRM, so anonymous browsing becomes attributable.
          </li>
        </ol>
        <p className="mt-3 text-xs text-slate-400">
          Runs hourly on the automation tick, plus a full pass with a written report each
          morning. “Sync now” does the same thing immediately.
        </p>
      </div>
    </div>
  );
}

