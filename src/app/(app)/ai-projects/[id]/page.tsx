import Link from "next/link";
import { notFound } from "next/navigation";
import { Bot, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { AI_STATUS_META, hostOf } from "@/lib/ai-projects/format";
import { selectableModels } from "@/lib/ai-projects/pricing-core";
import { PROJECT_WITH_CLIENT, type AiProjectWithClient } from "@/lib/ai-projects/projects";
import { loadPriceCatalog } from "@/lib/ai-projects/usage";
import { addMonths, colomboDay, colomboDayStartIso, colomboPeriod, daysAgo, daysBetween, monthStart, nextPeriod, periodLabel } from "@/lib/ai-projects/time-core";
import { aggregateByModel, composeAiInvoice } from "@/lib/ai-projects/billing-core";
import { requireAdmin } from "@/lib/auth";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

import { isFirecrawlConfigured } from "@/lib/ai/firecrawl";
import { crmOrigin } from "@/lib/ai-projects/cors";
import { buildKit } from "@/lib/ai-projects/kit";
import { toolDefOf } from "@/lib/ai-projects/custom-tools";
import { DEFAULT_FIELD_MAP, rlsPolicySql } from "@/lib/ai-projects/supabase-destination";
import { decryptToken, isSocialCryptoConfigured } from "@/lib/social/crypto";
import type { CrawlPhase } from "@/lib/ai-projects/crawl-core";

import { AgentPanel, type AgentPanelData } from "./agent-panel";
import { AnalyticsPanel, type AnalyticsData, type DailyPoint, type Totals } from "./analytics-panel";
import { BackendPanel, type BackendPanelData, type DeliveryRow, type ToolRow } from "./backend-panel";
import { DeployPanel, type DeployPanelData } from "./deploy-panel";
import { ConversationsPanel, type ConversationRow } from "./conversations-panel";
import { InvoicesPanel, type InvoiceHistoryRow, type InvoicesPanelData } from "./invoices-panel";
import { KnowledgePanel, type CrawlJobRow, type KnowledgePanelData } from "./knowledge-panel";
import { LeadsPanel, type LeadRow } from "./leads-panel";
import { OverviewPanel, type OverviewData } from "./overview-panel";
import { AiProjectTabs } from "./project-tabs";

export const metadata = { title: "AI Projects" };
/** The Knowledge tab's "Add" actions embed inline; give them room. */
export const maxDuration = 60;

type InvoiceLink = {
  id: string;
  period: string;
  status: "pending" | "created" | "skipped_zero" | "failed";
  total: number | null;
  currency: string | null;
  usage_cost_usd: number;
  markup: number | null;
  error: string | null;
  emailed: boolean;
  created_at: string;
  invoice: { id: string; invoice_number: string; invoice_date: string; status: string | null; share_token: string | null } | null;
};

export default async function AiProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; days?: string }>;
}) {
  const { id } = await params;
  const { tab: initialTab, days: daysParam } = await searchParams;
  const days = [7, 30, 90].includes(Number(daysParam)) ? Number(daysParam) : 30;
  await requireAdmin();
  const supabase = await createClient();

  const today = colomboDay();
  const period = colomboPeriod();

  const [projectRes, clientsRes, sourcesRes, dailyRes, todayRes, invoicesRes, catalog, jobRes, conversationsRes, leadsRes, toolsRes, deliveriesRes, modelDailyRes, monthUsageRes, monthConvRes] = await Promise.all([
    supabase.from("ai_projects").select(PROJECT_WITH_CLIENT).eq("id", id).maybeSingle(),
    supabase.from("clients").select("id, name, company").order("name").limit(500),
    supabase
      .from("ai_kb_sources")
      .select("id, source_kind, title, url, status, error, chunk_count, size_bytes, updated_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false }),
    supabase.from("ai_project_daily").select("*").eq("project_id", id).gte("day", daysAgo(today, 366)).order("day"),
    supabase
      .from("ai_messages")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id)
      .eq("role", "user")
      .gte("created_at", colomboDayStartIso(today)),
    supabase
      .from("ai_invoices")
      .select("*, invoice:invoices(id, invoice_number, invoice_date, status, share_token)")
      .eq("project_id", id)
      .order("period", { ascending: false })
      .limit(36),
    loadPriceCatalog(supabase),
    supabase.from("ai_crawl_jobs").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase
      .from("ai_conversations")
      .select("id, started_at, last_message_at, message_count, user_messages, page_url, country, lead_id, handoff_requested_at, booking_offered_at, is_preview, total_cost_usd, total_tokens")
      .eq("project_id", id)
      .order("last_message_at", { ascending: false })
      .limit(100),
    supabase.from("ai_leads").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(200),
    supabase.from("ai_tools").select("*").eq("project_id", id).order("created_at", { ascending: true }),
    supabase
      .from("ai_deliveries")
      .select("*, lead:ai_leads(name)")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("ai_model_daily").select("*").eq("project_id", id).gte("day", daysAgo(today, days - 1)),
    supabase
      .from("ai_usage_events")
      .select("model, kind, input_tokens, cached_input_tokens, output_tokens, cost_usd")
      .eq("project_id", id)
      .eq("period", period)
      .eq("billable", true),
    supabase
      .from("ai_conversations")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id)
      .eq("is_preview", false)
      .gte("started_at", colomboDayStartIso(period)),
  ]);

  const project = (projectRes.data as unknown as AiProjectWithClient | null) ?? null;
  if (!project) notFound();

  const sources = sourcesRes.data ?? [];
  const knowledge = {
    ready: sources.filter((s) => s.status === "ready").length,
    pending: sources.filter((s) => s.status === "pending" || s.status === "processing").length,
    failed: sources.filter((s) => s.status === "failed").length,
    chunks: sources.reduce((n, s) => n + (s.chunk_count ?? 0), 0),
    lastCrawlAt: project.last_crawl_at,
    nextCrawlAt: project.next_crawl_at,
    crawlIntervalDays: project.crawl_interval_days,
  };

  const allDaily = dailyRes.data ?? [];
  const month = allDaily
    .filter((d) => d.day >= period)
    .reduce(
      (acc, d) => ({
        costUsd: acc.costUsd + (Number(d.cost_usd) || 0),
        conversations: acc.conversations + d.conversations,
        messages: acc.messages + d.user_messages,
      }),
      { costUsd: 0, conversations: 0, messages: 0 },
    );

  const links = (invoicesRes.data ?? []) as unknown as InvoiceLink[];
  const invoices = links.filter((l) => l.invoice);
  const last = invoices[0];

  const tools: string[] = [];
  if (project.lead_capture_enabled) tools.push("Lead capture");
  if (project.booking_enabled && project.booking_url) tools.push("Booking");
  if (project.handoff_enabled) tools.push("Human hand-off");

  const overview: OverviewData = {
    id: project.id,
    name: project.name,
    status: project.status,
    clientId: project.client_id,
    websiteUrl: project.website_url,
    publicKey: project.public_key,
    allowedOrigins: project.allowed_origins ?? [],
    agentName: project.agent_name,
    model: project.model,
    tools,
    knowledge,
    month: { label: periodLabel(period), ...month },
    today: { messages: todayRes.count ?? 0, cap: project.daily_message_cap },
    billing: {
      enabled: project.billing_enabled,
      currency: project.billing_currency,
      fee: Number(project.monthly_fee) || 0,
      markup: Number(project.usage_markup) || 1,
      minimum: Number(project.monthly_minimum) || 0,
      fx: project.fx_lkr_per_usd == null ? null : Number(project.fx_lkr_per_usd),
      mode: project.invoice_mode,
      nextInvoiceOn: new Date(`${nextPeriod(period)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
      lastInvoice: last?.invoice
        ? { number: last.invoice.invoice_number, total: Number(last.total) || 0, currency: last.currency, status: last.invoice.status ?? "issued" }
        : null,
    },
    clients: (clientsRes.data ?? []).map((c) => ({ id: c.id, label: c.company ? `${c.name} — ${c.company}` : c.name })),
  };

  const labels = new Map(catalog.map((r) => [r.model, r] as const));
  const agent: AgentPanelData = {
    id: project.id,
    avatarUrl: project.avatar_url,
    settings: {
      agentName: project.agent_name,
      systemPrompt: project.system_prompt,
      model: project.model,
      temperature: Number(project.temperature) || 0,
      reasoningEffort: project.reasoning_effort,
      welcomeMessage: project.welcome_message ?? "",
      suggestedQuestions: project.suggested_questions ?? [],
      primaryColor: project.primary_color,
      userBubbleColor: project.user_bubble_color ?? "",
      agentBubbleColor: project.agent_bubble_color ?? "",
      widgetPosition: project.widget_position,
      showBranding: project.show_branding,
      bookingUrl: project.booking_url ?? "",
      notificationEmail: project.notification_email ?? "",
      leadCaptureEnabled: project.lead_capture_enabled,
      bookingEnabled: project.booking_enabled,
      handoffEnabled: project.handoff_enabled,
    },
    limits: { rateLimitPerMinute: project.rate_limit_per_minute, dailyMessageCap: project.daily_message_cap },
    backendSummary: (() => {
      const bits: string[] = [];
      const live = (toolsRes.data ?? []).filter((t) => t.enabled).length;
      if (live) bits.push(`${live} custom tool${live === 1 ? "" : "s"}`);
      if (project.calendar_provider !== "none") bits.push("a calendar");
      if (!bits.length) return null;
      return `This agent also has ${bits.join(" and ")}.`;
    })(),
    models: selectableModels(catalog, today).map((m) => ({
      model: m.model,
      label: (labels.get(m.model) as { label?: string | null } | undefined)?.label ?? null,
      inputPerM: m.quote.inputPerM,
      outputPerM: m.quote.outputPerM,
    })),
  };

  const job = jobRes.data;
  const knowledgeData: KnowledgePanelData = {
    projectId: project.id,
    websiteUrl: project.website_url,
    firecrawlConfigured: isFirecrawlConfigured(),
    crawlIntervalDays: project.crawl_interval_days,
    nextCrawlAt: project.next_crawl_at,
    lastCrawlAt: project.last_crawl_at,
    job: job
      ? ({
          id: job.id,
          status: job.status as CrawlPhase,
          triggeredBy: job.triggered_by,
          pages_seen: job.pages_seen,
          pages_changed: job.pages_changed,
          pages_unchanged: job.pages_unchanged,
          pages_stale: job.pages_stale,
          chunks_written: job.chunks_written,
          startedAt: job.started_at,
          finishedAt: job.finished_at,
          error: job.error,
          errors: Array.isArray(job.errors) ? job.errors.map(String) : [],
        } satisfies CrawlJobRow)
      : null,
    sources: sources.map((s) => ({
      id: s.id,
      kind: s.source_kind,
      title: s.title,
      url: s.url,
      status: s.status,
      error: s.error,
      chunks: s.chunk_count,
      sizeBytes: s.size_bytes,
      updatedAt: s.updated_at,
    })),
  };
  const deployData: DeployPanelData = {
    id: project.id,
    status: project.status,
    publicKey: project.public_key,
    allowedOrigins: project.allowed_origins ?? [],
    crmOrigin: crmOrigin(),
    websiteUrl: project.website_url,
  };

  const conversationRows: ConversationRow[] = (conversationsRes.data ?? []).map((c) => ({
    id: c.id,
    startedAt: c.started_at,
    lastMessageAt: c.last_message_at,
    messageCount: c.message_count,
    userMessages: c.user_messages,
    pageUrl: c.page_url,
    country: c.country,
    hasLead: Boolean(c.lead_id),
    handoff: Boolean(c.handoff_requested_at),
    booking: Boolean(c.booking_offered_at),
    preview: c.is_preview,
    costUsd: Number(c.total_cost_usd) || 0,
    tokens: c.total_tokens,
  }));
  const leadRows: LeadRow[] = (leadsRes.data ?? []).map((l) => ({
    id: l.id,
    createdAt: l.created_at,
    name: l.name,
    email: l.email,
    phone: l.phone,
    company: l.company,
    interest: l.interest,
    pageUrl: l.page_url,
    status: l.status,
    notifiedAt: l.notified_at,
    notifyError: l.notify_error,
  }));
  const newLeads = leadRows.filter((l) => l.status === "new").length;

  // ---- Analytics ----
  const rangeFrom = daysAgo(today, days - 1);
  const prevTo = daysAgo(rangeFrom, 1);
  const prevFrom = daysAgo(prevTo, days - 1);
  const byDay = new Map(allDaily.map((d) => [d.day, d] as const));
  const emptyDaily = (day: string): DailyPoint => ({ day, conversations: 0, user_messages: 0, assistant_messages: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, embedding_tokens: 0, cost_usd: 0, leads: 0, handoffs: 0 });
  const dailyPoints: DailyPoint[] = daysBetween(rangeFrom, today).map((day) => {
    const d = byDay.get(day);
    return d ? { ...emptyDaily(day), ...d, cost_usd: Number(d.cost_usd) || 0 } : emptyDaily(day);
  });
  const sumTotals = (from: string, to: string): Totals =>
    allDaily
      .filter((d) => d.day >= from && d.day <= to)
      .reduce<Totals>(
        (acc, d) => ({
          conversations: acc.conversations + d.conversations,
          messages: acc.messages + d.user_messages,
          leads: acc.leads + d.leads,
          handoffs: acc.handoffs + d.handoffs,
          input: acc.input + Number(d.input_tokens),
          cached: acc.cached + Number(d.cached_input_tokens),
          output: acc.output + Number(d.output_tokens),
          embedding: acc.embedding + Number(d.embedding_tokens),
          cost: acc.cost + (Number(d.cost_usd) || 0),
        }),
        { conversations: 0, messages: 0, leads: 0, handoffs: 0, input: 0, cached: 0, output: 0, embedding: 0, cost: 0 },
      );
  const modelShares = new Map<string, { model: string; calls: number; tokens: number; cost: number }>();
  for (const m of modelDailyRes.data ?? []) {
    const cur = modelShares.get(m.model) ?? { model: m.model, calls: 0, tokens: 0, cost: 0 };
    cur.calls += m.calls;
    cur.tokens += Number(m.input_tokens) + Number(m.output_tokens);
    cur.cost += Number(m.cost_usd) || 0;
    modelShares.set(m.model, cur);
  }
  const monthsMap = new Map<string, { conversations: number; messages: number; tokens: number; cost: number }>();
  for (const d of allDaily) {
    const key = monthStart(d.day);
    const cur = monthsMap.get(key) ?? { conversations: 0, messages: 0, tokens: 0, cost: 0 };
    cur.conversations += d.conversations;
    cur.messages += d.user_messages;
    cur.tokens += Number(d.input_tokens) + Number(d.output_tokens);
    cur.cost += Number(d.cost_usd) || 0;
    monthsMap.set(key, cur);
  }
  const linkByPeriod = new Map(links.map((l) => [l.period, l] as const));
  const months = Array.from({ length: 12 }, (_, i) => addMonths(period, -i))
    .filter((pd) => monthsMap.has(pd) || linkByPeriod.get(pd)?.invoice)
    .map((pd) => {
      const m = monthsMap.get(pd) ?? { conversations: 0, messages: 0, tokens: 0, cost: 0 };
      const l = linkByPeriod.get(pd);
      return {
        period: pd,
        label: periodLabel(pd),
        ...m,
        invoice: l?.invoice ? { number: l.invoice.invoice_number, status: l.invoice.status ?? "issued", total: Number(l.total) || 0, currency: l.currency } : null,
      };
    });
  const monthAgg = aggregateByModel(monthUsageRes.data ?? []);
  const estimate = composeAiInvoice({
    period,
    agentName: project.agent_name,
    websiteUrl: project.website_url,
    conversations: monthConvRes.count ?? 0,
    models: monthAgg.models,
    embeddingTokens: monthAgg.embeddingTokens,
    fee: Number(project.monthly_fee) || 0,
    markup: Number(project.usage_markup) || 0,
    minimum: Number(project.monthly_minimum) || 0,
    currency: project.billing_currency,
    fxLkrPerUsd: project.fx_lkr_per_usd == null ? null : Number(project.fx_lkr_per_usd),
    wasActive: project.status === "active" || monthAgg.models.length > 0,
  });
  const analytics: AnalyticsData = {
    projectId: project.id,
    days,
    range: { from: rangeFrom, to: today },
    totals: sumTotals(rangeFrom, today),
    previous: sumTotals(prevFrom, prevTo),
    daily: dailyPoints,
    models: Array.from(modelShares.values()).sort((a, b) => b.cost - a.cost),
    months,
    estimate: estimate.ok
      ? { total: estimate.grandTotal, currency: estimate.currency, skip: estimate.skip, error: null, label: periodLabel(period) }
      : { total: 0, currency: project.billing_currency, skip: true, error: estimate.error, label: periodLabel(period) },
  };

  // ---- Invoices ----
  const invoicesData: InvoicesPanelData = {
    projectId: project.id,
    settings: {
      enabled: project.billing_enabled,
      currency: project.billing_currency,
      fee: Number(project.monthly_fee) || 0,
      markup: Number(project.usage_markup) || 1,
      minimum: Number(project.monthly_minimum) || 0,
      fx: project.fx_lkr_per_usd == null ? null : Number(project.fx_lkr_per_usd),
      mode: project.invoice_mode,
      billingFrom: project.billing_from,
    },
    history: links.map<InvoiceHistoryRow>((l) => ({
      id: l.id,
      period: l.period,
      label: periodLabel(l.period),
      status: l.status,
      total: l.total == null ? null : Number(l.total),
      currency: l.currency,
      usageCostUsd: Number(l.usage_cost_usd) || 0,
      markup: l.markup == null ? null : Number(l.markup),
      error: l.error,
      emailed: l.emailed,
      createdAt: l.created_at,
      invoice: l.invoice
        ? { id: l.invoice.id, number: l.invoice.invoice_number, date: l.invoice.invoice_date, status: l.invoice.status, shareToken: l.invoice.share_token }
        : null,
    })),
    raisable: Array.from({ length: 12 }, (_, i) => addMonths(period, -(i + 1))).map((pd) => ({ period: pd, label: periodLabel(pd) })),
    clientEmail: project.client?.email ?? null,
    nextRun: new Date(`${nextPeriod(period)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
  };

  // ---- Backend (0127) ----
  const toolRows: ToolRow[] = (toolsRes.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    label: t.label,
    description: t.description,
    kind: t.kind,
    method: t.method,
    path: t.path,
    parameters: Array.isArray(t.parameters) ? t.parameters : [],
    timeoutMs: t.timeout_ms,
    enabled: t.enabled,
    calls: t.calls_30d,
    failures: t.failures_30d,
    lastCalledAt: t.last_called_at,
    lastError: t.last_error,
  }));
  const deliveryRows: DeliveryRow[] = (
    (deliveriesRes.data ?? []) as unknown as (Database["public"]["Tables"]["ai_deliveries"]["Row"] & {
      lead: { name: string | null } | null;
    })[]
  ).map((d) => ({
    id: d.id,
    kind: d.kind,
    status: d.status,
    attempts: d.attempts,
    lastStatus: d.last_status,
    lastError: d.last_error,
    nextAttemptAt: d.next_attempt_at,
    deliveredAt: d.delivered_at,
    createdAt: d.created_at,
    leadName: d.lead?.name ?? null,
  }));
  const backendData: BackendPanelData = {
    projectId: project.id,
    baseUrl: project.backend_base_url ?? "",
    hasSecret: Boolean(project.backend_secret_enc),
    hasReadKey: Boolean(project.read_key_enc),
    cryptoConfigured: isSocialCryptoConfigured(),
    verifiedAt: project.backend_verified_at,
    lastError: project.backend_last_error,
    deliveryEnabled: project.lead_delivery_enabled,
    webhookPath: project.lead_webhook_path,
    tools: toolRows,
    deliveries: deliveryRows,
    kit: buildKit({
      crmOrigin: crmOrigin() ?? "https://your-crm-host",
      projectKey: project.public_key,
      // Revealed here only for an admin who is pasting it into a .env; the
      // page itself is behind requireAdmin().
      secret: decryptToken(project.backend_secret_enc),
      readKey: decryptToken(project.read_key_enc),
      webhookPath: project.lead_webhook_path,
      agentName: project.agent_name,
      tools: (toolsRes.data ?? []).filter((t) => t.enabled).map(toolDefOf),
      calendarProvider: project.calendar_provider,
      availabilityPath: project.calendar_availability_path,
      bookPath: project.calendar_book_path,
      timezone: project.calendar_timezone,
    }),
    supabase: {
      url: project.supabase_url ?? "",
      hasKey: Boolean(project.supabase_anon_key_enc),
      table: project.supabase_leads_table,
      fieldMap: Object.keys(project.supabase_field_map ?? {}).length
        ? (project.supabase_field_map as Record<string, string>)
        : DEFAULT_FIELD_MAP,
      enabled: project.supabase_delivery_enabled,
      verifiedAt: project.supabase_verified_at,
      lastError: project.supabase_last_error,
      policySql: rlsPolicySql(project.supabase_leads_table),
    },
    calendar: {
      provider: project.calendar_provider,
      hasKey: Boolean(project.calendar_api_key_enc),
      eventTypeId: project.calendar_event_type_id ?? "",
      timezone: project.calendar_timezone,
      availabilityPath: project.calendar_availability_path,
      bookPath: project.calendar_book_path,
      apiBase: project.calendar_api_base ?? "",
      verifiedAt: project.calendar_verified_at,
      lastError: project.calendar_last_error,
    },
  };
  const failedDeliveries = deliveryRows.filter((d) => d.status === "failed").length;

  const meta = AI_STATUS_META[project.status];
  const host = hostOf(project.website_url);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span
            className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl text-white shadow-sm"
            style={{ backgroundColor: project.primary_color || "#f97316" }}
          >
            {project.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={project.avatar_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <Bot className="h-6 w-6" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{project.name}</h1>
              <Badge className={meta.className} dot={meta.dot}>
                {meta.label}
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              {project.client ? (
                <Link href={`/clients/${project.client.id}`} className="hover:underline">
                  {project.client.company || project.client.name}
                </Link>
              ) : (
                "No client linked"
              )}
              {host && (
                <>
                  {" · "}
                  <a href={project.website_url ?? "#"} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                    {host} <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              )}
              {" · "}
              {project.agent_name} on {project.model}
            </p>
          </div>
        </div>
        <Link href="/ai-projects" className="text-sm text-slate-500 hover:text-slate-900">
          ← All AI projects
        </Link>
      </div>

      <AiProjectTabs
        initialTab={initialTab}
        knowledgeBadge={knowledge.pending + knowledge.failed ? String(knowledge.pending + knowledge.failed) : undefined}
        leadsBadge={newLeads ? String(newLeads) : undefined}
        backendBadge={failedDeliveries ? String(failedDeliveries) : undefined}
        overview={<OverviewPanel data={overview} />}
        knowledge={<KnowledgePanel data={knowledgeData} />}
        agent={<AgentPanel data={agent} />}
        deploy={<DeployPanel data={deployData} />}
        backend={<BackendPanel data={backendData} />}
        analytics={<AnalyticsPanel data={analytics} />}
        invoices={<InvoicesPanel data={invoicesData} />}
        conversations={<ConversationsPanel projectId={project.id} conversations={conversationRows} />}
        leads={<LeadsPanel projectId={project.id} leads={leadRows} notificationEmail={project.notification_email} />}
      />
    </div>
  );
}
