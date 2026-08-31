import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";

import { SITE } from "./source";
import {
  getDaily,
  getFunnel,
  getJourneys,
  getTopPages,
  mergeBreakdown,
  previousRange,
  rangeForDays,
  totalsFrom,
  type Range,
  type Totals,
} from "./queries";

type DB = SupabaseClient<Database>;

export type ReportKind = "daily" | "weekly" | "monthly" | "quarterly" | "custom";

const DAYS_FOR: Record<Exclude<ReportKind, "custom">, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
};

/**
 * The evidence a report is written from.
 *
 * Assembled once and stored on the report row alongside the prose, so
 * any number in the narrative can be checked against the figure it came
 * from months later — including when the underlying rollups have since
 * been recomputed.
 */
export type ReportStats = {
  range: Range;
  totals: Totals;
  previous: Totals;
  deltas: Record<string, number>;
  channels: { key: string; count: number }[];
  devices: { key: string; count: number }[];
  countries: { key: string; count: number }[];
  browsers: { key: string; count: number }[];
  campaigns: { key: string; count: number }[];
  topPages: Awaited<ReturnType<typeof getTopPages>>;
  entryPages: { key: string; count: number }[];
  exitPages: { key: string; count: number }[];
  referrers: { key: string; count: number }[];
  funnel: { stage: string; sessions: number; rate: number }[];
  topPaths: { sequence: string; sessions: number; conversions: number }[];
  dropOffs: { from: string; sessions: number; dropOffs: number; rate: number }[];
  webVitals: Record<string, { avg: number; samples: number }>;
  chat: { sessions: number; messages: number; topics: { key: string; count: number }[] };
};

/** Percentage change, guarding the divide-by-zero that a first period always is. */
function delta(now: number, before: number): number {
  if (!before) return now ? 100 : 0;
  return Number((((now - before) / before) * 100).toFixed(1));
}

function mergeJson(
  rows: Awaited<ReturnType<typeof getDaily>>,
  key: "top_entry_pages" | "top_exit_pages" | "top_referrers",
): { key: string; count: number }[] {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const list = (row[key] ?? []) as { key: string; count: number }[];
    for (const item of list) {
      if (!item?.key) continue;
      totals[item.key] = (totals[item.key] ?? 0) + Number(item.count ?? 0);
    }
  }
  return Object.entries(totals)
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

export async function collectReportStats(
  supabase: DB,
  range: Range,
): Promise<ReportStats> {
  const prevRange = previousRange(range);
  const [daily, prevDaily, topPages, funnel, journeys] = await Promise.all([
    getDaily(supabase, range),
    getDaily(supabase, prevRange),
    getTopPages(supabase, range, 25),
    getFunnel(supabase, range),
    getJourneys(supabase),
  ]);

  const totals = totalsFrom(daily);
  const previous = totalsFrom(prevDaily);

  const webVitals: Record<string, { avg: number; samples: number }> = {};
  for (const row of daily) {
    const vitals = (row.web_vitals ?? {}) as Record<string, { avg: number; samples: number }>;
    for (const [name, v] of Object.entries(vitals)) {
      const current = webVitals[name] ?? { avg: 0, samples: 0 };
      const samples = current.samples + (v?.samples ?? 0);
      // Weighted by sample count so a day with three measurements does
      // not swing the period's LCP as hard as a day with three hundred.
      const avg = samples
        ? (current.avg * current.samples + (v?.avg ?? 0) * (v?.samples ?? 0)) / samples
        : 0;
      webVitals[name] = { avg: Number(avg.toFixed(1)), samples };
    }
  }

  const { data: chatRows } = await supabase
    .from("web_chat_sessions")
    .select("topic, message_count")
    .eq("site", SITE)
    .gte("started_at", `${range.from}T00:00:00.000Z`)
    .lte("started_at", `${range.to}T23:59:59.999Z`)
    .limit(2000);

  const topicCounts: Record<string, number> = {};
  for (const row of chatRows ?? []) {
    const key = row.topic?.trim() || "(unclassified)";
    topicCounts[key] = (topicCounts[key] ?? 0) + 1;
  }

  return {
    range,
    totals,
    previous,
    deltas: {
      sessions: delta(totals.sessions, previous.sessions),
      visitors: delta(totals.visitors, previous.visitors),
      pageviews: delta(totals.pageviews, previous.pageviews),
      conversions: delta(totals.conversions, previous.conversions),
      conversionRate: delta(totals.conversionRate, previous.conversionRate),
      bounceRate: delta(totals.bounceRate, previous.bounceRate),
      avgEngaged: delta(totals.avgEngaged, previous.avgEngaged),
      chatSessions: delta(totals.chatSessions, previous.chatSessions),
    },
    channels: mergeBreakdown(daily, "by_channel").slice(0, 12),
    devices: mergeBreakdown(daily, "by_device").slice(0, 8),
    countries: mergeBreakdown(daily, "by_country").slice(0, 15),
    browsers: mergeBreakdown(daily, "by_browser").slice(0, 10),
    campaigns: mergeBreakdown(daily, "by_campaign").slice(0, 10),
    topPages,
    entryPages: mergeJson(daily, "top_entry_pages"),
    exitPages: mergeJson(daily, "top_exit_pages"),
    referrers: mergeJson(daily, "top_referrers"),
    funnel,
    topPaths: journeys.paths.slice(0, 15).map((p) => ({
      sequence: p.path_sequence ?? "",
      sessions: p.sessions,
      conversions: p.conversions,
    })),
    dropOffs: journeys.transitions
      .filter((t) => !t.to_path && t.sessions > 0)
      .slice(0, 15)
      .map((t) => ({
        from: t.from_path ?? "",
        sessions: t.sessions,
        dropOffs: t.drop_offs,
        rate: t.sessions ? Number(((t.drop_offs / t.sessions) * 100).toFixed(1)) : 0,
      })),
    webVitals,
    chat: {
      sessions: chatRows?.length ?? 0,
      messages: (chatRows ?? []).reduce((n, r) => n + (r.message_count ?? 0), 0),
      topics: Object.entries(topicCounts)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    },
  };
}

const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n}%`;

const mins = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
};

/**
 * The report written without a model.
 *
 * Not a placeholder: this is the whole picture in prose, and it is what
 * gets stored whenever OpenAI is unconfigured or unreachable. A report
 * that always exists beats a better one that sometimes does.
 */
function writeDeterministicReport(stats: ReportStats, title: string): {
  content: string;
  highlights: string[];
  recommendations: string[];
} {
  const t = stats.totals;
  const d = stats.deltas;

  const highlights: string[] = [
    `${t.sessions.toLocaleString()} visits from ${t.visitors.toLocaleString()} people (${signed(d.sessions)} on the period before).`,
    `${t.conversions} conversions — a ${t.conversionRate}% rate (${signed(d.conversions)}).`,
    `${t.bounceRate}% bounced; the average visit held attention for ${mins(t.avgEngaged)}.`,
  ];
  if (stats.channels[0]) {
    highlights.push(
      `${stats.channels[0].key} was the biggest channel with ${stats.channels[0].count} visits.`,
    );
  }
  if (stats.topPages[0]) {
    highlights.push(
      `${stats.topPages[0].path} was the most-read page (${stats.topPages[0].pageviews} views).`,
    );
  }

  const recommendations: string[] = [];
  const worstExit = stats.dropOffs[0];
  if (worstExit && worstExit.rate > 50) {
    recommendations.push(
      `${worstExit.from} ends ${worstExit.rate}% of the visits that reach it — it is the biggest single leak on the site.`,
    );
  }
  if (t.formsStarted && t.formsAbandoned / t.formsStarted > 0.4) {
    recommendations.push(
      `${t.formsAbandoned} of ${t.formsStarted} form starts were abandoned. Shorten the form or ask for less up front.`,
    );
  }
  if (t.rageClicks > 10) {
    recommendations.push(
      `${t.rageClicks} rage clicks — something is being clicked that does not respond. Worth watching a session replay of those pages.`,
    );
  }
  if (t.bounceRate > 60) {
    recommendations.push(
      `A ${t.bounceRate}% bounce rate means most arrivals leave from the page they landed on. Check that the top entry pages match what the ads and search results promise.`,
    );
  }
  const lcp = stats.webVitals.LCP;
  if (lcp && lcp.avg > 2500) {
    recommendations.push(
      `Largest Contentful Paint averages ${Math.round(lcp.avg)}ms against a 2500ms target — the site feels slow on real devices, and that costs conversions before anyone reads a word.`,
    );
  }
  if (!recommendations.length) {
    recommendations.push(
      "Nothing is obviously broken this period. The next gain is likely in volume rather than in fixing a leak.",
    );
  }

  const table = (rows: { key: string; count: number }[]): string =>
    rows.length
      ? rows.map((r) => `| ${r.key} | ${r.count} |`).join("\n")
      : "| (nothing recorded) | 0 |";

  const content = `# ${title}

**${stats.range.from} to ${stats.range.to}** · ${SITE}

## The numbers

| Metric | This period | Change |
| --- | --- | --- |
| Visits | ${t.sessions.toLocaleString()} | ${signed(d.sessions)} |
| People | ${t.visitors.toLocaleString()} | ${signed(d.visitors)} |
| New / returning | ${t.newVisitors} / ${t.returningVisitors} | — |
| Page views | ${t.pageviews.toLocaleString()} | ${signed(d.pageviews)} |
| Pages per visit | ${t.pagesPerSession} | — |
| Engaged time | ${mins(t.avgEngaged)} | ${signed(d.avgEngaged)} |
| Bounce rate | ${t.bounceRate}% | ${signed(d.bounceRate)} |
| Conversions | ${t.conversions} | ${signed(d.conversions)} |
| Conversion rate | ${t.conversionRate}% | ${signed(d.conversionRate)} |
| AI chat conversations | ${t.chatSessions} | ${signed(d.chatSessions)} |

## Where they came from

| Channel | Visits |
| --- | --- |
${table(stats.channels)}

## What they read

| Page | Views | Avg time | Avg scroll |
| --- | --- | --- | --- |
${
    stats.topPages.length
      ? stats.topPages
          .slice(0, 12)
          .map(
            (p) =>
              `| ${p.path} | ${p.pageviews} | ${mins(p.avgSeconds)} | ${p.avgScroll}% |`,
          )
          .join("\n")
      : "| (nothing recorded) | 0 | 0s | 0% |"
  }

## The routes they took

${
    stats.topPaths.length
      ? stats.topPaths
          .slice(0, 10)
          .map((p) => `- \`${p.sequence}\` — ${p.sessions} visits, ${p.conversions} converted`)
          .join("\n")
      : "- No multi-page journeys recorded yet."
  }

## Where they left

${
    stats.dropOffs.length
      ? stats.dropOffs
          .slice(0, 8)
          .map((d2) => `- **${d2.from}** — ${d2.dropOffs} of ${d2.sessions} visits ended here (${d2.rate}%)`)
          .join("\n")
      : "- No exit concentration worth flagging."
  }

## The funnel

${stats.funnel.map((f) => `- ${f.stage}: **${f.sessions}** (${f.rate}%)`).join("\n")}

## Devices and places

| Device | Visits |
| --- | --- |
${table(stats.devices)}

| Country | Visits |
| --- | --- |
${table(stats.countries)}

## What to do about it

${recommendations.map((r) => `- ${r}`).join("\n")}
`;

  return { content, highlights, recommendations };
}

/** Ask the model to write the narrative over the same numbers. */
async function writeAiReport(
  stats: ReportStats,
  title: string,
): Promise<{ content: string; highlights: string[]; recommendations: string[] } | null> {
  try {
    const raw = await openaiChatJSON(
      [
        {
          role: "system",
          content:
            "You are a growth analyst writing a website performance report for the owner of a " +
            "small AI and digital-marketing agency. You are given real analytics for their own " +
            "site. Write in plain British English, direct and specific. Every claim must come " +
            "from the numbers provided — never invent a figure, and if the data is too thin to " +
            "support a conclusion, say that instead of guessing. Prefer 'the pricing page loses " +
            "62% of the people who reach it' over 'engagement could be improved'. " +
            'Return JSON: { "content": "<markdown report>", "highlights": ["…"], ' +
            '"recommendations": ["…"] }. The markdown must include sections for headline ' +
            "numbers, traffic sources, page performance, the journeys people take, where they " +
            "drop off, the funnel, the AI chat, and what to do next. Highlights: 3-6 short " +
            "sentences. Recommendations: 3-6 concrete actions, each tied to the number that " +
            "motivates it.",
        },
        {
          role: "user",
          content: `Title: ${title}\nSite: ${SITE}\n\nAnalytics JSON:\n${JSON.stringify(stats)}`,
        },
      ],
      { timeoutMs: 90_000 },
    );

    const parsed = JSON.parse(raw) as {
      content?: string;
      highlights?: string[];
      recommendations?: string[];
    };
    if (!parsed.content) return null;
    return {
      content: parsed.content,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 8) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 8)
        : [],
    };
  } catch {
    // A model that is down, slow or returns malformed JSON must not cost
    // the user their report — the caller falls back to the written one.
    return null;
  }
}

const TITLES: Record<ReportKind, string> = {
  daily: "Daily website report",
  weekly: "Weekly website report",
  monthly: "Monthly website report",
  quarterly: "Quarterly website report",
  custom: "Website report",
};

/**
 * Build and store one report.
 *
 * Upserts on (site, kind, period) in spirit: regenerating the same week
 * replaces it rather than stacking near-identical rows, because the only
 * reason to regenerate is that the first one was written before the data
 * was complete.
 */
export async function generateWebReport(
  supabase: DB,
  kind: ReportKind,
  opts: { days?: number; createdBy?: string | null } = {},
): Promise<{ id: string; content: string; usedAi: boolean }> {
  const days = opts.days ?? (kind === "custom" ? 30 : DAYS_FOR[kind]);
  const range = rangeForDays(days);
  const stats = await collectReportStats(supabase, range);
  const title = `${TITLES[kind]} — ${range.from} to ${range.to}`;

  const ai = isOpenAIConfigured() ? await writeAiReport(stats, title) : null;
  const written = ai ?? writeDeterministicReport(stats, title);

  await supabase
    .from("web_reports")
    .delete()
    .eq("site", SITE)
    .eq("kind", kind)
    .eq("period_start", range.from)
    .eq("period_end", range.to);

  const { data, error } = await supabase
    .from("web_reports")
    .insert({
      site: SITE,
      kind,
      period_start: range.from,
      period_end: range.to,
      title,
      content: written.content,
      stats: stats as unknown as Record<string, unknown>,
      highlights: written.highlights,
      recommendations: written.recommendations,
      generated_by: ai ? "ai" : "computed",
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return { id: data.id, content: written.content, usedAi: Boolean(ai) };
}

// -- chat analysis ----------------------------------------------------------

/**
 * Read the website agent's conversations and label them.
 *
 * Runs on conversations that have never been analysed, oldest first, in
 * small batches — it is the one part of this pipeline that costs money
 * per row, so it is deliberately slow and resumable rather than an
 * all-at-once pass that would bill for a year of history on first run.
 */
export async function analyseChatSessions(
  supabase: DB,
  limit = 15,
): Promise<{ analysed: number }> {
  if (!isOpenAIConfigured()) return { analysed: 0 };

  const { data } = await supabase
    .from("web_chat_sessions")
    .select("id, transcript, first_user_message")
    .eq("site", SITE)
    .is("analysed_at", null)
    .gt("message_count", 1)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (!data?.length) return { analysed: 0 };

  let analysed = 0;
  for (const chat of data) {
    try {
      const raw = await openaiChatJSON(
        [
          {
            role: "system",
            content:
              "You classify conversations between website visitors and an AI sales agent for " +
              "an AI/digital-marketing agency. Return JSON: " +
              '{ "topic": "<2-4 words>", "intent": "pricing|services|support|hiring|partnership|' +
              'spam|other", "sentiment": "positive|neutral|negative", "summary": "<one sentence>", ' +
              '"buying_signals": ["…"], "questions_asked": ["…"] }. ' +
              "buying_signals are things the visitor said that indicate real purchase intent — a " +
              "budget, a timeline, a named project. Return an empty array rather than inventing one.",
          },
          { role: "user", content: (chat.transcript || "").slice(0, 12_000) },
        ],
        { timeoutMs: 45_000 },
      );

      const parsed = JSON.parse(raw) as Record<string, unknown>;
      await supabase
        .from("web_chat_sessions")
        .update({
          topic: String(parsed.topic ?? "").slice(0, 100) || null,
          intent: String(parsed.intent ?? "").slice(0, 40) || null,
          sentiment: String(parsed.sentiment ?? "").slice(0, 20) || null,
          summary: String(parsed.summary ?? "").slice(0, 1000) || null,
          buying_signals: Array.isArray(parsed.buying_signals) ? parsed.buying_signals : [],
          questions_asked: Array.isArray(parsed.questions_asked) ? parsed.questions_asked : [],
          analysed_at: new Date().toISOString(),
        })
        .eq("id", chat.id);
      analysed++;
    } catch {
      // Stamp it so one unparseable conversation is not retried forever
      // at the front of the queue, blocking every one behind it.
      await supabase
        .from("web_chat_sessions")
        .update({ analysed_at: new Date().toISOString() })
        .eq("id", chat.id);
    }
  }

  return { analysed };
}
