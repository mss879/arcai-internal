import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { SITE } from "./source";

type DB = SupabaseClient<Database>;

/**
 * Everything the Web Analytics page reads.
 *
 * One module, so the page component stays a layout and every number on
 * screen has exactly one place it can have come from. Reads hit the
 * rollup tables wherever a rollup exists; only the panels that are
 * genuinely about individual visits (the live session list, the chat
 * transcripts) touch raw rows.
 */

export type Range = { from: string; to: string; days: number };

/** A window ending today, inclusive of both ends. */
export function rangeForDays(days: number): Range {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    days,
  };
}

/** The window of the same length immediately before `range`. */
export function previousRange(range: Range): Range {
  const from = new Date(`${range.from}T00:00:00Z`);
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (range.days - 1) * 86_400_000);
  return {
    from: prevFrom.toISOString().slice(0, 10),
    to: prevTo.toISOString().slice(0, 10),
    days: range.days,
  };
}

export type DailyRow = Database["public"]["Tables"]["web_daily"]["Row"];
export type PageDailyRow = Database["public"]["Tables"]["web_page_daily"]["Row"];
export type JourneyRow = Database["public"]["Tables"]["web_journeys"]["Row"];
export type WebSession = Database["public"]["Tables"]["web_sessions"]["Row"];
export type WebChatSession = Database["public"]["Tables"]["web_chat_sessions"]["Row"];
export type WebReport = Database["public"]["Tables"]["web_reports"]["Row"];

/** The headline numbers, summed across a window. */
export type Totals = {
  sessions: number;
  visitors: number;
  newVisitors: number;
  returningVisitors: number;
  pageviews: number;
  bounceRate: number;
  avgDuration: number;
  avgEngaged: number;
  pagesPerSession: number;
  conversions: number;
  conversionRate: number;
  chatSessions: number;
  chatMessages: number;
  formsStarted: number;
  formsAbandoned: number;
  rageClicks: number;
  errors: number;
};

const sum = (rows: DailyRow[], key: keyof DailyRow): number =>
  rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);

/**
 * Roll a set of daily rows into one set of totals.
 *
 * Averages are weighted by sessions, not averaged again. A day with two
 * visits and a day with two hundred must not count equally toward the
 * period's average duration — that is how a quiet Sunday ends up
 * dominating a month.
 */
export function totalsFrom(rows: DailyRow[]): Totals {
  const sessions = sum(rows, "sessions");
  const weighted = (key: keyof DailyRow): number => {
    if (!sessions) return 0;
    const total = rows.reduce(
      (n, r) => n + Number(r[key] ?? 0) * Number(r.sessions ?? 0),
      0,
    );
    return Number((total / sessions).toFixed(2));
  };
  const bounces = sum(rows, "bounces");
  const conversions = sum(rows, "conversions");

  return {
    sessions,
    visitors: sum(rows, "visitors"),
    newVisitors: sum(rows, "new_visitors"),
    returningVisitors: sum(rows, "returning_visitors"),
    pageviews: sum(rows, "pageviews"),
    bounceRate: sessions ? Number(((bounces / sessions) * 100).toFixed(2)) : 0,
    avgDuration: weighted("avg_duration_seconds"),
    avgEngaged: weighted("avg_engaged_seconds"),
    pagesPerSession: weighted("avg_pages_per_session"),
    conversions,
    conversionRate: sessions ? Number(((conversions / sessions) * 100).toFixed(2)) : 0,
    chatSessions: sum(rows, "chat_sessions"),
    chatMessages: sum(rows, "chat_messages"),
    formsStarted: sum(rows, "forms_started"),
    formsAbandoned: sum(rows, "forms_abandoned"),
    rageClicks: sum(rows, "rage_clicks"),
    errors: sum(rows, "errors"),
  };
}

/** Merge the per-day jsonb breakdowns into one tally for the window. */
export function mergeBreakdown(
  rows: DailyRow[],
  key: "by_channel" | "by_device" | "by_country" | "by_browser" | "by_source" | "by_campaign",
): { key: string; count: number }[] {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const obj = (row[key] ?? {}) as Record<string, number>;
    for (const [k, v] of Object.entries(obj)) {
      totals[k] = (totals[k] ?? 0) + Number(v ?? 0);
    }
  }
  return Object.entries(totals)
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count);
}

export async function getDaily(supabase: DB, range: Range): Promise<DailyRow[]> {
  const { data } = await supabase
    .from("web_daily")
    .select("*")
    .eq("site", SITE)
    .gte("day", range.from)
    .lte("day", range.to)
    .order("day", { ascending: true });
  return (data ?? []) as DailyRow[];
}

/** Per-page metrics for the window, aggregated across its days. */
export async function getTopPages(
  supabase: DB,
  range: Range,
  limit = 40,
): Promise<
  {
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
  }[]
> {
  const { data } = await supabase
    .from("web_page_daily")
    .select("*")
    .eq("site", SITE)
    .gte("day", range.from)
    .lte("day", range.to)
    .order("pageviews", { ascending: false })
    .limit(4000);

  const byPath = new Map<
    string,
    {
      path: string;
      title: string | null;
      pageviews: number;
      visitors: number;
      entries: number;
      exits: number;
      bounces: number;
      secondsWeighted: number;
      scrollWeighted: number;
      conversions: number;
      formStarts: number;
      formAbandons: number;
      rageClicks: number;
      ctaClicks: number;
    }
  >();

  for (const row of (data ?? []) as PageDailyRow[]) {
    const entry = byPath.get(row.path) ?? {
      path: row.path,
      title: row.page_title,
      pageviews: 0,
      visitors: 0,
      entries: 0,
      exits: 0,
      bounces: 0,
      secondsWeighted: 0,
      scrollWeighted: 0,
      conversions: 0,
      formStarts: 0,
      formAbandons: 0,
      rageClicks: 0,
      ctaClicks: 0,
    };
    entry.title ??= row.page_title;
    entry.pageviews += row.pageviews;
    // Unique visitors cannot be summed across days without double
    // counting anyone who came back — this is an upper bound, and the
    // column is labelled as such wherever it is shown.
    entry.visitors += row.unique_visitors;
    entry.entries += row.entries;
    entry.exits += row.exits;
    entry.bounces += row.bounces;
    entry.secondsWeighted += Number(row.avg_seconds_on_page) * row.pageviews;
    entry.scrollWeighted += Number(row.avg_scroll_pct) * row.pageviews;
    entry.conversions += row.conversions;
    entry.formStarts += row.form_starts;
    entry.formAbandons += row.form_abandons;
    entry.rageClicks += row.rage_clicks;
    entry.ctaClicks += row.cta_clicks;
    byPath.set(row.path, entry);
  }

  return [...byPath.values()]
    .sort((a, b) => b.pageviews - a.pageviews)
    .slice(0, limit)
    .map((e) => ({
      path: e.path,
      title: e.title,
      pageviews: e.pageviews,
      visitors: e.visitors,
      entries: e.entries,
      exits: e.exits,
      bounces: e.bounces,
      avgSeconds: e.pageviews ? Number((e.secondsWeighted / e.pageviews).toFixed(1)) : 0,
      avgScroll: e.pageviews ? Number((e.scrollWeighted / e.pageviews).toFixed(1)) : 0,
      conversions: e.conversions,
      formStarts: e.formStarts,
      formAbandons: e.formAbandons,
      rageClicks: e.rageClicks,
      ctaClicks: e.ctaClicks,
    }));
}

export async function getJourneys(
  supabase: DB,
): Promise<{ transitions: JourneyRow[]; paths: JourneyRow[] }> {
  const { data } = await supabase
    .from("web_journeys")
    .select("*")
    .eq("site", SITE)
    .order("period_start", { ascending: false })
    .order("sessions", { ascending: false })
    .limit(600);

  const rows = (data ?? []) as JourneyRow[];
  // Only the newest computed window — older ones are kept for history
  // but showing two periods at once would double every count on screen.
  const latest = rows[0]?.period_start;
  const current = rows.filter((r) => r.period_start === latest);
  return {
    transitions: current.filter((r) => r.kind === "transition").slice(0, 120),
    paths: current.filter((r) => r.kind === "path").slice(0, 60),
  };
}

/** The most recent visits, for the live feed. */
export async function getRecentSessions(supabase: DB, limit = 100): Promise<WebSession[]> {
  const { data } = await supabase
    .from("web_sessions")
    .select("*")
    .eq("site", SITE)
    .eq("is_bot", false)
    .order("first_seen_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as WebSession[];
}

/** Visits that turned into something, newest first. */
export async function getConvertingSessions(
  supabase: DB,
  range: Range,
  limit = 50,
): Promise<WebSession[]> {
  const { data } = await supabase
    .from("web_sessions")
    .select("*")
    .eq("site", SITE)
    .eq("converted", true)
    .gte("first_seen_at", `${range.from}T00:00:00.000Z`)
    .order("first_seen_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as WebSession[];
}

export async function getChatSessions(supabase: DB, limit = 60): Promise<WebChatSession[]> {
  const { data } = await supabase
    .from("web_chat_sessions")
    .select("*")
    .eq("site", SITE)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as WebChatSession[];
}

export async function getReports(supabase: DB, limit = 20): Promise<WebReport[]> {
  const { data } = await supabase
    .from("web_reports")
    .select("*")
    .eq("site", SITE)
    .order("period_start", { ascending: false })
    .limit(limit);
  return (data ?? []) as WebReport[];
}

export type SyncStatus = {
  stream: string;
  lastRunAt: string | null;
  lastOkAt: string | null;
  rowsSynced: number;
  lastError: string | null;
};

export async function getSyncStatus(supabase: DB): Promise<SyncStatus[]> {
  const { data } = await supabase
    .from("web_sync_state")
    .select("*")
    .order("stream", { ascending: true });
  return (data ?? []).map((r) => ({
    stream: r.stream,
    lastRunAt: r.last_run_at,
    lastOkAt: r.last_ok_at,
    rowsSynced: Number(r.rows_synced ?? 0),
    lastError: r.last_error,
  }));
}

/**
 * The funnel, as far as the data can honestly describe one.
 *
 * These are stages of intent, not a fixed page sequence — the site has
 * many entry points and no single checkout, so a rigid step-by-step
 * funnel would be fiction. Each stage is a strictly smaller subset of
 * the one above it, which is what makes the drop-off between them mean
 * something.
 */
export async function getFunnel(
  supabase: DB,
  range: Range,
): Promise<{ stage: string; sessions: number; rate: number }[]> {
  const { data } = await supabase
    .from("web_sessions")
    .select("page_count, engaged_seconds, forms_started, converted, chat_engaged")
    .eq("site", SITE)
    .eq("is_bot", false)
    .gte("first_seen_at", `${range.from}T00:00:00.000Z`)
    .lte("first_seen_at", `${range.to}T23:59:59.999Z`)
    .limit(20_000);

  const rows = data ?? [];
  const all = rows.length;
  const engaged = rows.filter((r) => r.engaged_seconds >= 10).length;
  const explored = rows.filter((r) => r.page_count >= 2).length;
  const interested = rows.filter((r) => r.forms_started > 0 || r.chat_engaged).length;
  const converted = rows.filter((r) => r.converted).length;

  const stages: [string, number][] = [
    ["Visited", all],
    ["Engaged (10s+)", engaged],
    ["Explored (2+ pages)", explored],
    ["Showed intent (form or chat)", interested],
    ["Converted", converted],
  ];

  return stages.map(([stage, sessions]) => ({
    stage,
    sessions,
    rate: all ? Number(((sessions / all) * 100).toFixed(1)) : 0,
  }));
}
