"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Activity,
  BarChart3,
  CalendarDays,
  Copy,
  Database,
  ExternalLink,
  LayoutGrid,
  MessageCircle,
  Sparkles,
  Target,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { worstLevel, type FunnelStage, type HealthLevel, type HealthSignal } from "@/lib/meta-ads/health-core";
import type { AdsPageData, AdsReport } from "@/lib/meta-ads/queries";
import { ADS_WINDOWS, formatColombo, formatMoney, syncedAtOf, type AdsWindowKey } from "@/lib/meta-ads/report-core";
import type { MetaAdSync } from "@/lib/types";
import { cn } from "@/lib/utils";

import { BarList, Stat, TrendChart } from "../web-analytics/panels";

/** What the owner types to Claude to refresh this page (docs/meta-ads.md). */
const SYNC_PROMPT = "sync my ads";

const PAGE_DESCRIPTION =
  "What the Meta ads cost, next to what they produced here — WhatsApp chats, qualified leads and booked calls.";

const WINDOW_LABEL: Record<AdsWindowKey, string> = { flight: "Flight", "7d": "7d", "30d": "30d" };

const LEVEL_TONE: Record<HealthLevel, string> = {
  act: "bg-rose-50 text-rose-700 ring-rose-200",
  watch: "bg-amber-50 text-amber-700 ring-amber-200",
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};
const LEVEL_LABEL: Record<HealthLevel, string> = { act: "Act", watch: "Watch", good: "Good" };

type Tab = "overview" | "ads" | "daily" | "conversations";

const num = (n: number) => n.toLocaleString("en-US");
const pct = (n: number | null, digits = 2) => (n === null ? "—" : `${n.toFixed(digits)}%`);

/**
 * The Ads section (0132).
 *
 * Nothing here can refresh the Meta numbers: there is no Meta token in this
 * app, by the owner's choice. The page says when Claude last synced and how
 * to ask for another, and everything CRM-side is live on every load.
 */
export function AdsView({ data }: { data: AdsPageData }) {
  if (data.state === "setup") {
    return (
      <div className="space-y-6">
        <PageHeader title="Ads" description={PAGE_DESCRIPTION} />
        <EmptyState
          icon={<Database className="h-6 w-6" />}
          title="Ads needs migrations 0132 and 0133"
          description="Apply supabase/migrations/0132_meta_ads.sql, then 0133_meta_ad_syncs_synced_at.sql, in the Supabase SQL editor (docs/ops.md → Meta Ads). Until then there is nowhere for ad numbers to land — WhatsApp keeps working as before."
        />
      </div>
    );
  }

  if (data.state === "empty") {
    return (
      <div className="space-y-6">
        <PageHeader title="Ads" description={PAGE_DESCRIPTION} actions={<SyncHint lastSync={data.lastSync} />} />
        <EmptyState
          icon={<Target className="h-6 w-6" />}
          title="No ad data yet"
          description={
            data.lastSync
              ? "A sync was recorded, but it carried no campaign to show numbers against. Ask Claude to “sync my ads” again, with the campaign, its ad sets and its ads as entities."
              : "Ask Claude to “sync my ads” in a Claude Code session with the Meta Ads connector. It pulls the campaigns and daily numbers and writes them here with scripts/ads-sync.mjs."
          }
        />
      </div>
    );
  }

  return <Report data={data} />;
}

function Report({ data }: { data: AdsReport }) {
  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>("overview");
  const { campaign, totals, crm, currency } = data;
  const money = (n: number | null | undefined, digits = 0) => formatMoney(n, currency, digits);

  const go = (campaignId: string, window: AdsWindowKey) =>
    router.push(`/ads?campaign=${encodeURIComponent(campaignId)}&window=${window}`);

  const status = (campaign.effective_status ?? campaign.status ?? "unknown").toLowerCase().replace(/_/g, " ");

  return (
    <div className="space-y-6">
      <PageHeader title="Ads" description={PAGE_DESCRIPTION} actions={<SyncHint lastSync={data.lastSync} />} />

      {/* Campaign + window */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="ads-campaign" className="sr-only">
            Campaign
          </label>
          <select
            id="ads-campaign"
            value={campaign.id}
            onChange={(e) => go(e.target.value, data.window)}
            className="h-9 min-w-0 max-w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm sm:max-w-md"
          >
            {data.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Badge className={status === "active" ? LEVEL_TONE.good : undefined}>{status}</Badge>
          <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" />
          {ADS_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => go(campaign.id, w)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-sm font-medium transition",
                w === data.window
                  ? "bg-primary-500 text-white"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
              )}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
          <span className="ml-1 text-xs text-slate-400">
            {data.range.from} → {data.range.to} (Colombo days)
          </span>
        </div>
        <p className="text-xs text-slate-500">
          {campaign.daily_budget !== null && `${money(campaign.daily_budget)}/day · `}
          {campaign.lifetime_budget !== null && `${money(campaign.lifetime_budget)} lifetime · `}
          {formatColombo(campaign.start_time)} → {campaign.end_time ? formatColombo(campaign.end_time) : "no end date"}
          {campaign.objective && ` · ${campaign.objective.toLowerCase().replace(/_/g, " ")}`}
        </p>
      </div>

      {data.capped && (
        <Alert variant="info">
          More WhatsApp contacts arrived in this window than the page reads at once, so the CRM
          figures are a floor. Narrow the window for exact numbers.
        </Alert>
      )}

      {/* Tabs */}
      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<BarChart3 className="h-4 w-4" />}>
          Overview
        </TabButton>
        <TabButton active={tab === "ads"} onClick={() => setTab("ads")} icon={<LayoutGrid className="h-4 w-4" />}>
          By ad
        </TabButton>
        <TabButton active={tab === "daily"} onClick={() => setTab("daily")} icon={<CalendarDays className="h-4 w-4" />}>
          Daily
        </TabButton>
        <TabButton
          active={tab === "conversations"}
          onClick={() => setTab("conversations")}
          icon={<MessageCircle className="h-4 w-4" />}
        >
          Conversations
        </TabButton>
      </div>

      {tab === "overview" && (
        <div className="space-y-6">
          {/* Above the numbers on purpose: the cards say what happened, these
              say what to do about it. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <HealthPanel signals={data.signals} />
            <NotesPanel sync={data.lastSync} />
          </div>

          <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Meta — what the ads delivered
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Spend"
                value={money(totals.spend)}
                hint={campaign.daily_budget !== null ? `on ${money(campaign.daily_budget)}/day` : undefined}
              />
              <Stat
                label="Impressions"
                value={num(totals.impressions)}
                hint={totals.frequency !== null ? `frequency ≥ ${totals.frequency.toFixed(2)}` : undefined}
              />
              <Stat
                label="Reach"
                value={num(totals.reach)}
                hint="daily reach, summed — repeat viewers count once per day"
              />
              <Stat
                label="Link CTR"
                value={pct(totals.linkCtr)}
                hint={`${num(totals.link_clicks)} taps to WhatsApp`}
              />
              <Stat label="CPM" value={money(totals.cpm)} hint="cost per 1,000 impressions" />
              <Stat
                label="WhatsApp conversations"
                value={num(totals.conversations)}
                hint="Meta's count of chats started"
              />
              <Stat
                label="Cost / conversation"
                value={money(totals.costPerConversation)}
                hint="spend ÷ Meta's conversations"
              />
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              CRM — what the chats became (live)
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Stat
                label="Ad contacts in CRM"
                value={num(crm.adContacts)}
                hint={`${data.matched.referral} by Meta's referral · ${data.matched.prefill} by prefilled text`}
              />
              <Stat
                label="Replied"
                value={num(crm.replied)}
                hint="wrote again after the ad's opening message"
              />
              <Stat label="Named leads" value={num(crm.inCrm)} hint="linked to a lead in the pipeline" />
              <Stat label="Qualified" value={num(crm.qualified)} hint="booked a call, or lead scored hot" />
              <Stat label="Calls booked" value={num(crm.booked)} hint="people with an agreed call slot" />
              <Stat
                label="Cost / booked call"
                value={money(data.costPerBooked)}
                hint="the number to decide on"
              />
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <AdsFunnel funnel={data.funnel} />
            <div className="space-y-6">
              <BarList
                title="Ad contacts by ad"
                rows={data.ads.map((a) => ({ key: `${a.letter} · ${a.name}`, count: a.contacts }))}
                emptyLabel="No ads synced for this campaign."
              />
              <BarList
                title="How they were matched"
                rows={[
                  { key: "Meta's referral (ad id)", count: data.matched.referral },
                  { key: "The ad's prefilled message", count: data.matched.prefill },
                ].filter((r) => r.count > 0)}
                emptyLabel="No ad contacts in this window."
              />
            </div>
          </div>
        </div>
      )}

      {tab === "ads" && <AdsTable data={data} />}

      {tab === "daily" && (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <TrendChart rows={data.daily} metric="spend" label={`Spend per day (${currency})`} />
            <TrendChart rows={data.daily} metric="conversations" label="WhatsApp conversations per day" />
          </div>
          <DailyTable data={data} />
        </div>
      )}

      {tab === "conversations" && <ConversationsTable data={data} />}
    </div>
  );
}

// -- header -------------------------------------------------------------------

function SyncHint({ lastSync }: { lastSync: MetaAdSync | null }) {
  // When the numbers were read from Meta, not when the row was written.
  const syncedAt = syncedAtOf(lastSync);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SYNC_PROMPT);
      toast.success("Copied — paste it to Claude.");
    } catch {
      toast.error("Could not copy. Type it to Claude: sync my ads");
    }
  };
  return (
    <div className="flex flex-col items-start gap-1 text-xs sm:items-end">
      <p className="text-slate-500">
        Last synced by Claude:{" "}
        <span className="font-medium text-slate-700" suppressHydrationWarning>
          {syncedAt ? formatDistanceToNow(new Date(syncedAt), { addSuffix: true }) : "never"}
        </span>
      </p>
      <p className="flex items-center gap-1.5 text-slate-400">
        To refresh, ask Claude:
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{SYNC_PROMPT}</code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy the sync request"
          title="Copy"
          className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
        active ? "bg-primary-500 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// -- overview panels ----------------------------------------------------------

function HealthPanel({ signals }: { signals: HealthSignal[] }) {
  const worst = worstLevel(signals);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900">Health</h2>
        </div>
        {worst && <Badge className={LEVEL_TONE[worst]}>{LEVEL_LABEL[worst]}</Badge>}
      </header>
      {signals.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">Nothing to flag in this window.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {signals.map((s) => (
            <li key={`${s.level}-${s.code}`} className="flex gap-3 px-4 py-3">
              <Badge className={cn("mt-0.5 h-fit shrink-0", LEVEL_TONE[s.level])}>{LEVEL_LABEL[s.level]}</Badge>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{s.title}</p>
                <p className="mt-0.5 text-sm text-slate-600">{s.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The analyst's read, written by Claude with the sync that produced these numbers. */
function NotesPanel({ sync }: { sync: MetaAdSync | null }) {
  const recommendations = (sync?.recommendations ?? []).filter((r) => typeof r === "string" && r.trim());
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-primary-50/70 to-white px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary-500" />
          <h2 className="text-sm font-semibold text-slate-900">Claude&apos;s read</h2>
        </div>
        {sync?.health && <Badge className={LEVEL_TONE[sync.health]}>{LEVEL_LABEL[sync.health]}</Badge>}
      </header>
      <div className="space-y-3 px-4 py-4">
        {!sync ? (
          <p className="text-sm text-slate-500">No sync has been recorded for this ad account yet.</p>
        ) : !sync.summary && recommendations.length === 0 ? (
          <p className="text-sm text-slate-500">The last sync carried numbers only, no notes.</p>
        ) : (
          <>
            {sync.summary && <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{sync.summary}</p>}
            {recommendations.length > 0 && (
              <ul className="space-y-1.5 text-sm text-slate-700">
                {recommendations.map((rec, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {sync && (
          <p className="text-[11px] text-slate-400">
            Numbers read from Meta {formatColombo(syncedAtOf(sync))} · window {sync.window_start ?? "?"} → {sync.window_end ?? "?"} ·{" "}
            {sync.entities_upserted} entities, {sync.insights_upserted} day rows. It is the read at sync time; the
            health list beside it is recomputed on every load.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Impressions down to booked calls.
 *
 * Bars are on a LOG scale: each step here is an order of magnitude below the
 * last (thousands of impressions, dozens of taps, a handful of calls), and on
 * a linear scale everything after the first bar is an invisible sliver.
 */
function AdsFunnel({ funnel }: { funnel: FunnelStage[] }) {
  const max = Math.max(...funnel.map((s) => s.value), 1);
  const width = (v: number) => (v > 0 ? Math.max(2, (Math.log10(v + 1) / Math.log10(max + 1)) * 100) : 0);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="mb-1 text-sm font-medium text-slate-700">From impression to booked call</p>
      <p className="mb-3 text-xs text-slate-400">
        Bars on a log scale. Percentages are of the step above.
      </p>
      <ul className="space-y-2.5">
        {funnel.map((stage, idx) => (
          <React.Fragment key={stage.key}>
            {idx > 0 && funnel[idx - 1].source !== stage.source && (
              <li className="flex items-center gap-2 pt-1 text-[11px] uppercase tracking-wide text-slate-400">
                <span className="h-px flex-1 bg-slate-200" />
                Meta above · CRM below — two systems, never an exact match
                <span className="h-px flex-1 bg-slate-200" />
              </li>
            )}
            <li>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-slate-700">{stage.label}</span>
                <span className="tabular-nums text-slate-500">
                  {num(stage.value)}
                  {stage.ofPrevious !== null && (
                    <span className="ml-1 text-xs text-slate-400">({pct(stage.ofPrevious, 1)})</span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn("h-full rounded-full", stage.source === "meta" ? "bg-primary-500" : "bg-emerald-500")}
                  style={{ width: `${width(stage.value)}%` }}
                />
              </div>
            </li>
          </React.Fragment>
        ))}
      </ul>
    </div>
  );
}

// -- by ad --------------------------------------------------------------------

function AdsTable({ data }: { data: AdsReport }) {
  const money = (n: number | null) => formatMoney(n, data.currency);
  if (!data.ads.length) {
    return (
      <EmptyState
        icon={<LayoutGrid className="h-6 w-6" />}
        title="No ads synced for this campaign"
        description="The last sync carried the campaign but not its ads. Ask Claude to sync again with ad-level entities and insights."
      />
    );
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[1040px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Ad</th>
              <th className="px-3 py-3 font-medium">Prefilled message</th>
              <th className="px-3 py-3 text-right font-medium">Spend</th>
              <th className="px-3 py-3 text-right font-medium">Link CTR</th>
              <th className="px-3 py-3 text-right font-medium">Conv.</th>
              <th className="px-3 py-3 text-right font-medium">Cost/conv.</th>
              <th className="px-3 py-3 text-right font-medium">CRM contacts</th>
              <th className="px-3 py-3 text-right font-medium">Booked</th>
              <th className="px-4 py-3 text-right font-medium">Cost/booked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.ads.map((ad) => (
              <tr key={ad.id} className="align-top hover:bg-slate-50/60">
                <td className="max-w-[280px] px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Badge className="bg-primary-50 text-primary-700 ring-primary-200">{ad.letter}</Badge>
                    <span className="truncate font-medium text-slate-800" title={ad.name}>
                      {ad.name}
                    </span>
                  </div>
                  {ad.headline && <p className="mt-1 text-xs text-slate-500">{ad.headline}</p>}
                  {ad.status && <p className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">{ad.status.toLowerCase().replace(/_/g, " ")}</p>}
                </td>
                <td className="max-w-[300px] px-3 py-3 text-xs text-slate-600">
                  {ad.prefill ? `“${ad.prefill}”` : <span className="text-rose-500">none synced — only a referral can credit this ad</span>}
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-700">{money(ad.spend)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-500">{pct(ad.linkCtr)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-700">{num(ad.conversations)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-500">{money(ad.costPerConversation)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-700">{num(ad.contacts)}</td>
                <td className="px-3 py-3 text-right tabular-nums font-medium text-emerald-600">{ad.booked || "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-800">{money(ad.costPerBooked)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">
        A contact is credited to an ad when Meta&apos;s referral names it, or when their first message
        starts with its prefilled text (docs/meta-ads.md). Spend and conversations are Meta&apos;s; contacts
        and bookings are the CRM&apos;s, live.
      </p>
    </div>
  );
}

// -- daily --------------------------------------------------------------------

function DailyTable({ data }: { data: AdsReport }) {
  const rows = [...data.daily].reverse();
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Day (Colombo)</th>
            <th className="px-3 py-3 text-right font-medium">Spend</th>
            <th className="px-3 py-3 text-right font-medium">Impressions</th>
            <th className="px-3 py-3 text-right font-medium">Taps</th>
            <th className="px-3 py-3 text-right font-medium">Conv.</th>
            <th className="px-4 py-3 text-right font-medium">Cost/conv.</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((d) => (
            <tr key={d.day}>
              <td className="px-4 py-2.5 font-medium text-slate-700">{d.day}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{formatMoney(d.spend, data.currency)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{num(d.impressions)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{num(d.link_clicks)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{num(d.conversations)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                {formatMoney(d.conversations ? d.spend / d.conversations : null, data.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -- conversations ------------------------------------------------------------

function ConversationsTable({ data }: { data: AdsReport }) {
  if (!data.conversations.length) {
    return (
      <EmptyState
        icon={<MessageCircle className="h-6 w-6" />}
        title="No ad contacts in this window"
        description="When someone taps one of these ads and writes, they appear here — matched by Meta's referral or by the ad's prefilled message."
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[980px] text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/70 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Arrived (Colombo)</th>
            <th className="px-3 py-3 font-medium">Contact</th>
            <th className="px-3 py-3 font-medium">First message</th>
            <th className="px-3 py-3 font-medium">Ad</th>
            <th className="px-3 py-3 font-medium">Matched by</th>
            <th className="px-3 py-3 font-medium">Replied</th>
            <th className="px-3 py-3 font-medium">Lead</th>
            <th className="px-4 py-3 font-medium">Call booked for</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.conversations.map((c) => (
            <tr key={c.contactId} className="align-top hover:bg-slate-50/60">
              <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500">{formatColombo(c.enteredAt)}</td>
              <td className="max-w-[180px] px-3 py-2.5">
                <Link
                  href={c.href}
                  className="inline-flex max-w-full items-center gap-1 font-medium text-slate-800 hover:text-primary-600 hover:underline"
                  title="Open the WhatsApp thread"
                >
                  <span className="truncate">{c.name}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 text-slate-400" />
                </Link>
              </td>
              <td className="max-w-[280px] px-3 py-2.5 text-xs text-slate-600">
                <span className="line-clamp-2" title={c.firstMessage ?? undefined}>
                  {c.firstMessage ?? "—"}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <Badge className="bg-primary-50 text-primary-700 ring-primary-200" title={c.adName}>
                  {c.adLetter}
                </Badge>
              </td>
              <td className="px-3 py-2.5 text-xs text-slate-500">
                {c.method === "referral" ? "referral" : "prefill"}
              </td>
              <td className="px-3 py-2.5 text-xs">
                {c.replied ? <span className="text-emerald-600">yes</span> : <span className="text-slate-400">no</span>}
              </td>
              <td className="max-w-[200px] px-3 py-2.5 text-xs">
                {c.leadId ? (
                  <span className="inline-flex max-w-full items-center gap-1.5">
                    <span className="truncate text-slate-700" title={c.leadTitle ?? undefined}>
                      {c.leadTitle ?? "lead"}
                    </span>
                    {c.leadScore && (
                      <Badge className={c.leadScore === "hot" ? LEVEL_TONE.act : undefined}>{c.leadScore}</Badge>
                    )}
                  </span>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-xs font-medium text-emerald-700">
                {c.bookedAt ? formatColombo(c.bookedAt) : <span className="font-normal text-slate-400">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
