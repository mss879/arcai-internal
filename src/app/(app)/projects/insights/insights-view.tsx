"use client";

/**
 * Project insights (theme 5, 0098).
 *
 * Five tabs, one idea: the projects already know things nobody has asked them.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  BookOpen,
  Check,
  MessageCircleQuestion,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectsSectionNav } from "@/components/projects/section-nav";
import type {
  ProjectAnomalyKind,
  ProjectLessonCategory,
  ProjectLessonStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  askAboutProjects,
  decideLesson,
  rescanAnomalies,
  resolveAnomaly,
} from "../ai-actions";

type Tab = "ask" | "risk" | "lessons" | "guards";

type RiskRow = {
  id: string;
  name: string;
  risk_rank: number;
  risk_note: string | null;
  risk_checked_at: string | null;
  due_date: string | null;
  delivery_stage: string | null;
  client: { name: string } | null;
};

type LessonRow = {
  id: string;
  project_id: string | null;
  project_name: string;
  title: string;
  body: string;
  category: ProjectLessonCategory;
  status: ProjectLessonStatus;
  evidence: Record<string, unknown>;
  created_at: string;
};

type AnomalyRow = {
  id: string;
  project_id: string | null;
  kind: ProjectAnomalyKind;
  detail: string;
  evidence: Record<string, unknown>;
  created_at: string;
  project: { name: string } | null;
};

const ANOMALY_META: Record<ProjectAnomalyKind, { label: string; tone: string }> = {
  duplicate_expense: { label: "Expense twice", tone: "bg-amber-50 text-amber-700" },
  duplicate_payment: { label: "Payment twice", tone: "bg-rose-50 text-rose-700" },
  duplicate_project: { label: "Project twice", tone: "bg-rose-50 text-rose-700" },
  payment_over_value: { label: "Overpaid", tone: "bg-sky-50 text-sky-700" },
  expense_no_receipt: { label: "No receipt", tone: "bg-slate-100 text-slate-600" },
};

const LESSON_TONE: Record<ProjectLessonCategory, string> = {
  pricing: "bg-emerald-50 text-emerald-700",
  scope: "bg-amber-50 text-amber-700",
  timeline: "bg-sky-50 text-sky-700",
  delivery: "bg-violet-50 text-violet-700",
  client: "bg-rose-50 text-rose-700",
};

export function InsightsView({
  aiReady,
  risk,
  lessons,
  anomalies,
}: {
  aiReady: boolean;
  risk: RiskRow[];
  lessons: LessonRow[];
  anomalies: AnomalyRow[];
}) {
  const [tab, setTab] = React.useState<Tab>("ask");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project insights"
        description="What needs you today, anything you want to ask the projects, and what finished work taught us. The charts live under Reports."
      />

      <ProjectsSectionNav />

      {!aiReady && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-xs leading-relaxed text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-semibold">No OPENAI_API_KEY is set.</span> The
            benchmarks and the guards below are arithmetic and still work — asking
            questions, the written risk reasons and post-mortems need the key.
          </p>
        </div>
      )}

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="inline-flex min-w-max rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <TabButton active={tab === "ask"} onClick={() => setTab("ask")} icon={<MessageCircleQuestion className="h-4 w-4" />}>
            Ask
          </TabButton>
          <TabButton active={tab === "risk"} onClick={() => setTab("risk")} icon={<AlertTriangle className="h-4 w-4" />} count={risk.length}>
            At risk
          </TabButton>
          <TabButton active={tab === "lessons"} onClick={() => setTab("lessons")} icon={<BookOpen className="h-4 w-4" />} count={lessons.filter((l) => l.status === "new").length}>
            Lessons
          </TabButton>
          <TabButton active={tab === "guards"} onClick={() => setTab("guards")} icon={<ShieldAlert className="h-4 w-4" />} count={anomalies.length}>
            Guards
          </TabButton>
        </div>
      </div>

      {tab === "ask" && <AskTab aiReady={aiReady} />}
      {tab === "risk" && <RiskTab rows={risk} />}
      {tab === "lessons" && <LessonsTab rows={lessons} />}
      {tab === "guards" && <GuardsTab rows={anomalies} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI-8 — Ask                                                          */
/* ------------------------------------------------------------------ */

const SUGGESTIONS = [
  "Which clients still owe money on delivered work?",
  "What did we spend on hosting this year?",
  "Which projects went over a month?",
  "What's the average margin on e-commerce builds?",
];

function AskTab({ aiReady }: { aiReady: boolean }) {
  const [question, setQuestion] = React.useState("");
  const [asking, setAsking] = React.useState(false);
  const [answer, setAnswer] = React.useState<{
    answer: string;
    rows: { project: string; client: string; detail: string; href: string }[];
  } | null>(null);

  async function ask(q?: string) {
    const text = (q ?? question).trim();
    if (!text) return;
    setQuestion(text);
    setAsking(true);
    setAnswer(null);
    const res = await askAboutProjects(text);
    setAsking(false);
    if (res.ok) setAnswer(res.result);
    else toast.error(res.error);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
            placeholder="Ask anything about the projects…"
            disabled={!aiReady}
          />
          <Button onClick={() => ask()} loading={asking} disabled={!aiReady}>
            <Send className="h-4 w-4" /> Ask
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              disabled={!aiReady || asking}
              className="rounded-full bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-white hover:text-primary-700 disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-slate-400">
          Answered from the project data itself — no SQL is generated and nothing
          is written. Every project listed links back so you can check the figure.
        </p>
      </div>

      {answer && (
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-[var(--shadow-card)]">
          <div className="flex items-start gap-2.5 border-b border-slate-100 px-5 py-4">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" />
            <p className="text-sm leading-relaxed text-slate-700">{answer.answer}</p>
          </div>
          {answer.rows.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {answer.rows.map((r, i) => (
                <li key={i}>
                  <Link
                    href={r.href}
                    className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-slate-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-800">
                        {r.project}
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {r.client}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">
                      {r.detail}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI-4 — Risk radar                                                   */
/* ------------------------------------------------------------------ */

function RiskTab({ rows }: { rows: RiskRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" />}
        title="Nothing flagged"
        description="The radar ranks open projects once a night. Either everything is healthy, or it hasn't run yet."
      />
    );
  }

  const checked = rows[0].risk_checked_at;

  return (
    <div className="space-y-3">
      {checked && (
        <p className="px-1 text-xs text-slate-400">
          Last pass {format(parseISO(checked), "d MMM yyyy 'at' HH:mm")}. The top
          three were pushed to the team.
        </p>
      )}
      <ol className="space-y-2">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/projects/${r.id}`}
              className="flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[var(--shadow-card)] transition hover:border-primary-300 hover:shadow-[var(--shadow-lift)]"
            >
              <span
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold",
                  r.risk_rank <= 3
                    ? "bg-rose-50 text-rose-600"
                    : "bg-slate-100 text-slate-500",
                )}
              >
                {r.risk_rank}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">
                  {r.name}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-slate-600">
                  {r.risk_note ?? "Flagged by the health score."}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {[
                    r.client?.name,
                    r.delivery_stage,
                    r.due_date ? `due ${r.due_date}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI-6 — Lessons                                                      */
/* ------------------------------------------------------------------ */

function LessonsTab({ rows }: { rows: LessonRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function decide(id: string, status: ProjectLessonStatus) {
    setBusy(id);
    const res = await decideLesson(id, status);
    setBusy(null);
    if (res.ok) {
      toast.success(status === "kept" ? "Kept — this will inform future estimates." : "Dismissed.");
      router.refresh();
    } else toast.error(res.error);
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<BookOpen className="h-6 w-6" />}
        title="No lessons yet"
        description="Run a post-mortem from a finished project's page and what it taught us lands here for you to keep or dismiss."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-slate-400">
        Approve-first, like the WhatsApp agent&apos;s lessons: only what you{" "}
        <span className="font-semibold text-slate-600">keep</span> is ever quoted
        back into an estimate.
      </p>
      {rows.map((l) => (
        <div
          key={l.id}
          className={cn(
            "rounded-2xl border bg-white p-5 shadow-[var(--shadow-card)]",
            l.status === "new" ? "border-primary-200" : "border-slate-200/80",
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={LESSON_TONE[l.category]}>{l.category}</Badge>
                {l.status === "kept" && (
                  <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">
                    Kept
                  </Badge>
                )}
                {l.status === "dismissed" && (
                  <Badge className="bg-slate-100 text-slate-500">Dismissed</Badge>
                )}
              </div>
              <h3 className="mt-2 text-sm font-semibold text-slate-900">{l.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">{l.body}</p>
              <p className="mt-2 text-xs text-slate-400">
                From{" "}
                {l.project_id ? (
                  <Link href={`/projects/${l.project_id}`} className="hover:text-primary-600">
                    {l.project_name}
                  </Link>
                ) : (
                  l.project_name || "a deleted project"
                )}
              </p>
            </div>

            {l.status === "new" && (
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => decide(l.id, "dismissed")}
                  loading={busy === l.id}
                >
                  <X className="h-4 w-4" /> Dismiss
                </Button>
                <Button size="sm" onClick={() => decide(l.id, "kept")} loading={busy === l.id}>
                  <Check className="h-4 w-4" /> Keep
                </Button>
              </div>
            )}
          </div>

          {Object.keys(l.evidence ?? {}).length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-slate-600">
                The numbers behind it
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">
                {JSON.stringify(l.evidence, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI-9 — Guards                                                       */
/* ------------------------------------------------------------------ */

function GuardsTab({ rows }: { rows: AnomalyRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);

  async function resolve(id: string, status: "dismissed" | "fixed") {
    setBusy(id);
    const res = await resolveAnomaly(id, status);
    setBusy(null);
    if (res.ok) {
      toast.success(status === "fixed" ? "Marked fixed." : "Dismissed — it won't come back.");
      router.refresh();
    } else toast.error(res.error);
  }

  async function rescan() {
    setScanning(true);
    const res = await rescanAnomalies();
    setScanning(false);
    if (res.ok) {
      toast.success(
        res.found ? `${res.found} new thing${res.found === 1 ? "" : "s"} to look at.` : "Nothing new found.",
      );
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-xs text-slate-400">
          Arithmetic, not AI — every flag names both records so you can check it
          yourself. Dismissing one keeps it dismissed for good.
        </p>
        <Button variant="outline" size="sm" onClick={rescan} loading={scanning}>
          <RefreshCw className="h-4 w-4" /> Run the guards now
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" />}
          title="Nothing suspicious"
          description="No duplicated expenses, double-counted payments or projects born twice from one deposit."
        />
      ) : (
        rows.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={ANOMALY_META[a.kind].tone}>
                  {ANOMALY_META[a.kind].label}
                </Badge>
                {a.project?.name && (
                  <span className="text-xs text-slate-400">{a.project.name}</span>
                )}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">{a.detail}</p>
              {a.project_id && (
                <Link
                  href={`/projects/${a.project_id}`}
                  className="mt-1 inline-block text-xs font-medium text-primary-600 hover:underline"
                >
                  Open the project →
                </Link>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolve(a.id, "dismissed")}
                loading={busy === a.id}
              >
                <Trash2 className="h-4 w-4" /> Not a problem
              </Button>
              <Button size="sm" onClick={() => resolve(a.id, "fixed")} loading={busy === a.id}>
                <Check className="h-4 w-4" /> Fixed it
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TabButton({
  active,
  onClick,
  icon,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  count?: number;
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
      {!!count && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            active ? "bg-white/20 text-white" : "bg-rose-50 text-rose-700",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
