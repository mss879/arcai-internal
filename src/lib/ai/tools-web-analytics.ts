import "server-only";

import type { ToolSchema } from "@/lib/ai/openai";
import type { ToolContext, ToolResult } from "@/lib/ai/tools";
import { generateWebReport } from "@/lib/web-analytics/report";
import {
  getChatSessions,
  getDaily,
  getFunnel,
  getJourneys,
  getTopPages,
  mergeBreakdown,
  previousRange,
  rangeForDays,
  totalsFrom,
} from "@/lib/web-analytics/queries";
import { runWebAnalyticsPipeline } from "@/lib/web-analytics/run";
import { isWebsiteSourceConfigured, SITE } from "@/lib/web-analytics/source";

/**
 * Web Analytics, as tools Arcus can call.
 *
 * The dashboard is for looking; this is for asking. "Why did enquiries
 * drop last week", "which page loses the most people", "what are visitors
 * asking the website bot about" are all questions with an answer sitting
 * in these tables, and none of them are a chart.
 *
 * Every tool returns pre-aggregated numbers rather than rows. A model
 * handed four thousand raw events will summarise them badly and expensively;
 * handed the same summary the dashboard uses, it reasons about the actual
 * question. The one exception is `website_chat_review`, where the words
 * people used ARE the answer.
 */

const NOT_CONFIGURED = {
  error:
    "Web Analytics is not connected. Add WEBSITE_SUPABASE_URL and " +
    "WEBSITE_SUPABASE_SERVICE_ROLE_KEY to the environment, then run the " +
    "0105 migration and the website's own analytics migration.",
} as const;

export const WEB_ANALYTICS_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "website_traffic_report",
      description:
        `Traffic and conversion figures for ${SITE} — visits, people, page views, ` +
        "bounce rate, engaged time, conversions, AI-chat volume, and the breakdown " +
        "by channel, device, country, browser and campaign. Always compared against " +
        "the previous window of the same length. Use for any question about how the " +
        "website is doing, where visitors come from, or whether traffic is up or down.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Window length in days. Default 30. Max 365.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "website_page_performance",
      description:
        `Per-page numbers for ${SITE}: views, entries, exits, average reading time, ` +
        "scroll depth, form starts and abandons, conversions and rage clicks. Use to " +
        "answer which pages work, which pages lose people, and where to spend effort.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Window length in days. Default 30." },
          limit: { type: "number", description: "How many pages. Default 20, max 60." },
          path: {
            type: "string",
            description: "Only pages containing this string, e.g. '/services'.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "website_journeys",
      description:
        "The routes visitors take through the site: the most common whole paths " +
        "(landing page, then where), the most common next steps from each page, and " +
        "the pages where visits end. Use for 'do they land on the home page and then " +
        "go where', or to find the biggest drop-off on the site.",
      parameters: {
        type: "object",
        properties: {
          from_path: {
            type: "string",
            description: "Only journeys starting from or passing through this path.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "website_chat_review",
      description:
        `Conversations the AI agent on ${SITE} has had with visitors — topic, intent, ` +
        "sentiment, the questions asked, any buying signals, and the captured email " +
        "where one was given. Use to answer what visitors are actually asking about, " +
        "which enquiries came through chat, or whether the bot is handling something badly.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many conversations. Default 20, max 50." },
          intent: {
            type: "string",
            description: "Filter to one intent: pricing, services, support, hiring, partnership.",
          },
          with_signals_only: {
            type: "boolean",
            description: "Only conversations with recorded buying signals.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "website_generate_report",
      description:
        "Write and save a full website analytics report for a period. Returns the " +
        "report so it can be read out or emailed. Use when asked for a website report, " +
        "a traffic summary to send someone, or a written analysis rather than figures.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["daily", "weekly", "monthly", "quarterly"],
            description: "The period to cover. Default weekly.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "website_sync_now",
      description:
        `Pull the latest analytics and AI-chat transcripts from ${SITE} immediately, ` +
        "instead of waiting for the hourly schedule. Use when the user says the " +
        "numbers look stale, or has just changed something on the site and wants to see it.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
];

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const secs = (n: number): string => {
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
};

async function trafficReport(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isWebsiteSourceConfigured()) return { content: NOT_CONFIGURED };

  const days = clamp(args.days, 30, 1, 365);
  const range = rangeForDays(days);
  const [daily, priorDaily, funnel] = await Promise.all([
    getDaily(ctx.supabase, range),
    getDaily(ctx.supabase, previousRange(range)),
    getFunnel(ctx.supabase, range),
  ]);

  const totals = totalsFrom(daily);
  const previous = totalsFrom(priorDaily);

  if (!totals.sessions && !totals.pageviews) {
    return {
      content: {
        site: SITE,
        window: `${range.from} to ${range.to}`,
        summary: "No website traffic is recorded for this window.",
        empty_reason:
          "Either the tracker is not live on the site yet, or the sync has not run. " +
          "This means no data, not zero visitors.",
      },
      event: { kind: "read", label: "Web Analytics", href: "/web-analytics" },
    };
  }

  const change = (now: number, before: number): string => {
    if (!before) return now ? "new" : "flat";
    const pct = Math.round(((now - before) / before) * 100);
    return `${pct >= 0 ? "+" : ""}${pct}%`;
  };

  return {
    content: {
      site: SITE,
      window: `${range.from} to ${range.to} (${days} days)`,
      headline: {
        visits: totals.sessions,
        people: totals.visitors,
        new_people: totals.newVisitors,
        returning_people: totals.returningVisitors,
        page_views: totals.pageviews,
        pages_per_visit: totals.pagesPerSession,
        engaged_time: secs(totals.avgEngaged),
        bounce_rate: `${totals.bounceRate}%`,
        conversions: totals.conversions,
        conversion_rate: `${totals.conversionRate}%`,
        chat_conversations: totals.chatSessions,
        forms_started: totals.formsStarted,
        forms_abandoned: totals.formsAbandoned,
        rage_clicks: totals.rageClicks,
        js_errors: totals.errors,
      },
      vs_previous_period: {
        visits: change(totals.sessions, previous.sessions),
        people: change(totals.visitors, previous.visitors),
        conversions: change(totals.conversions, previous.conversions),
        bounce_rate: change(totals.bounceRate, previous.bounceRate),
        engaged_time: change(totals.avgEngaged, previous.avgEngaged),
      },
      by_channel: mergeBreakdown(daily, "by_channel").slice(0, 10),
      by_device: mergeBreakdown(daily, "by_device").slice(0, 6),
      by_country: mergeBreakdown(daily, "by_country").slice(0, 10),
      by_source: mergeBreakdown(daily, "by_source").slice(0, 10),
      by_campaign: mergeBreakdown(daily, "by_campaign").slice(0, 8),
      funnel,
      href: "/web-analytics",
    },
    event: { kind: "read", label: "Web Analytics", href: "/web-analytics" },
  };
}

async function pagePerformance(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isWebsiteSourceConfigured()) return { content: NOT_CONFIGURED };

  const days = clamp(args.days, 30, 1, 365);
  const limit = clamp(args.limit, 20, 1, 60);
  const filter = typeof args.path === "string" ? args.path.toLowerCase() : null;

  const range = rangeForDays(days);
  const pages = await getTopPages(ctx.supabase, range, 60);
  const filtered = filter
    ? pages.filter((p) => p.path.toLowerCase().includes(filter))
    : pages;

  return {
    content: {
      site: SITE,
      window: `${range.from} to ${range.to}`,
      pages: filtered.slice(0, limit).map((p) => ({
        path: p.path,
        title: p.title,
        views: p.pageviews,
        entries: p.entries,
        exits: p.exits,
        avg_time: secs(p.avgSeconds),
        avg_scroll: `${p.avgScroll}%`,
        form_starts: p.formStarts,
        form_abandons: p.formAbandons,
        conversions: p.conversions,
        cta_clicks: p.ctaClicks,
        rage_clicks: p.rageClicks,
      })),
      note:
        "Entries are visits that landed on the page; exits are visits that ended " +
        "on it. A high exit count on a page meant to lead somewhere is a leak.",
      href: "/web-analytics",
    },
    event: { kind: "read", label: "Page performance", href: "/web-analytics" },
  };
}

async function journeys(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isWebsiteSourceConfigured()) return { content: NOT_CONFIGURED };

  const filter = typeof args.from_path === "string" ? args.from_path.toLowerCase() : null;
  const { transitions, paths } = await getJourneys(ctx.supabase);

  const matchesPath = (value: string | null) =>
    !filter || (value ?? "").toLowerCase().includes(filter);

  return {
    content: {
      site: SITE,
      common_routes: paths
        .filter((p) => matchesPath(p.path_sequence))
        .slice(0, 20)
        .map((p) => ({
          route: p.path_sequence,
          visits: p.sessions,
          converted: p.conversions,
        })),
      next_steps: transitions
        .filter((t) => t.to_path && matchesPath(t.from_path))
        .slice(0, 25)
        .map((t) => ({ from: t.from_path, to: t.to_path, visits: t.sessions })),
      where_visits_end: transitions
        .filter((t) => !t.to_path && matchesPath(t.from_path))
        .sort((a, b) => b.drop_offs - a.drop_offs)
        .slice(0, 15)
        .map((t) => ({
          page: t.from_path,
          visits_ending_here: t.drop_offs,
          of_total_reaching_it: t.sessions,
          rate: t.sessions
            ? `${Math.round((t.drop_offs / t.sessions) * 100)}%`
            : "0%",
        })),
      note: "Computed over a rolling 30-day window; repeat views of the same page are collapsed.",
      href: "/web-analytics",
    },
    event: { kind: "read", label: "Visitor journeys", href: "/web-analytics" },
  };
}

async function chatReview(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isWebsiteSourceConfigured()) return { content: NOT_CONFIGURED };

  const limit = clamp(args.limit, 20, 1, 50);
  const intent = typeof args.intent === "string" ? args.intent.toLowerCase() : null;
  const signalsOnly = args.with_signals_only === true;

  const chats = await getChatSessions(ctx.supabase, 100);
  const filtered = chats
    .filter((c) => (intent ? (c.intent ?? "").toLowerCase() === intent : true))
    .filter((c) => (signalsOnly ? ((c.buying_signals ?? []) as unknown[]).length > 0 : true))
    .slice(0, limit);

  const topicCounts: Record<string, number> = {};
  for (const c of chats) {
    const key = c.topic?.trim() || "(unlabelled)";
    topicCounts[key] = (topicCounts[key] ?? 0) + 1;
  }

  return {
    content: {
      site: SITE,
      total_conversations_held: chats.length,
      topics: Object.entries(topicCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([topic, count]) => ({ topic, count })),
      conversations: filtered.map((c) => ({
        when: c.started_at,
        topic: c.topic,
        intent: c.intent,
        sentiment: c.sentiment,
        summary: c.summary,
        messages: c.message_count,
        first_question: c.first_user_message,
        questions_asked: c.questions_asked,
        buying_signals: c.buying_signals,
        email: c.captured_email,
        phone: c.captured_phone,
        already_a_lead: Boolean(c.matched_lead_id),
      })),
      href: "/web-analytics",
    },
    event: { kind: "read", label: "Website chat review", href: "/web-analytics" },
  };
}

async function generateReportTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isWebsiteSourceConfigured()) return { content: NOT_CONFIGURED };

  const kind =
    args.kind === "daily" || args.kind === "monthly" || args.kind === "quarterly"
      ? args.kind
      : "weekly";

  try {
    const report = await generateWebReport(ctx.supabase, kind, { createdBy: ctx.userId });
    return {
      content: {
        ok: true,
        kind,
        written_with_ai: report.usedAi,
        report: report.content,
        href: "/web-analytics",
      },
      event: { kind: "created", label: "Website report", href: "/web-analytics" },
    };
  } catch (e) {
    return {
      content: { error: e instanceof Error ? e.message : "Report failed." },
    };
  }
}

async function syncNowTool(ctx: ToolContext): Promise<ToolResult> {
  if (!isWebsiteSourceConfigured()) return { content: NOT_CONFIGURED };

  const result = await runWebAnalyticsPipeline(ctx.supabase, { analyseChats: true });
  return {
    content: {
      ok: result.ok,
      rows_pulled: result.sync?.totalRows ?? 0,
      days_recomputed: result.daysRolledUp,
      conversations_read: result.chatsAnalysed,
      per_stream: result.sync?.streams.map((s) => ({
        stream: s.stream,
        rows: s.rows,
        ok: s.ok,
        error: s.error,
      })),
      warnings: result.errors,
      href: "/web-analytics",
    },
    event: { kind: "updated", label: "Website sync", href: "/web-analytics" },
  };
}

export async function executeWebAnalyticsTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "website_traffic_report":
      return trafficReport(args, ctx);
    case "website_page_performance":
      return pagePerformance(args, ctx);
    case "website_journeys":
      return journeys(args, ctx);
    case "website_chat_review":
      return chatReview(args, ctx);
    case "website_generate_report":
      return generateReportTool(args, ctx);
    case "website_sync_now":
      return syncNowTool(ctx);
    default:
      return null;
  }
}
