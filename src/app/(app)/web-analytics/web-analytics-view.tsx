"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  BarChart3,
  FileText,
  Globe2,
  History,
  MessageSquare,
  Plug,
  RefreshCw,
  Route,
  ScrollText,
  Sparkles,
  Target,
  Trash2,
  Users,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useRealtimeSyncTables } from "@/hooks/use-realtime-sync";
import { cn } from "@/lib/utils";
import type {
  WebChatSession,
  WebDaily,
  WebJourney,
  WebInsight,
  WebInsightTask,
  WebReport,
  WebSession,
} from "@/lib/types";
import type { JobSummary } from "@/lib/web-analytics/job-core";
import type { Range, Totals } from "@/lib/web-analytics/queries";

import {
  analyseChats,
  continueSync,
  deleteReport,
  dismissInsightTask,
  sendInsightToTodos,
  generateReport,
  rebuildNow,
  scanInsights,
  toggleInsightTask,
  syncNow,
  testConnection,
  type SyncStepView,
} from "./actions";
import {
  BarList,
  ChatPanel,
  FunnelPanel,
  InsightsPanel,
  JourneysPanel,
  PagesPanel,
  SessionsPanel,
  Stat,
  SyncPanel,
  TrendChart,
  secs,
  type Breakdown,
  type PageRow,
} from "./panels";

type Tab =
  | "overview"
  | "traffic"
  | "pages"
  | "journeys"
  | "visitors"
  | "chat"
  | "reports"
  | "setup";

const WINDOWS = [7, 14, 30, 90, 180, 365];

/**
 * The Web Analytics command centre.
 *
 * Deliberately a separate page from AI & Intelligence: that one is about
 * the CRM's own signals (churn, lead scoring, the snippet on client
 * sites). This one is about a single external property — the agency's own
 * website — and mixing the two would mean every panel had to explain
 * which site it was talking about.
 */
export function WebAnalyticsView({
  site,
  siteUrl,
  days,
  range,
  daily,
  totals,
  previousTotals,
  channels,
  devices,
  countries,
  browsers,
  sources,
  campaigns,
  topPages,
  transitions,
  paths,
  funnel,
  recentSessions,
  convertingSessions,
  chats,
  reports,
  syncStatus,
  job,
  intervalHours,
  insight,
  insightTasks,
  sourceReady,
  aiReady,
}: {
  site: string;
  siteUrl: string;
  days: number;
  range: Range;
  daily: WebDaily[];
  totals: Totals;
  previousTotals: Totals;
  channels: Breakdown;
  devices: Breakdown;
  countries: Breakdown;
  browsers: Breakdown;
  sources: Breakdown;
  campaigns: Breakdown;
  topPages: PageRow[];
  transitions: WebJourney[];
  paths: WebJourney[];
  funnel: { stage: string; sessions: number; rate: number }[];
  recentSessions: WebSession[];
  convertingSessions: WebSession[];
  chats: WebChatSession[];
  reports: WebReport[];
  syncStatus: {
    stream: string;
    lastRunAt: string | null;
    lastOkAt: string | null;
    rowsSynced: number;
    lastError: string | null;
  }[];
  job: JobSummary | null;
  intervalHours: number;
  insight: WebInsight | null;
  insightTasks: WebInsightTask[];
  sourceReady: boolean;
  aiReady: boolean;
}) {
  // The rollups land in web_daily; the job's progress lands in web_sync_state.
  useRealtimeSyncTables(["web_daily", "web_sync_state"]);
  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>("overview");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [openReport, setOpenReport] = React.useState<string | null>(reports[0]?.id ?? null);
  const [scanning, setScanning] = React.useState(false);

  const onToggleTask = async (id: string, done: boolean) => {
    const result = await toggleInsightTask(id, done);
    if (!result.ok) toast.error(result.error);
    else router.refresh();
  };

  const onDismissTask = async (id: string) => {
    const result = await dismissInsightTask(id);
    if (!result.ok) toast.error(result.error);
    else router.refresh();
  };

  const onSendTaskToTodos = async (id: string) => {
    const result = await sendInsightToTodos([id]);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Added to To-Dos — finishing it there ticks it off here.");
    router.refresh();
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const result = await scanInsights(days);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Scan complete.");
      router.refresh();
    } finally {
      setScanning(false);
    }
  };

  const hasData = totals.sessions > 0 || totals.pageviews > 0;

  const run = async (
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    onOk: (result: never) => string,
  ) => {
    setBusy(key);
    try {
      const result = await fn();
      if (!result.ok) {
        toast.error(result.error ?? "That did not work.");
        return;
      }
      toast.success(onOk(result as never));
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const [progress, setProgress] = React.useState<string | null>(null);

  /**
   * Drive a sync or rebuild job to completion while the page is open.
   *
   * Every server call is one bounded step — the platform kills a function at
   * ~26s, and a pull plus ninety days of rollups does not fit in one. So the
   * first call starts the job, and this keeps calling `continueSync` until
   * it reports done, showing where it has got to on the button. Closing the
   * page does not lose anything: the automation tick finishes the job.
   */
  const runJob = async (
    key: "sync" | "rebuild",
    first: () => Promise<{ ok: true; error?: undefined } & SyncStepView | { ok: false; error: string }>,
  ) => {
    setBusy(key);
    const describe = (step: SyncStepView) => {
      const phase =
        step.status === "busy"
          ? "waiting for the running step"
          : step.phase === "sync"
            ? "pulling"
            : step.phase === "rollup"
              ? `recomputing (${step.daysLeft} day${step.daysLeft === 1 ? "" : "s"} left)`
              : step.phase === "chats"
                ? "reading conversations"
                : step.phase === "report"
                  ? "writing the report"
                  : "finishing";
      return `${key === "rebuild" ? "Rebuilding" : "Syncing"} — ${phase}…`;
    };
    try {
      let result = await first();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      let rows = result.rows;
      let days = result.days;
      let chats = result.chats;
      const errors = new Set(result.errors);
      for (let i = 0; i < 80 && !result.done; i++) {
        setProgress(describe(result));
        if (i % 3 === 2) router.refresh();
        if (result.status === "busy") {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        const next = await continueSync();
        if (!next.ok) {
          toast.error(next.error);
          return;
        }
        result = next;
        rows += next.rows;
        days += next.days;
        chats += next.chats;
        for (const e of next.errors) errors.add(e);
      }
      const summary =
        `Pulled ${rows.toLocaleString()} rows and recomputed ${days} day${days === 1 ? "" : "s"}` +
        (chats ? `, read ${chats} conversation${chats === 1 ? "" : "s"}` : "") +
        (errors.size ? ` — ${errors.size} warning${errors.size === 1 ? "" : "s"}, see Setup.` : ".");
      if (result.done) toast.success(summary);
      else toast.info(`${summary} Still working — the automation tick finishes the rest within a few minutes.`);
      router.refresh();
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Web Analytics"
        description={`Everything ${siteUrl.replace(/^https?:\/\//, "")} knows about its visitors — where they came from, what they read, the route they took, and what it turned into.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              loading={busy === "sync"}
              onClick={() => runJob("sync", syncNow)}
            >
              <RefreshCw className="h-4 w-4" />{" "}
              {busy === "sync" && progress ? progress : "Sync now"}
            </Button>
            <Button
              loading={busy === "report"}
              onClick={() =>
                run("report", () => generateReport("weekly"), (r: { usedAi: boolean }) =>
                  r.usedAi ? "Report written." : "Report built from the numbers.",
                )
              }
            >
              <Sparkles className="h-4 w-4" /> Weekly report
            </Button>
          </div>
        }
      />

      {!sourceReady && (
        <Alert variant="error">
          <strong>The website source is not connected yet.</strong> Add{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">
            WEBSITE_SUPABASE_URL
          </code>{" "}
          and{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">
            WEBSITE_SUPABASE_SERVICE_ROLE_KEY
          </code>{" "}
          to the environment, then run the migration on the website project. Until then this
          page has nothing to read.
        </Alert>
      )}

      {sourceReady && !hasData && (
        <Alert variant="info">
          <strong>Connected, but nothing has arrived yet.</strong> Either the tracker has not
          been deployed to the site yet, or the first sync has not run. Use <em>Sync now</em>{" "}
          to pull immediately.
        </Alert>
      )}

      {!aiReady && (
        <Alert variant="info">
          <strong>Reports are running without AI.</strong> Add{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">OPENAI_API_KEY</code>{" "}
          for written narrative and conversation labelling. Every number, table and
          recommendation below is computed either way.
        </Alert>
      )}

      {/* Window picker */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Window
        </span>
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => router.push(`/web-analytics?days=${w}`)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-sm font-medium transition",
              w === days
                ? "bg-primary-500 text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
            )}
          >
            {w}d
          </button>
        ))}
        <span className="ml-1 text-xs text-slate-400">
          {range.from} → {range.to}
        </span>
      </div>

      {/* Tabs */}
      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<BarChart3 className="h-4 w-4" />}>
          Overview
        </TabButton>
        <TabButton active={tab === "traffic"} onClick={() => setTab("traffic")} icon={<Globe2 className="h-4 w-4" />}>
          Traffic
        </TabButton>
        <TabButton active={tab === "pages"} onClick={() => setTab("pages")} icon={<ScrollText className="h-4 w-4" />}>
          Pages
        </TabButton>
        <TabButton active={tab === "journeys"} onClick={() => setTab("journeys")} icon={<Route className="h-4 w-4" />}>
          Journeys
        </TabButton>
        <TabButton active={tab === "visitors"} onClick={() => setTab("visitors")} icon={<Users className="h-4 w-4" />}>
          Visitors
        </TabButton>
        <TabButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageSquare className="h-4 w-4" />}>
          AI Chat
        </TabButton>
        <TabButton active={tab === "reports"} onClick={() => setTab("reports")} icon={<FileText className="h-4 w-4" />}>
          Reports
        </TabButton>
        <TabButton active={tab === "setup"} onClick={() => setTab("setup")} icon={<Plug className="h-4 w-4" />}>
          Setup
        </TabButton>
      </div>

      {tab === "overview" && (
        <div className="space-y-6">
          {/* Above the numbers on purpose: the cards say what happened, this
              says what to do about it. */}
          <InsightsPanel
            insight={insight}
            tasks={insightTasks}
            onToggleTask={onToggleTask}
            onDismissTask={onDismissTask}
            onSendTaskToTodos={onSendTaskToTodos}
            scanning={scanning}
            onScan={runScan}
            aiReady={aiReady}
            hasData={hasData}
            days={days}
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Visits"
              value={totals.sessions.toLocaleString()}
              current={totals.sessions}
              previous={previousTotals.sessions}
            />
            <Stat
              label="People"
              value={totals.visitors.toLocaleString()}
              current={totals.visitors}
              previous={previousTotals.visitors}
              hint={`${totals.newVisitors} new · ${totals.returningVisitors} returning`}
            />
            <Stat
              label="Page views"
              value={totals.pageviews.toLocaleString()}
              current={totals.pageviews}
              previous={previousTotals.pageviews}
              hint={`${totals.pagesPerSession} per visit`}
            />
            <Stat
              label="Conversions"
              value={totals.conversions.toLocaleString()}
              current={totals.conversions}
              previous={previousTotals.conversions}
              hint={`${totals.conversionRate}% of visits`}
            />
            <Stat
              label="Engaged time"
              value={secs(totals.avgEngaged)}
              current={totals.avgEngaged}
              previous={previousTotals.avgEngaged}
              hint="visible and being used, not just open"
            />
            <Stat
              label="Bounce rate"
              value={`${totals.bounceRate}`}
              suffix="%"
              current={totals.bounceRate}
              previous={previousTotals.bounceRate}
              goodIsUp={false}
            />
            <Stat
              label="AI chats"
              value={totals.chatSessions.toLocaleString()}
              current={totals.chatSessions}
              previous={previousTotals.chatSessions}
              hint={`${totals.chatMessages} messages`}
            />
            <Stat
              label="Forms"
              value={`${totals.formsStarted}`}
              hint={`${totals.formsAbandoned} abandoned · ${totals.rageClicks} rage clicks`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <TrendChart rows={daily} metric="sessions" label="Visits per day" />
            <TrendChart rows={daily} metric="conversions" label="Conversions per day" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <FunnelPanel funnel={funnel} />
            <BarList title="Where visits came from" rows={channels} />
          </div>
        </div>
      )}

      {tab === "traffic" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <BarList title="Channels" rows={channels} limit={12} />
          <BarList title="Sources and referrers" rows={sources} limit={12} />
          <BarList title="Campaigns (UTM)" rows={campaigns} limit={10} emptyLabel="No tagged campaigns in this window." />
          <BarList title="Countries" rows={countries} limit={15} />
          <BarList title="Devices" rows={devices} limit={6} />
          <BarList title="Browsers" rows={browsers} limit={10} />
        </div>
      )}

      {tab === "pages" && <PagesPanel pages={topPages} siteUrl={siteUrl} />}

      {tab === "journeys" && <JourneysPanel paths={paths} transitions={transitions} />}

      {tab === "visitors" && (
        <div className="space-y-6">
          <div>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Target className="h-4 w-4 text-emerald-600" /> Visits that converted
            </h2>
            <SessionsPanel
              sessions={convertingSessions}
              emptyTitle="No conversions in this window"
              emptyDescription="A visit counts as converted when it submits a form, clicks to call or opens WhatsApp."
            />
          </div>
          <div>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Users className="h-4 w-4 text-slate-400" /> Most recent visits
            </h2>
            <SessionsPanel
              sessions={recentSessions}
              emptyTitle="No visits recorded yet"
              emptyDescription="Individual visits appear here as soon as the tracker is live and the first sync has run."
            />
          </div>
        </div>
      )}

      {tab === "chat" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-500">
              Every conversation the website&apos;s AI agent has had, mirrored here and
              labelled by topic, intent and buying signal.
            </p>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "chats"}
              disabled={!aiReady}
              onClick={() =>
                run("chats", analyseChats, (r: { analysed: number }) =>
                  r.analysed ? `Read ${r.analysed} conversation(s).` : "Nothing new to read.",
                )
              }
            >
              <Sparkles className="h-4 w-4" /> Label new conversations
            </Button>
          </div>
          <ChatPanel chats={chats} />
        </div>
      )}

      {tab === "reports" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(["daily", "weekly", "monthly", "quarterly"] as const).map((kind) => (
              <Button
                key={kind}
                variant="secondary"
                size="sm"
                loading={busy === `report-${kind}`}
                onClick={() =>
                  run(`report-${kind}`, () => generateReport(kind), () => `${kind} report ready.`)
                }
              >
                <FileText className="h-4 w-4" />
                {kind[0].toUpperCase() + kind.slice(1)}
              </Button>
            ))}
          </div>

          {reports.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-6 w-6" />}
              title="No reports yet"
              description="Generate one above, or wait for the morning run — a daily report is written automatically at 06:00 UTC."
            />
          ) : (
            <div className="space-y-3">
              {reports.map((report) => {
                const isOpen = openReport === report.id;
                const highlights = (report.highlights ?? []) as string[];
                const recommendations = (report.recommendations ?? []) as string[];
                return (
                  <div
                    key={report.id}
                    className="rounded-2xl border border-slate-200 bg-white shadow-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 p-4">
                      <button
                        type="button"
                        onClick={() => setOpenReport(isOpen ? null : report.id)}
                        className="flex-1 text-left"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className="bg-primary-50 text-primary-700 ring-primary-200">
                            {report.kind}
                          </Badge>
                          <span className="text-sm font-medium text-slate-800">
                            {report.period_start} → {report.period_end}
                          </span>
                          {report.generated_by === "computed" && (
                            <Badge>no AI</Badge>
                          )}
                          <span className="text-xs text-slate-400">
                            {formatDistanceToNow(new Date(report.created_at), {
                              addSuffix: true,
                            })}
                          </span>
                        </div>
                        {highlights.length > 0 && (
                          <p className="mt-1 text-sm text-slate-600">{highlights[0]}</p>
                        )}
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          run("delete", () => deleteReport(report.id), () => "Report deleted.")
                        }
                        aria-label="Delete report"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {isOpen && (
                      <div className="border-t border-slate-100 p-4">
                        {recommendations.length > 0 && (
                          <div className="mb-4 rounded-xl bg-primary-50/60 p-3">
                            <p className="text-xs font-medium uppercase tracking-wide text-primary-700">
                              What to do next
                            </p>
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-slate-700">
                              {recommendations.map((rec, i) => (
                                <li key={i}>{String(rec)}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <pre className="overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-700">
                          {report.content}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "setup" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "ping"}
              onClick={() =>
                run("ping", testConnection, (r: { sessions: number }) =>
                  `Connected — ${r.sessions.toLocaleString()} sessions on the website.`,
                )
              }
            >
              <Plug className="h-4 w-4" /> Test connection
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "rebuild"}
              onClick={() => runJob("rebuild", () => rebuildNow(90))}
            >
              <History className="h-4 w-4" />{" "}
              {busy === "rebuild" && progress ? progress : "Rebuild history"}
            </Button>
          </div>
          <SyncPanel
            status={syncStatus}
            job={job}
            intervalHours={intervalHours}
            site={site}
            siteUrl={siteUrl}
            sourceReady={sourceReady}
          />
        </div>
      )}
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
        active
          ? "bg-primary-500 text-white shadow-sm"
          : "text-slate-600 hover:bg-slate-50",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
