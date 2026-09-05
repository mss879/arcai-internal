"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  BrainCircuit,
  Flame,
  Megaphone,
  MousePointerClick,
  RefreshCw,
  Send,
  Sparkles,
  Swords,
  Target,
  TrendingUp,
  Wrench,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { ForecastCard } from "@/components/finance/forecast-card";
import { TargetsCard } from "@/components/team/targets-card";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import type { CashForecast } from "@/lib/finance-forecast";
import type { TargetProgress } from "@/lib/targets";
import { cn, formatCurrency } from "@/lib/utils";
import type {
  AdEntry,
  AiDigest,
  ChurnAlert,
  Competitor,
  CompetitorEntry,
  VisitorEvent,
} from "@/lib/types";

import {
  runChurnScan,
  runDigest,
  runLeadScoring,
  sendWinback,
  setChurnAlertStatus,
} from "./actions";
import { AdsPanel, CompetitorsPanel, ToolkitPanel, VisitorsPanel } from "./panels";

type Tab =
  | "digest"
  | "goals"
  | "forecast"
  | "churn"
  | "ads"
  | "visitors"
  | "competitors"
  | "toolkit";
/** Every tab, for validating a `?tab=` deep link (T5.1 — the settings hub). */
const TAB_KEYS: Tab[] = ["digest", "goals", "forecast", "churn", "ads", "visitors", "competitors", "toolkit"];


/** 0119 — one month's targets against what happened. */
export type GoalMonth = { period: string; rows: TargetProgress[] };

export function IntelligenceView({
  digests,
  churnAlerts,
  ads,
  visitorEvents,
  competitors,
  competitorEntries,
  scores,
  goals = [],
  forecast = null,
  members = [],
  aiReady,
  smsReady,
  /** T5.1 — land on this tab from a link. Ignored when unknown. */
  initialTab,
}: {
  initialTab?: string;
  digests: AiDigest[];
  churnAlerts: ChurnAlert[];
  ads: AdEntry[];
  visitorEvents: VisitorEvent[];
  competitors: Competitor[];
  competitorEntries: CompetitorEntry[];
  scores: { hot: number; warm: number; cold: number; unscored: number };
  /** 0119 — newest month last. */
  goals?: GoalMonth[];
  forecast?: CashForecast | null;
  members?: { id: string; full_name: string | null }[];
  aiReady: boolean;
  smsReady: boolean;
}) {
  useRealtimeSync("churn_alerts");
  const [tab, setTab] = React.useState<Tab>(
    TAB_KEYS.includes(initialTab as Tab) ? (initialTab as Tab) : "digest",
  );
  const openAlerts = churnAlerts.filter((a) => a.status === "open");
  const thisMonth = goals[goals.length - 1];
  const behind = thisMonth?.rows.filter((r) => r.percent < 100).length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI & Intelligence"
        description="Your Monday digest, churn radar, lead scoring, ads attribution, visitor intelligence and competitor watch — one command center."
      />

      {!aiReady && (
        <Alert variant="info">
          <strong>AI features are running in basic mode.</strong> Add{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">OPENAI_API_KEY</code> to{" "}
          <code className="rounded bg-primary-100/60 px-1 py-0.5 text-xs">.env.local</code> for
          AI-written digests, win-back drafts, smart scoring and competitor briefs. Everything
          still works with built-in heuristics meanwhile.
        </Alert>
      )}

      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <TabButton active={tab === "digest"} onClick={() => setTab("digest")} icon={<Sparkles className="h-4 w-4" />}>
          Weekly Digest
        </TabButton>
        <TabButton
          active={tab === "goals"}
          onClick={() => setTab("goals")}
          icon={<Target className="h-4 w-4" />}
          count={behind}
        >
          Goals
        </TabButton>
        <TabButton
          active={tab === "forecast"}
          onClick={() => setTab("forecast")}
          icon={<TrendingUp className="h-4 w-4" />}
        >
          Forecast
        </TabButton>
        <TabButton
          active={tab === "churn"}
          onClick={() => setTab("churn")}
          icon={<AlertTriangle className="h-4 w-4" />}
          count={openAlerts.length}
        >
          Churn Alerts
        </TabButton>
        <TabButton active={tab === "ads"} onClick={() => setTab("ads")} icon={<Megaphone className="h-4 w-4" />}>
          Ads
        </TabButton>
        <TabButton
          active={tab === "visitors"}
          onClick={() => setTab("visitors")}
          icon={<MousePointerClick className="h-4 w-4" />}
        >
          Visitors
        </TabButton>
        <TabButton
          active={tab === "competitors"}
          onClick={() => setTab("competitors")}
          icon={<Swords className="h-4 w-4" />}
        >
          Competitors
        </TabButton>
        <TabButton active={tab === "toolkit"} onClick={() => setTab("toolkit")} icon={<Wrench className="h-4 w-4" />}>
          Toolkit
        </TabButton>
      </div>

      {tab === "digest" && <DigestTab digests={digests} scores={scores} aiReady={aiReady} />}
      {tab === "goals" && <GoalsTab goals={goals} members={members} />}
      {tab === "forecast" && <ForecastTab forecast={forecast} />}
      {tab === "churn" && <ChurnTab alerts={churnAlerts} smsReady={smsReady} />}
      {tab === "ads" && <AdsPanel ads={ads} />}
      {tab === "visitors" && <VisitorsPanel events={visitorEvents} />}
      {tab === "competitors" && (
        <CompetitorsPanel competitors={competitors} entries={competitorEntries} aiReady={aiReady} />
      )}
      {tab === "toolkit" && <ToolkitPanel aiReady={aiReady} />}
    </div>
  );
}

// ---- 0119: goals vs actual ----------------------------------------------------

const KIND_LABEL: Record<TargetProgress["kind"], string> = {
  revenue: "Revenue",
  deals_won: "Deals won",
  deliveries: "Delivered",
  leads: "New leads",
  hours: "Hours",
};

function GoalsTab({
  goals,
  members,
}: {
  goals: GoalMonth[];
  members: { id: string; full_name: string | null }[];
}) {
  const current = goals[goals.length - 1];
  const history = goals.slice(0, -1).filter((g) => g.rows.length > 0);

  if (!current) return null;

  return (
    <div className="space-y-6">
      <TargetsCard
        progress={current.rows}
        members={members}
        period={current.period}
        canEdit
      />

      {history.length > 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
          <h3 className="text-sm font-semibold text-slate-900">Earlier months</h3>
          <p className="mt-1 text-xs text-slate-500">
            How each target closed — a goal read as a trend rather than a bar.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3 font-semibold">Month</th>
                  <th className="py-2 pr-3 font-semibold">Target</th>
                  <th className="py-2 pr-3 text-right font-semibold">Aimed for</th>
                  <th className="py-2 pr-3 text-right font-semibold">Actual</th>
                  <th className="py-2 text-right font-semibold">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {history.flatMap((g) =>
                  g.rows.map((r) => (
                    <tr key={`${g.period}-${r.kind}-${r.userId ?? "team"}`} className="text-slate-700">
                      <td className="py-2 pr-3">{g.period.slice(0, 7)}</td>
                      <td className="py-2 pr-3">
                        {r.name ? `${r.name} · ` : ""}
                        {KIND_LABEL[r.kind]}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.kind === "revenue" ? formatCurrency(r.target) : r.target}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.kind === "revenue" ? formatCurrency(r.actual) : r.actual}
                      </td>
                      <td
                        className={cn(
                          "py-2 text-right font-semibold tabular-nums",
                          r.percent >= 100 ? "text-emerald-600" : "text-amber-600",
                        )}
                      >
                        {r.percent}%
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="px-1 text-xs text-slate-400">
          Earlier months appear here once a target has been set for them.
        </p>
      )}
    </div>
  );
}

function ForecastTab({ forecast }: { forecast: CashForecast | null }) {
  if (!forecast) {
    return (
      <EmptyState
        icon={<TrendingUp className="h-6 w-6" />}
        title="No forecast yet"
        description="The cash view reads payments, instalments, recurring income and expenses. It fills in as those are recorded."
      />
    );
  }
  return <ForecastCard weeks={forecast.weeks} standing={forecast.standing} asOf={forecast.asOf} />;
}

function TabButton({
  active,
  onClick,
  icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active ? "bg-primary-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {icon}
      {children}
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "ml-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ---- Digest tab -------------------------------------------------------------

function DigestTab({
  digests,
  scores,
  aiReady,
}: {
  digests: AiDigest[];
  scores: { hot: number; warm: number; cold: number; unscored: number };
  aiReady: boolean;
}) {
  const [generating, setGenerating] = React.useState(false);
  const [scoring, setScoring] = React.useState(false);
  const latest = digests[0] ?? null;

  async function handleGenerate() {
    setGenerating(true);
    const res = await runDigest();
    setGenerating(false);
    if (res.ok) toast.success("Digest generated.");
    else toast.error(res.error);
  }

  async function handleScore(rescoreAll: boolean) {
    setScoring(true);
    const res = await runLeadScoring(rescoreAll);
    setScoring(false);
    if (res.ok)
      toast.success(
        res.scored > 0
          ? `${res.scored} lead${res.scored === 1 ? "" : "s"} scored — hottest first on the CRM.`
          : "Nothing new to score.",
      );
    else toast.error(res.error);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-card)]">
          <div className="flex flex-wrap items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary-600 text-white">
              <BrainCircuit className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-slate-900">
                {latest ? `Week of ${latest.week_start}` : "Weekly business digest"}
              </h3>
              <p className="text-xs text-slate-400">
                {latest
                  ? `Generated ${formatDistanceToNow(new Date(latest.created_at), { addSuffix: true })}`
                  : "New leads, cold deals, unpaid money, best ad — plus your 3 actions."}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={handleGenerate} loading={generating}>
              <RefreshCw className="h-4 w-4" />
              {latest ? "Refresh" : "Generate now"}
            </Button>
          </div>

          {latest ? (
            <div className="mt-4 whitespace-pre-line rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
              {latest.content}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
              No digest yet — hit “Generate now”, or schedule{" "}
              <code className="rounded bg-slate-100 px-1 text-xs">/api/intelligence/digest</code>{" "}
              to run every Monday morning.
            </p>
          )}
        </div>

        {digests.length > 1 && (
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
            <h3 className="text-sm font-semibold text-slate-900">Past digests</h3>
            <div className="mt-3 space-y-3">
              {digests.slice(1).map((d) => (
                <details key={d.id} className="group rounded-xl border border-slate-100 px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium text-slate-700">
                    Week of {d.week_start}
                  </summary>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{d.content}</p>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-rose-500" />
            <h3 className="text-sm font-semibold text-slate-900">Lead scoring</h3>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {aiReady
              ? "AI ranks open leads hot/warm/cold so reps call the right people first."
              : "Heuristic scoring by activity, value and source (add an OpenAI key for smarter calls)."}
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <ScorePill label="Hot" value={scores.hot} tone="bg-rose-50 text-rose-600" />
            <ScorePill label="Warm" value={scores.warm} tone="bg-amber-50 text-amber-600" />
            <ScorePill label="Cold" value={scores.cold} tone="bg-sky-50 text-sky-600" />
          </div>
          {scores.unscored > 0 && (
            <p className="mt-2 text-center text-xs text-slate-400">
              {scores.unscored} lead{scores.unscored === 1 ? "" : "s"} not scored yet
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button className="flex-1" size="sm" onClick={() => handleScore(false)} loading={scoring}>
              Score new leads
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleScore(true)} disabled={scoring}>
              Re-score all
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 text-sm shadow-[var(--shadow-card)]">
          <h3 className="font-semibold text-slate-900">Schedule it</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Point a cron (Vercel Cron, cron-job.org) at{" "}
            <code className="rounded bg-slate-100 px-1 text-[11px]">/api/intelligence/digest</code>{" "}
            every Monday 8am and{" "}
            <code className="rounded bg-slate-100 px-1 text-[11px]">/api/automation/tick</code>{" "}
            every minute. The digest lands as a notification + push for the whole team.
          </p>
        </div>
      </div>
    </div>
  );
}

function ScorePill({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={cn("rounded-xl px-2 py-3", tone)}>
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[11px] font-medium opacity-80">{label}</p>
    </div>
  );
}

// ---- Churn tab ---------------------------------------------------------------

const SEVERITY_META = {
  cooling: { label: "Cooling", badge: "bg-amber-50 text-amber-600 ring-amber-200" },
  warm: { label: "At risk", badge: "bg-orange-50 text-orange-600 ring-orange-200" },
  cold: { label: "Cold", badge: "bg-sky-50 text-sky-600 ring-sky-200" },
} as const;

function ChurnTab({ alerts, smsReady }: { alerts: ChurnAlert[]; smsReady: boolean }) {
  const [scanning, setScanning] = React.useState(false);
  const open = alerts.filter((a) => a.status === "open");
  const handled = alerts.filter((a) => a.status !== "open");

  async function handleScan() {
    setScanning(true);
    const res = await runChurnScan();
    setScanning(false);
    if (res.ok)
      toast.success(
        res.created > 0
          ? `${res.created} cooling customer${res.created === 1 ? "" : "s"} flagged with drafted win-backs.`
          : "No new churn risks found — nice.",
      );
    else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Flags active clients with no payments or activity in 60+ days and drafts the win-back
          message for you.
        </p>
        <Button onClick={handleScan} loading={scanning}>
          <RefreshCw className="h-4 w-4" />
          Scan now
        </Button>
      </div>

      {open.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle className="h-6 w-6" />}
          title="No open churn alerts"
          description="Run a scan — the AI flags customers whose orders or activity dropped and drafts the message to win them back."
        />
      ) : (
        <div className="space-y-3">
          {open.map((alert) => (
            <ChurnCard key={alert.id} alert={alert} smsReady={smsReady} />
          ))}
        </div>
      )}

      {handled.length > 0 && (
        <details className="rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-[var(--shadow-card)]">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">
            Handled alerts ({handled.length})
          </summary>
          <div className="mt-3 space-y-2">
            {handled.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-sm text-slate-500">
                <Badge
                  className={
                    a.status === "actioned"
                      ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                      : "bg-slate-100 text-slate-500 ring-slate-200"
                  }
                >
                  {a.status}
                </Badge>
                {a.client_name}
                <span className="text-xs text-slate-400">— {a.reason}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ChurnCard({ alert, smsReady }: { alert: ChurnAlert; smsReady: boolean }) {
  const [message, setMessage] = React.useState(alert.draft_message ?? "");
  const [sending, setSending] = React.useState(false);

  async function handleSend() {
    setSending(true);
    const res = await sendWinback(alert.id, message);
    setSending(false);
    if (res.ok) toast.success(`Win-back SMS sent to ${alert.client_name}.`);
    else toast.error(res.error);
  }

  async function handleStatus(status: "actioned" | "dismissed") {
    const res = await setChurnAlertStatus(alert.id, status);
    if (!res.ok) toast.error(res.error);
  }

  const meta = SEVERITY_META[alert.severity];

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={meta.badge}>{meta.label}</Badge>
        <span className="text-sm font-semibold text-slate-900">{alert.client_name}</span>
        <span className="text-xs text-slate-400">· {alert.reason}</span>
        <span className="ml-auto flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => handleStatus("dismissed")}>
            Dismiss
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleStatus("actioned")}>
            Mark handled
          </Button>
        </span>
      </div>
      <div className="mt-3 space-y-2">
        <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">{message.length} characters</span>
          <Button
            size="sm"
            onClick={handleSend}
            loading={sending}
            disabled={!smsReady || !message.trim()}
            title={!smsReady ? "Notify.lk isn't configured" : undefined}
          >
            <Send className="h-3.5 w-3.5" />
            Send win-back SMS
          </Button>
        </div>
      </div>
    </div>
  );
}
