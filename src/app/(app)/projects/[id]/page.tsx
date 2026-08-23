import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO, startOfToday } from "date-fns";
import { ArrowLeft, ArchiveRestore, CalendarRange } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ActivitySection } from "@/components/projects/activity-section";
import {
  AutomationSection,
  type ProjectRunRow,
} from "@/components/projects/automation-section";
import { AiToolsCard } from "@/components/projects/ai-tools-card";
import { FinanceCostsCard } from "@/components/projects/finance-costs-card";
import { ChainCard, type ChainLink } from "@/components/projects/chain-card";
import {
  ClientMessageCard,
  type SentClientMessage,
} from "@/components/projects/client-message-card";
import { DepositConfirmCard } from "@/components/projects/deposit-confirm-card";
import {
  ClientDeskCard,
  type DeskApproval,
  type DeskChangeRequest,
  type DeskComment,
  type DeskReview,
} from "@/components/projects/client-desk-card";
import {
  CommissionsSection,
  type CommissionRow,
} from "@/components/projects/commissions-section";
import {
  ExpensesSection,
  type ProjectExpenseRow,
} from "@/components/projects/expenses-section";
import { FilesSection, type ProjectFile } from "@/components/projects/files-section";
import { LedgerSection } from "@/components/projects/ledger-section";
import { MarginCard } from "@/components/projects/margin-card";
import {
  PlanSection,
  type ProjectMemberRow,
  type TimeEntryRow,
} from "@/components/projects/plan-section";
import { ProjectSettingsCard } from "@/components/projects/project-settings-card";
import {
  ScheduleCard,
  type ScheduleInstallment,
} from "@/components/projects/schedule-card";
import { StageControl } from "@/components/projects/stage-control";
import { TasksSection, type ProjectTask } from "@/components/projects/tasks-section";
import { PortalSection } from "./portal-section";
import { ProjectTabs } from "./project-tabs";
import {
  PROJECT_STATUS_META,
  STORAGE_BUCKETS,
  SERVICE_TYPE_LABELS,
} from "@/lib/constants";
import { isOpenAIConfigured } from "@/lib/ai/openai";
import { projectCosts } from "@/lib/project-costs";
import { requireProfile } from "@/lib/auth";
import { getMembers } from "@/lib/data";
import {
  buildLedger,
  commissionEarned,
  daysSince,
  marginIsMeaningful,
  projectHealth,
  projectMargin,
  settledAmount,
} from "@/lib/projects";
import { createClient } from "@/lib/supabase/server";
import { cn, formatCurrency } from "@/lib/utils";
import type { DeliveryEvent, ProjectMilestone, ProjectStatus } from "@/lib/types";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Run the auth check concurrently with the data queries (see dashboard).
  const [
    profile,
    projectRes,
    paymentsRes,
    commissionsRes,
    members,
    docRequestsRes,
    expensesRes,
    linkedPaymentsRes,
    milestonesRes,
    teamRes,
    tasksRes,
    timeRes,
    templatesRes,
    eventsRes,
    costRatesRes,
    siteRes,
    changeRequestsRes,
    approvalsRes,
    reviewsRes,
    commentsRes,
    pulsesRes,
    depositInvoiceRes,
    clientSmsRes,
    planRes,
    automationRunsRes,
  ] = await Promise.all([
    requireProfile(),
    (supabase as any)
      .from("projects")
      // email/phone ride along so "Generate invoice" can fill in Bill to.
      .select("*, client:clients(id, name, company, email, phone)")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("payments")
      .select("*")
      .eq("project_id", id)
      .order("paid_at", { ascending: false }),
    supabase
      .from("commissions")
      .select(
        "*, recipient:profiles!commissions_user_id_fkey(id, full_name, username, avatar_url)",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    getMembers(),
    (supabase as any)
      .from("project_document_requests")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    // 0087 — Additional expenses.
    supabase
      .from("project_expenses")
      .select("*")
      .eq("project_id", id)
      .order("incurred_on", { ascending: false })
      .order("created_at", { ascending: false }),
    // 0083 — payments booked on /payments against this project.
    supabase
      .from("company_payments")
      .select("id, price_lkr, is_paid, created_at, company_name")
      .eq("project_id", id),
    // 0092 — the planning layer.
    supabase
      .from("project_milestones")
      .select("*")
      .eq("project_id", id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("project_members")
      .select(
        "*, profile:profiles!project_members_user_id_fkey(id, full_name, username, avatar_url)",
      )
      .eq("project_id", id),
    supabase
      .from("todos")
      .select("id, title, status, priority, due_date, assigned_to, depends_on_id")
      .eq("project_id", id)
      .order("position", { ascending: true }),
    supabase
      .from("time_entries")
      .select(
        "*, profile:profiles!time_entries_user_id_fkey(id, full_name, avatar_url)",
      )
      .eq("project_id", id)
      .order("worked_on", { ascending: false }),
    supabase
      .from("project_templates")
      .select("id, name, service_type")
      .eq("is_active", true)
      .order("name"),
    // 0084 — this project's own slice of the delivery feed.
    supabase
      .from("delivery_events")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(80),
    // Hourly cost rates. Deliberately their own query rather than widening
    // getMembers(): 0092 says a cost rate is never shown to the member it
    // belongs to, and getMembers feeds every picker in the app.
    supabase.from("profiles").select("id, hourly_cost"),
    // 0092 — the /website-progress build linked to this project (PLAN-9).
    supabase
      .from("website_projects")
      .select("id, name, url, progress, status, notes, launched_at")
      .eq("project_id", id)
      .maybeSingle(),
    // 0094 — what the client has sent in, and what we've asked of them.
    supabase
      .from("project_change_requests")
      .select(
        "id, body, status, quoted_amount, quote_note, client_name, ai_flagged, ai_reason, created_at",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_approvals")
      .select(
        "id, title, detail, status, signer_name, signed_at, response_note, created_at",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_reviews")
      .select(
        "id, status, rating, headline, body, publishable, share_token, submitted_at, requested_at",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_comments")
      .select("id, author_type, author_name, body, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: true })
      .limit(60),
    supabase.from("project_pulses").select("score").eq("project_id", id),
    // 0093 — the deposit invoice raised on confirmation, and the texts this
    // project has already sent its client.
    supabase
      .from("invoices")
      .select("id, invoice_number, share_token, shared_at")
      .eq("project_id", id)
      .eq("stamp", "deposit_paid")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("sms_messages")
      .select("id, message, status, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
    // 0091 — the payment schedule billing this project, if there is one.
    supabase
      .from("payment_plans")
      .select("id, title, installments:payment_installments(id, seq, amount, due_date, status)")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // 0096 — what the automation engine has done to this project (AUTO-7).
    supabase
      .from("automation_runs")
      .select(
        "id, automation_id, status, step_index, next_run_at, created_at, completed_at, error, log, automation:automations(name)",
      )
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const project = projectRes.data;
  if (!project) notFound();

  const aiReady = isOpenAIConfigured();

  // ---------------------------------------------------------------------
  // BIG-2 (0099) — walk the chain this project sits in.
  //
  // Four of the five joins already existed; 0099 added projects → lead/quote/
  // proposal and proposals → the rest. Each hop is its own small query rather
  // than one deep join, because most projects link to none of them and a
  // five-table join that usually returns nulls is a slow way to learn that.
  // ---------------------------------------------------------------------
  const [chainLeadRes, chainQuoteRes, chainProposalRes, chainInvoicesRes] =
    await Promise.all([
      project.lead_id
        ? supabase
            .from("leads")
            .select("id, title, company, value, created_at")
            .eq("id", project.lead_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      project.quote_id
        ? supabase
            .from("quotes")
            .select("id, quote_number, title, grand_total, status, share_token, accepted_at")
            .eq("id", project.quote_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      project.proposal_id
        ? supabase
            .from("proposals")
            .select("id, project_name, grand_total, proposal_date")
            .eq("id", project.proposal_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("invoices")
        .select("id, invoice_number, grand_total, invoice_date, share_token")
        .eq("project_id", id)
        .order("invoice_date", { ascending: true }),
    ]);

  const chainLead = chainLeadRes.data;
  const chainQuote = chainQuoteRes.data;
  const chainProposal = chainProposalRes.data;
  const chainInvoices = chainInvoicesRes.data ?? [];

  const chainCandidates: (ChainLink | null | false)[] = [
    chainLead && {
      kind: "lead" as const,
      label: chainLead.title,
      sublabel:
        [chainLead.company, chainDate(chainLead.created_at)]
          .filter(Boolean)
          .join(" · ") || null,
      href: `/crm/lead/${chainLead.id}`,
      amount: chainLead.value === null ? null : Number(chainLead.value),
    },
    chainQuote && {
      kind: "quote" as const,
      label: chainQuote.title || chainQuote.quote_number,
      sublabel:
        chainQuote.status === "accepted" && chainQuote.accepted_at
          ? `Accepted ${chainDate(chainQuote.accepted_at)}`
          : chainQuote.status,
      href: chainQuote.share_token ? `/q/${chainQuote.share_token}` : "/quotes",
      amount: Number(chainQuote.grand_total) || 0,
    },
    chainProposal && {
      kind: "proposal" as const,
      label: chainProposal.project_name || "Proposal",
      sublabel: chainDate(chainProposal.proposal_date),
      href: "/proposals",
      amount: Number(chainProposal.grand_total) || 0,
    },
    {
      kind: "project" as const,
      label: project.name,
      sublabel: "This project",
      href: null,
      amount: Number(project.total_value) || 0,
    },
    chainInvoices.length > 0 && {
      kind: "invoice" as const,
      label:
        chainInvoices.length === 1
          ? `Invoice ${chainInvoices[0].invoice_number}`
          : "Invoices",
      sublabel:
        chainInvoices.length === 1
          ? chainDate(chainInvoices[0].invoice_date)
          : `${chainInvoices[0].invoice_number} … ${chainInvoices[chainInvoices.length - 1].invoice_number}`,
      href:
        chainInvoices.length === 1 && chainInvoices[0].share_token
          ? `/public/invoice/${chainInvoices[0].share_token}`
          : "/invoices",
      amount: chainInvoices.reduce((sum, i) => sum + (Number(i.grand_total) || 0), 0),
      count: chainInvoices.length,
    },
  ];
  const chainLinks: ChainLink[] = chainCandidates.filter(
    (l): l is ChainLink => Boolean(l),
  );

  // Handle dynamic sharing token generation for legacy data
  let shareToken = project.share_token;
  if (!shareToken) {
    shareToken = crypto.randomUUID();
    await (supabase as any)
      .from("projects")
      .update({ share_token: shareToken })
      .eq("id", id);
  }

  // ---------------------------------------------------------------------
  // AUTO-7 — this project's automation runs, with "step 3 of 6" made real.
  //
  // The run row knows how far it got; only automation_steps knows how far
  // there is to go, so the totals are counted once for the handful of
  // automations that actually touched this project.
  // ---------------------------------------------------------------------
  type RawRun = {
    id: string;
    automation_id: string;
    status: string;
    step_index: number;
    next_run_at: string;
    created_at: string;
    completed_at: string | null;
    error: string | null;
    log: unknown;
    automation: { name: string } | { name: string }[] | null;
  };
  const rawRuns = (automationRunsRes.data ?? []) as unknown as RawRun[];

  const stepCounts = new Map<string, number>();
  if (rawRuns.length) {
    const { data: allSteps } = await supabase
      .from("automation_steps")
      .select("automation_id")
      .in("automation_id", Array.from(new Set(rawRuns.map((r) => r.automation_id))));
    for (const step of allSteps ?? []) {
      stepCounts.set(
        step.automation_id,
        (stepCounts.get(step.automation_id) ?? 0) + 1,
      );
    }
  }

  const automationRuns: ProjectRunRow[] = rawRuns.map((r) => {
    const automation = Array.isArray(r.automation) ? r.automation[0] : r.automation;
    const log = Array.isArray(r.log)
      ? (r.log as { step?: string; at?: string; ok?: boolean; detail?: string }[])
      : [];
    return {
      id: r.id,
      automation_name: automation?.name ?? "Automation",
      status: r.status as ProjectRunRow["status"],
      step_index: r.step_index,
      // Falls back to what the log proves ran, so a run whose automation has
      // since been deleted still reads sensibly rather than "step 3 of 0".
      step_count:
        stepCounts.get(r.automation_id) ?? Math.max(log.length, r.step_index),
      next_run_at: r.next_run_at,
      created_at: r.created_at,
      completed_at: r.completed_at,
      error: r.error,
      log,
    };
  });

  const payments = await Promise.all(
    (paymentsRes.data ?? []).map(async (p) => {
      if (!p.receipt_path) return p;
      const { data } = await supabase.storage
        .from(STORAGE_BUCKETS.receipts)
        .createSignedUrl(p.receipt_path, 3600);
      return { ...p, receiptUrl: data?.signedUrl ?? null };
    }),
  );

  // Supplier receipts on expenses live in the same private bucket as payment
  // receipts, so they need the same short-lived signed link.
  const expenses: ProjectExpenseRow[] = await Promise.all(
    ((expensesRes.data ?? []) as ProjectExpenseRow[]).map(async (e) => {
      if (!e.receipt_path) return e;
      const { data } = await supabase.storage
        .from(STORAGE_BUCKETS.receipts)
        .createSignedUrl(e.receipt_path, 3600);
      return { ...e, receiptUrl: data?.signedUrl ?? null };
    }),
  );

  /** Billable extras still waiting to go on an invoice — the tab's badge. */
  const unbilledExpenses = expenses.filter((e) => e.billable && !e.invoiced_at);

  const client = project.client as unknown as {
    id: string;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
  } | null;

  // ---- Money, counted once (LOOP-1/6) ------------------------------------
  const money = {
    total_value: project.total_value,
    deposit_paid: project.deposit_paid,
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      paid_at: p.paid_at,
      method: p.method,
      notes: p.notes,
      receiptUrl: (p as { receiptUrl?: string | null }).receiptUrl ?? null,
    })),
    company_payments: linkedPaymentsRes.data ?? [],
  };
  const received = settledAmount(money);
  const totalValue = Number(project.total_value) || 0;
  const balance = Math.max(0, totalValue - received);
  const ledger = buildLedger(money);

  // ---- Time and margin (PLAN-5, MON-1) -----------------------------------
  const timeEntries = (timeRes.data ?? []) as unknown as (TimeEntryRow & {
    profile: { id: string; full_name: string; avatar_url: string | null } | null;
  })[];
  const costByUser = new Map(
    (costRatesRes.data ?? []).map((p) => [p.id, Number(p.hourly_cost ?? 0)]),
  );
  const labourMinutes = timeEntries.reduce((s, e) => s + e.minutes, 0);
  const labourCost = timeEntries.reduce(
    (s, e) => s + (e.minutes / 60) * (costByUser.get(e.user_id) ?? 0),
    0,
  );
  const hasCostRates = timeEntries.some(
    (e) => (costByUser.get(e.user_id) ?? 0) > 0,
  );

  // 0100 — costs booked against this project in Money & Finance. Absorbed, so
  // they eat the margin without appearing on the client's invoice; the
  // Additional expenses tab is where a re-billable cost belongs.
  const financeCosts = await projectCosts(supabase, id).then((rows) =>
    rows.filter((r) => r.source === "finance"),
  );

  const commissions = (commissionsRes.data ?? []) as unknown as CommissionRow[];
  const margin = projectMargin({
    totalValue,
    expenses: [...expenses, ...financeCosts],
    // A percentage commission is only worth what the client has actually paid.
    commissions: commissions.map((c) => ({
      amount: commissionEarned(c, received),
    })),
    labourCost,
  });

  // ---- Health (PLAN-8) ---------------------------------------------------
  const milestones = (milestonesRes.data ?? []) as ProjectMilestone[];
  const tasks = (tasksRes.data ?? []) as ProjectTask[];
  const docRequests = docRequestsRes.data ?? [];
  // startOfToday() rather than Date.now(): react-hooks/purity forbids calling
  // the impure global during render, and work due later today isn't late yet.
  const now = startOfToday().getTime();
  const health = projectHealth({
    status: project.status,
    deliveryStage: project.delivery_stage,
    stageChangedAt: project.delivery_stage_changed_at,
    updatedAt: project.updated_at,
    dueDate: project.due_date,
    blockedSince: project.blocked_since,
    assetsOutstanding: docRequests.filter(
      (r: { status: string; required: boolean }) =>
        r.status === "pending" && r.required,
    ).length,
    overdueTasks: tasks.filter(
      (t) =>
        t.status !== "done" && t.due_date && new Date(t.due_date).getTime() < now,
    ).length,
    overdueMilestones: milestones.filter(
      (m) =>
        m.status !== "done" &&
        m.due_date &&
        new Date(`${m.due_date}T23:59:59`).getTime() < now,
    ).length,
    balance,
    daysSinceDelivered:
      project.delivery_stage === "delivered" || project.delivery_stage === "aftercare"
        ? daysSince(project.delivery_stage_changed_at)
        : null,
    budget: Number(project.expense_cap ?? project.budget ?? 0) || null,
    spend: margin.expenses,
  });

  // ---- Files, from four different places (LOOP-9) ------------------------
  const files: ProjectFile[] = [
    ...(project.proposal_url
      ? [
          {
            id: "proposal",
            name: project.proposal_name || "Proposal",
            url: project.proposal_url,
            source: "proposal" as const,
            date: project.created_at,
          },
        ]
      : []),
    ...(project.invoice_url
      ? [
          {
            id: "invoice",
            name: project.invoice_name || "Invoice",
            url: project.invoice_url,
            source: "invoice" as const,
            date: project.created_at,
          },
        ]
      : []),
    ...docRequests
      .filter((r: { file_url: string | null }) => r.file_url)
      .map(
        (r: {
          id: string;
          file_name: string | null;
          file_url: string;
          source: string;
          submitted_at: string | null;
          title: string;
        }) => ({
          id: r.id,
          name: r.file_name || r.title,
          url: r.file_url,
          source: (r.source === "whatsapp" ? "whatsapp" : "portal") as
            | "whatsapp"
            | "portal",
          date: r.submitted_at,
          meta: r.title,
        }),
      ),
    ...expenses
      .filter((e) => e.receiptUrl)
      .map((e) => ({
        id: e.id,
        name: e.vendor ? `${e.vendor} — ${e.description}` : e.description,
        url: e.receiptUrl as string,
        source: "receipt" as const,
        date: e.incurred_on,
        meta: formatCurrency(Number(e.amount), e.currency),
      })),
  ];

  const openTasks = tasks.filter((t) => t.status !== "done").length;
  // The client's invoice link is absolute — it goes out in a text, and the
  // team copies it out of this page. Empty when NEXT_PUBLIC_APP_URL is unset,
  // which the card then reports rather than showing a half-formed URL.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

  // Change requests nobody has answered yet — the one thing on the Client tab
  // that is genuinely waiting on us rather than on them.
  const waitingOnUs = (changeRequestsRes.data ?? []).filter((c) =>
    ["new", "quoted"].includes(c.status),
  ).length;

  // 0094 — how the client says it's going. Averaged rather than "latest", so
  // one bad day doesn't define the project and one good one doesn't hide it.
  const pulses = pulsesRes.data ?? [];
  const pulseAverage = pulses.length
    ? pulses.reduce((s, p) => s + Number(p.score), 0) / pulses.length
    : null;
  // Margin exposes what people cost us, so it sits behind the same door as
  // commissions (0006): admins only.
  const isAdmin = profile.role === "admin";

  return (
    <div className="space-y-6">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Projects
      </Link>

      {project.deleted_at && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-300 bg-slate-100 px-5 py-3 text-sm text-slate-700">
          <ArchiveRestore className="h-4 w-4" />
          <span>
            <span className="font-semibold">Archived</span> on{" "}
            {format(new Date(project.deleted_at), "d MMM yyyy")}. It stays out of
            every board until it&apos;s restored from the archive.
          </span>
        </div>
      )}

      {/* Header */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold text-slate-900">
                  {project.name}
                </h1>
                <Badge
                  className={
                    PROJECT_STATUS_META[project.status as ProjectStatus].badge
                  }
                >
                  {PROJECT_STATUS_META[project.status as ProjectStatus].label}
                </Badge>
                {project.service_type && (
                  <Badge className="bg-primary-50 font-medium text-primary-700 ring-primary-200">
                    {SERVICE_TYPE_LABELS[project.service_type] ||
                      project.service_type}
                  </Badge>
                )}
                <HealthPill health={health} />
              </div>
              {client && (
                <p className="mt-1 text-sm text-slate-500">
                  {client.name}
                  {client.company ? ` · ${client.company}` : ""}
                </p>
              )}
              {(project.start_date || project.due_date) && (
                <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-400">
                  <CalendarRange className="h-3.5 w-3.5" />
                  {project.start_date
                    ? format(new Date(project.start_date), "MMM d, yyyy")
                    : "—"}
                  {" → "}
                  {project.due_date
                    ? format(new Date(project.due_date), "MMM d, yyyy")
                    : "—"}
                </p>
              )}
              {project.description && (
                <p className="mt-3 max-w-2xl text-sm text-slate-600">
                  {project.description}
                </p>
              )}
            </div>
          </div>

          {/* Delivery stage, on the project at last (LOOP-3) */}
          <div className="border-t border-slate-100 pt-4">
            <StageControl
              projectId={id}
              stage={project.delivery_stage}
              blockedReason={project.blocked_reason}
              blockedSince={project.blocked_since}
              canTextClient={Boolean(client?.phone)}
            />
          </div>

          {/* Money, counted the same way everywhere (LOOP-1) */}
          <div className="mt-2 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-right md:grid-cols-4">
            <Stat
              label="Total Value"
              value={formatCurrency(totalValue, project.currency)}
            />
            <Stat
              label="Received"
              value={formatCurrency(received, project.currency)}
              accent="emerald"
              hint={`${ledger.filter((r) => r.paid).length} payment${ledger.filter((r) => r.paid).length === 1 ? "" : "s"}`}
            />
            <Stat
              label="Balance Due"
              value={formatCurrency(balance, project.currency)}
              accent="amber"
            />
            {isAdmin ? (
              <Stat
                label="Profit"
                value={formatCurrency(margin.profit, project.currency)}
                accent={margin.profit >= 0 ? "emerald" : "rose"}
                hint={
                  marginIsMeaningful(margin)
                    ? `${margin.percent}% margin`
                    : "no costs recorded"
                }
              />
            ) : (
              <Stat
                label="Internal budget"
                value={formatCurrency(Number(project.budget) || 0, project.currency)}
              />
            )}
          </div>
        </div>
      </div>

      <ProjectTabs
        expenseBadge={
          unbilledExpenses.length > 0 ? String(unbilledExpenses.length) : undefined
        }
        planBadge={openTasks > 0 ? String(openTasks) : undefined}
        clientBadge={waitingOnUs > 0 ? String(waitingOnUs) : undefined}
        overview={
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="space-y-6 xl:col-span-2">
              {/* BIG-2 — where this job came from, before what it is worth. */}
              <ChainCard
                links={chainLinks}
                currency={project.currency || "LKR"}
                quoted={chainQuote ? Number(chainQuote.grand_total) || 0 : null}
                delivered={Number(project.total_value) || 0}
              />
              <LedgerSection
                projectId={id}
                rows={ledger}
                currency={project.currency}
                received={received}
                totalValue={totalValue}
              />
              <TasksSection projectId={id} tasks={tasks} members={members} />
              {/* Theme 5 — the tools that act on THIS project. Full width:
                  the screenshot draft is edited before it is filed. */}
              <AiToolsCard
                projectId={id}
                aiReady={aiReady}
                canPostMortem={
                  project.status === "completed" ||
                  project.delivery_stage === "delivered" ||
                  project.delivery_stage === "aftercare"
                }
                hasClient={!!project.client_id}
              />
            </div>
            {/* Only short, glanceable cards sit in the narrow column — the
             * client-facing surfaces need real width and live on their own
             * tab now. */}
            <div className="space-y-6">
              <DepositConfirmCard
                projectId={id}
                currency={project.currency}
                received={received}
                totalValue={totalValue}
                clientName={client?.name ?? null}
                clientPhone={client?.phone ?? null}
                confirmedAt={project.deposit_confirmed_at}
                invoiceNumber={depositInvoiceRes.data?.invoice_number ?? null}
                invoiceLink={
                  depositInvoiceRes.data?.share_token
                    ? `${appUrl}/public/invoice/${depositInvoiceRes.data.share_token}`
                    : null
                }
                lastSentAt={depositInvoiceRes.data?.shared_at ?? null}
              />
              {siteRes.data && <WebsiteBuildCard site={siteRes.data} />}
            </div>
          </div>
        }
        client={
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="space-y-6 xl:col-span-2">
              <PortalSection
                projectId={id}
                projectName={project.name}
                shareToken={shareToken}
                baseUrl={appUrl}
                requests={docRequests}
                isProjectCompleted={project.status === "completed"}
                serviceType={project.service_type ?? null}
                hasClient={!!project.client_id}
                onboardingStartedAt={project.onboarding_started_at ?? null}
                clientName={client?.name ?? null}
                clientPhone={client?.phone ?? null}
                access={{
                  passcode: project.portal_passcode,
                  expiresAt: project.portal_expires_at,
                  revokedAt: project.portal_revoked_at,
                  lastSentAt: project.portal_last_sent_at,
                  language: project.portal_language ?? "en",
                }}
              />
            </div>
            <div className="space-y-6">
              <ClientDeskCard
                projectId={id}
                currency={project.currency}
                canText={Boolean(client?.phone)}
                changeRequests={
                  (changeRequestsRes.data ?? []) as DeskChangeRequest[]
                }
                approvals={(approvalsRes.data ?? []) as DeskApproval[]}
                reviews={(reviewsRes.data ?? []) as DeskReview[]}
                comments={(commentsRes.data ?? []) as DeskComment[]}
                pulseAverage={pulseAverage}
                pulseCount={pulses.length}
                isDelivered={
                  project.delivery_stage === "delivered" ||
                  project.delivery_stage === "aftercare" ||
                  project.status === "completed"
                }
              />
              <ClientMessageCard
                projectId={id}
                projectName={project.name}
                clientName={client?.name ?? null}
                clientPhone={client?.phone ?? null}
                sent={(clientSmsRes.data ?? []) as SentClientMessage[]}
              />
            </div>
          </div>
        }
        plan={
          <PlanSection
            projectId={id}
            members={members}
            team={(teamRes.data ?? []) as unknown as ProjectMemberRow[]}
            milestones={milestones}
            timeEntries={timeEntries}
            templates={templatesRes.data ?? []}
            currency={project.currency}
            labourCost={labourCost}
          />
        }
        money={
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <ExpensesSection
                projectId={id}
                projectName={project.name}
                projectDetail={
                  (project.service_type
                    ? SERVICE_TYPE_LABELS[project.service_type] ||
                      project.service_type
                    : project.description) ?? ""
                }
                currency={project.currency}
                totalValue={totalValue}
                paid={{
                  total: received,
                  breakdown: `${ledger.filter((r) => r.paid).length} settled payment${ledger.filter((r) => r.paid).length === 1 ? "" : "s"}`,
                  otherPayments: null,
                }}
                clientName={client?.name ?? ""}
                clientDetails={[client?.company, client?.email, client?.phone]
                  .filter(Boolean)
                  .join("\n")}
                expenses={expenses}
              />
              {/* 0100 — what Finance booked against this project. Read-only:
                  Finance owns those rows. */}
              <FinanceCostsCard
                rows={financeCosts.map((c) => ({
                  description: c.description,
                  amount: c.amount,
                  category: c.category,
                  incurred_on: c.incurred_on,
                }))}
                currency={project.currency}
              />
              <CommissionsSection
                projectId={id}
                currency={project.currency}
                totalValue={totalValue}
                receivedAmount={received}
                isAdmin={profile.role === "admin"}
                members={members}
                commissions={commissions}
              />
            </div>
            <div className="space-y-6">
              {isAdmin && (
                <MarginCard
                  margin={margin}
                  currency={project.currency}
                  cap={Number(project.expense_cap ?? project.budget ?? 0) || null}
                  labourHours={labourMinutes / 60}
                  hasCostRates={hasCostRates}
                  financeCosts={financeCosts}
                />
              )}
              <ScheduleCard
                projectId={id}
                projectName={project.name}
                currency={project.currency}
                totalValue={totalValue}
                clientId={project.client_id}
                clientName={client?.name ?? ""}
                clientPhone={client?.phone ?? null}
                planTitle={planRes.data?.title ?? null}
                installments={
                  ((planRes.data?.installments ?? []) as ScheduleInstallment[])
                    .slice()
                    .sort((a, b) => a.seq - b.seq)
                }
              />
              <ProjectSettingsCard
                projectId={id}
                currency={project.currency}
                settings={{
                  expense_cap: project.expense_cap,
                  deposit_required_percent: project.deposit_required_percent,
                  is_retainer: project.is_retainer ?? false,
                  retainer_day: project.retainer_day,
                  auto_invoice_on_delivery: project.auto_invoice_on_delivery ?? false,
                  aftercare_enabled: project.aftercare_enabled ?? false,
                  balance_chase_paused: project.balance_chase_paused ?? false,
                  balance_chase_count: project.balance_chase_count ?? 0,
                }}
              />
            </div>
          </div>
        }
        files={<FilesSection files={files} />}
        activity={
          <div className="space-y-6">
            {/* Both of these answer "what happened to this project" — the
                machine's account above the people's. Provenance and the AI
                tools used to live here too; they are context and actions, not
                history, and moved to Overview. */}
            <AutomationSection
              projectId={id}
              paused={project.automation_paused ?? false}
              runs={automationRuns}
            />
            <ActivitySection events={(eventsRes.data ?? []) as DeliveryEvent[]} />
          </div>
        }
      />
    </div>
  );
}

/**
 * The linked /website-progress build (PLAN-9).
 *
 * website_projects (0026) predates projects having a delivery pipeline, so the
 * same job was tracked in two places that never spoke. Linked rows now surface
 * here, so the project page is the whole picture.
 */
function WebsiteBuildCard({
  site,
}: {
  site: {
    id: string;
    name: string;
    url: string;
    progress: number;
    status: string;
    notes: string;
    launched_at: string | null;
  };
}) {
  const label =
    site.status === "launched"
      ? "Live"
      : site.status === "waiting_client"
        ? "Waiting on the client"
        : "In progress";

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Website build</h2>
          <a
            href={site.url}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block truncate text-xs text-primary-600 hover:underline"
          >
            {site.url}
          </a>
        </div>
        <Badge
          className={
            site.status === "launched"
              ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
              : site.status === "waiting_client"
                ? "bg-amber-50 text-amber-600 ring-amber-200"
                : "bg-primary-50 text-primary-600 ring-primary-200"
          }
        >
          {label}
        </Badge>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            site.progress >= 100 ? "bg-emerald-500" : "bg-primary-500",
          )}
          style={{ width: `${site.progress}%` }}
        />
      </div>
      <p className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
        <span>{site.progress}% built</span>
        <Link href="/website-progress" className="hover:text-primary-600">
          Update
        </Link>
      </p>

      {site.notes && (
        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
          {site.notes}
        </p>
      )}
    </section>
  );
}

/** The one-glance answer to "is this job in trouble" (PLAN-8). */
function HealthPill({
  health,
}: {
  health: { score: number; tone: string; reasons: string[] };
}) {
  if (health.reasons.length === 0) return null;
  return (
    <span
      title={health.reasons.join(" · ")}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        health.tone === "risk"
          ? "bg-rose-50 text-rose-700 ring-rose-200"
          : "bg-amber-50 text-amber-700 ring-amber-200",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          health.tone === "risk" ? "bg-rose-500" : "bg-amber-500",
        )}
      />
      {health.reasons[0]}
      {health.reasons.length > 1 && ` +${health.reasons.length - 1}`}
    </span>
  );
}

function Stat({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string;
  accent?: "emerald" | "amber" | "rose";
  hint?: string;
}) {
  const color =
    accent === "emerald"
      ? "text-emerald-600"
      : accent === "amber"
        ? "text-amber-600"
        : accent === "rose"
          ? "text-rose-600"
          : "text-slate-900";
  return (
    <div>
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * Date formatting for the chain card.
 *
 * Deliberately defined HERE and not exported from chain-card.tsx: that file is
 * "use client", and every export of a client module becomes a client reference
 * when a Server Component imports it — calling one on the server throws at
 * runtime, which a type check will not catch.
 */
function chainDate(value: string | null): string | null {
  if (!value) return null;
  try {
    return format(parseISO(value), "d MMM yyyy");
  } catch {
    return null;
  }
}
