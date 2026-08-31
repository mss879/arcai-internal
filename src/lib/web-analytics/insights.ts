import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { AI_MODELS, isOpenAIConfigured, openaiChatJSON } from "@/lib/ai/openai";

import { collectReportStats, type ReportStats } from "./report";
import { rangeForDays } from "./queries";
import { SITE } from "./source";

type DB = SupabaseClient<Database>;

/**
 * The AI read on how the website is doing.
 *
 * The dashboard answers "what happened". This answers "so what" — which of
 * those numbers is costing money, what to change first, and what is quietly
 * working and should be done more of.
 *
 * Two things this is built around:
 *
 *   EVERYTHING GOES IN. The model is handed the whole picture — traffic,
 *   sources, per-page behaviour, the routes people take, where they leave,
 *   the funnel, field performance, the AI chat, form abandonment, rage
 *   clicks, errors — because the interesting findings are the ones that
 *   only exist ACROSS those. "Mobile is 68% of traffic, mobile LCP is 4.1s,
 *   and the mobile bounce rate is 22 points worse" is one finding from three
 *   datasets, and no single panel on the dashboard could ever show it.
 *
 *   IT MUST NOT INVENT. Every finding has to carry the figure it came from,
 *   and thin data has to be called thin rather than dressed up. An analytics
 *   report that confidently explains noise is worse than no report, because
 *   someone will go and act on it.
 */

/** The reasoning model this runs on, overridable per install. */
const INSIGHTS_MODEL = process.env.OPENAI_INSIGHTS_MODEL?.trim() || "gpt-5.6";
/** Effort is worth paying for here — this runs on demand, not per request. */
const INSIGHTS_EFFORT = process.env.OPENAI_INSIGHTS_EFFORT?.trim() || "high";
const TIMEOUT_MS = 240_000;

/**
 * Ceiling on the evidence handed to the model, in characters.
 *
 * Everything below is aggregated rather than raw, which normally lands well
 * inside this. The cap is the backstop for the case that is not true — a busy
 * month with hundreds of distinct URLs — where the payload would otherwise
 * grow past the point the model can reason over it carefully. Roughly 4
 * characters to a token, so ~30k tokens of evidence.
 */
const MAX_EVIDENCE_CHARS = 120_000;

export type InsightFinding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  area: string;
  evidence: string;
  recommendation: string;
  impact: "high" | "medium" | "low";
  effort: "high" | "medium" | "low";
};

/** One row of the improvement checklist. */
export type InsightTask = {
  title: string;
  detail: string;
  area: string;
  priority: "critical" | "high" | "medium" | "low";
  impact: "high" | "medium" | "low";
  effort: "high" | "medium" | "low";
  metric: string;
  target: string;
};

export type InsightResult = {
  health_score: number;
  headline: string;
  summary: string;
  findings: InsightFinding[];
  checklist: InsightTask[];
  quick_wins: string[];
  what_is_working: string[];
  watch_list: string[];
};

/**
 * Everything the model gets to reason over.
 *
 * `ReportStats` already assembles the bulk of it (totals, deltas, channels,
 * devices, geography, pages, funnel, journeys, vitals). This adds the parts
 * a written report does not need but an analyst does: the day-by-day series
 * so a trend or a spike is visible rather than averaged away, what the
 * conversions actually were, and the specific pages where people are raging,
 * abandoning forms or hitting errors.
 */
export type InsightEvidence = ReportStats & {
  site: string;
  daily_series: {
    day: string;
    sessions: number;
    visitors: number;
    pageviews: number;
    conversions: number;
    bounce_rate: number;
    avg_engaged_seconds: number;
  }[];
  conversions_by_kind: { kind: string; count: number }[];
  friction_pages: {
    path: string;
    rage_clicks: number;
    form_starts: number;
    form_abandons: number;
    abandon_rate: number | null;
  }[];
  device_split: {
    device: string;
    sessions: number;
    bounce_rate: number;
    conversion_rate: number;
    avg_engaged_seconds: number;
  }[];
  chat_intents: { intent: string; count: number }[];
  buying_signal_count: number;
  recent_errors: { page: string; message: string; count: number }[];
  identified_visitors: number;
  data_quality: {
    days_with_data: number;
    days_requested: number;
    total_sessions: number;
    /** Below this the model is told to hedge rather than diagnose. */
    thin: boolean;
    /**
     * How much of the window pre-dates the current tracker.
     *
     * The site ran a thin page-visit log for two years before the full
     * tracker went live, and that history is mirrored in so the archive has
     * no hole. Those rows have no device, browser, country, engagement,
     * scroll or form data — they never did. Without saying so here, every
     * scan reads the resulting zeroes as broken instrumentation and spends
     * its best finding telling you to fix analytics that are not broken.
     */
    legacy_sessions: number;
    tracked_sessions: number;
    legacy_note: string;
  };
};

const pct = (part: number, whole: number): number =>
  whole ? Number(((part / whole) * 100).toFixed(1)) : 0;

export async function collectInsightEvidence(
  supabase: DB,
  days: number,
): Promise<InsightEvidence> {
  const range = rangeForDays(days);
  const base = await collectReportStats(supabase, range);

  const from = `${range.from}T00:00:00.000Z`;
  const to = `${range.to}T23:59:59.999Z`;

  const [dailyRes, sessionsRes, pageRes, chatRes, errorRes, legacyRes] = await Promise.all([
    supabase
      .from("web_daily")
      .select(
        "day, sessions, visitors, pageviews, conversions, bounce_rate, avg_engaged_seconds",
      )
      .eq("site", SITE)
      .gte("day", range.from)
      .lte("day", range.to)
      .order("day", { ascending: true }),
    supabase
      .from("web_sessions")
      .select(
        "device_type, is_bounce, converted, conversion_kind, engaged_seconds, identified_email",
      )
      .eq("site", SITE)
      .eq("is_bot", false)
      .gte("first_seen_at", from)
      .lte("first_seen_at", to)
      .limit(20_000),
    supabase
      .from("web_page_daily")
      .select("path, rage_clicks, form_starts, form_abandons")
      .eq("site", SITE)
      .gte("day", range.from)
      .lte("day", range.to)
      .limit(4000),
    supabase
      .from("web_chat_sessions")
      .select("intent, buying_signals")
      .eq("site", SITE)
      .gte("started_at", from)
      .lte("started_at", to)
      .limit(2000),
    supabase
      .from("web_events")
      .select("path, element_text")
      .eq("site", SITE)
      .eq("kind", "error")
      .gte("occurred_at", from)
      .lte("occurred_at", to)
      .limit(500),
    supabase
      .from("web_sessions")
      .select("session_id", { count: "exact", head: true })
      .eq("site", SITE)
      .gte("first_seen_at", from)
      .lte("first_seen_at", to)
      .like("session_id", "legacy:%"),
  ]);

  // ---- device split: the cross-cut that most often explains a bad number --
  const sessions = sessionsRes.data ?? [];
  const byDevice = new Map<
    string,
    { sessions: number; bounces: number; conversions: number; engaged: number }
  >();
  const conversionKinds: Record<string, number> = {};
  let identified = 0;

  for (const s of sessions) {
    const key = s.device_type || "unknown";
    const d = byDevice.get(key) ?? { sessions: 0, bounces: 0, conversions: 0, engaged: 0 };
    d.sessions++;
    if (s.is_bounce) d.bounces++;
    if (s.converted) d.conversions++;
    d.engaged += s.engaged_seconds ?? 0;
    byDevice.set(key, d);

    if (s.converted) {
      const kind = s.conversion_kind || "unspecified";
      conversionKinds[kind] = (conversionKinds[kind] ?? 0) + 1;
    }
    if (s.identified_email) identified++;
  }

  // ---- friction: where people fight the page ------------------------------
  const byPath = new Map<
    string,
    { rage: number; starts: number; abandons: number }
  >();
  for (const row of pageRes.data ?? []) {
    const f = byPath.get(row.path) ?? { rage: 0, starts: 0, abandons: 0 };
    f.rage += row.rage_clicks;
    f.starts += row.form_starts;
    f.abandons += row.form_abandons;
    byPath.set(row.path, f);
  }

  const intents: Record<string, number> = {};
  let signals = 0;
  for (const c of chatRes.data ?? []) {
    const key = c.intent?.trim() || "unclassified";
    intents[key] = (intents[key] ?? 0) + 1;
    signals += ((c.buying_signals ?? []) as unknown[]).length;
  }

  // Group identical errors — one broken script firing 400 times is one
  // problem, and listing it 400 times would crowd out everything else.
  const errorCounts = new Map<string, { page: string; message: string; count: number }>();
  for (const e of errorRes.data ?? []) {
    const message = (e.element_text ?? "").slice(0, 200);
    if (!message) continue;
    const key = `${e.path}|${message}`;
    const hit = errorCounts.get(key);
    if (hit) hit.count++;
    else errorCounts.set(key, { page: e.path, message, count: 1 });
  }

  const daily = dailyRes.data ?? [];

  return {
    ...base,
    site: SITE,
    daily_series: daily.map((d) => ({
      day: d.day,
      sessions: d.sessions,
      visitors: d.visitors,
      pageviews: d.pageviews,
      conversions: d.conversions,
      bounce_rate: Number(d.bounce_rate),
      avg_engaged_seconds: Number(d.avg_engaged_seconds),
    })),
    conversions_by_kind: Object.entries(conversionKinds)
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    friction_pages: [...byPath.entries()]
      .map(([path, f]) => ({
        path,
        rage_clicks: f.rage,
        form_starts: f.starts,
        form_abandons: f.abandons,
        abandon_rate: f.starts ? pct(f.abandons, f.starts) : null,
      }))
      .filter((p) => p.rage_clicks > 0 || p.form_abandons > 0)
      .sort((a, b) => b.rage_clicks + b.form_abandons - (a.rage_clicks + a.form_abandons))
      .slice(0, 20),
    device_split: [...byDevice.entries()]
      .map(([device, d]) => ({
        device,
        sessions: d.sessions,
        bounce_rate: pct(d.bounces, d.sessions),
        conversion_rate: pct(d.conversions, d.sessions),
        avg_engaged_seconds: d.sessions ? Math.round(d.engaged / d.sessions) : 0,
      }))
      .sort((a, b) => b.sessions - a.sessions),
    chat_intents: Object.entries(intents)
      .map(([intent, count]) => ({ intent, count }))
      .sort((a, b) => b.count - a.count),
    buying_signal_count: signals,
    recent_errors: [...errorCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    identified_visitors: identified,
    data_quality: {
      days_with_data: daily.filter((d) => d.sessions > 0).length,
      days_requested: days,
      total_sessions: base.totals.sessions,
      // 30 sessions is not a sample you can diagnose a funnel from. Below
      // this the prompt tells the model to say so rather than pattern-match
      // noise into a confident recommendation someone then acts on.
      thin: base.totals.sessions < 30,
      legacy_sessions: legacyRes.count ?? 0,
      tracked_sessions: Math.max(0, base.totals.sessions - (legacyRes.count ?? 0)),
      legacy_note:
        "Sessions whose id begins 'legacy:' are reconstructed from the site's " +
        "old page-visit log, which recorded only visitor, path, referrer and " +
        "time. They have no device, browser, country, engaged time, scroll, " +
        "form or conversion data because none was ever captured — this is " +
        "history, NOT broken tracking. Do not report missing device/geo/" +
        "engagement on these as an instrumentation fault. Base any finding " +
        "about behaviour, devices, geography or conversion on tracked_sessions " +
        "only, and say so when that number is small.",
    },
  };
}

const SYSTEM_PROMPT = `You are a senior web analytics and CRO consultant reviewing a digital agency's own website (arcai.agency — AI automation and digital marketing, UK and Sri Lanka). You are given a complete analytics export and asked what it means.

You are being read by the business owner, who will act on what you say. Write for them: direct, specific, British English, no jargon for its own sake and no filler.

HARD RULES

1. Every finding must cite the actual numbers it rests on. "Bounce rate is 71% on /pricing against 44% site-wide" — not "bounce rate could be improved".
2. Never invent a figure. If something is not in the data, say it is not measured rather than estimating it.
3. READ data_quality FIRST. legacy_sessions are reconstructed from an old page-visit log and never had device, geography, engagement, scroll, form or conversion data. Zeroes there are the shape of the archive, not a bug — do not spend a finding telling them to fix analytics that are not broken. Judge behaviour, devices, geography and conversion on tracked_sessions, and if that number is small, say the tracker is new and the picture is still forming.
4. If data_quality.thin is true, or a segment has fewer than about 30 sessions, say plainly that the sample is too small to draw conclusions from and keep findings to what IS safe to say. Do not pattern-match noise. A confident explanation of eleven visits is worse than saying eleven visits tells us nothing.
5. Prefer findings that only exist ACROSS datasets — device against performance against bounce, channel against conversion, a page's traffic against where that traffic then goes. Anything visible on a single chart is already visible to them.
6. Distinguish severity (what it is costing) from impact and effort (whether to do it next). A critical issue that takes a month is not the first thing to start on.
7. Say what is WORKING as well as what is broken. Something to do more of is as actionable as something to fix.
8. health_score is a 0-100 read on the site's commercial performance, weighing conversion, engagement, traffic trend and technical health. Be honest — a site with traffic and no conversions is not healthy. If the data is too thin to score fairly, score conservatively and say so in the summary.

9. The checklist is the deliverable. Findings explain; the checklist is what someone opens on Monday and works through. Every item must be a single concrete action a person can start and finish — "cut the contact form from 9 fields to 4" not "improve the form". Order it so the top item is the one to do first. Each item carries the metric that motivates it and what good looks like, so it can be checked off honestly rather than by feel.

Return ONLY JSON in this exact shape:
{
  "health_score": 0-100,
  "headline": "one sentence — the thing you would say if you had one sentence",
  "summary": "2-4 sentences of overall read",
  "checklist": [
    {
      "title": "the action, imperative and specific",
      "detail": "how to do it and why it will move the number",
      "area": "traffic" | "conversion" | "content" | "performance" | "ux" | "chat" | "acquisition",
      "priority": "critical" | "high" | "medium" | "low",
      "impact": "high" | "medium" | "low",
      "effort": "high" | "medium" | "low",
      "metric": "the number this is about, as it stands today",
      "target": "what good looks like"
    }
  ],
  "findings": [
    {
      "title": "short, specific",
      "severity": "critical" | "high" | "medium" | "low",
      "area": "traffic" | "conversion" | "content" | "performance" | "ux" | "chat" | "acquisition",
      "evidence": "the numbers this rests on",
      "recommendation": "the concrete change to make",
      "impact": "high" | "medium" | "low",
      "effort": "high" | "medium" | "low"
    }
  ],
  "quick_wins": ["3-6 things doable this week, each tied to its number"],
  "what_is_working": ["2-5 things to keep or do more of"],
  "watch_list": ["2-5 things not yet a problem but worth watching, and why"]
}

Give 4-8 findings and 6-12 checklist items, both ordered by what you would do first.`;

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const LEVELS = new Set(["high", "medium", "low"]);

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const stringList = (v: unknown, cap: number): string[] =>
  Array.isArray(v) ? v.map((x) => text(x, 500)).filter(Boolean).slice(0, cap) : [];

/** Narrow the model's JSON to the shape the UI renders, dropping anything odd. */
function parseInsight(raw: string): InsightResult | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const headline = text(parsed.headline, 400);
  if (!headline) return null;

  const score = Number(parsed.health_score);
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];

  return {
    health_score: Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : 50,
    headline,
    summary: text(parsed.summary, 2000),
    findings: findings
      .map((f) => {
        const item = (f ?? {}) as Record<string, unknown>;
        const severity = text(item.severity, 20).toLowerCase();
        const impact = text(item.impact, 20).toLowerCase();
        const effort = text(item.effort, 20).toLowerCase();
        return {
          title: text(item.title, 200),
          severity: (SEVERITIES.has(severity) ? severity : "medium") as InsightFinding["severity"],
          area: text(item.area, 40) || "general",
          evidence: text(item.evidence, 1500),
          recommendation: text(item.recommendation, 1500),
          impact: (LEVELS.has(impact) ? impact : "medium") as InsightFinding["impact"],
          effort: (LEVELS.has(effort) ? effort : "medium") as InsightFinding["effort"],
        };
      })
      .filter((f) => f.title)
      .slice(0, 12),
    checklist: (Array.isArray(parsed.checklist) ? parsed.checklist : [])
      .map((t) => {
        const item = (t ?? {}) as Record<string, unknown>;
        const priority = text(item.priority, 20).toLowerCase();
        const impact = text(item.impact, 20).toLowerCase();
        const effort = text(item.effort, 20).toLowerCase();
        return {
          title: text(item.title, 200),
          detail: text(item.detail, 1500),
          area: text(item.area, 40) || "general",
          priority: (SEVERITIES.has(priority)
            ? priority
            : "medium") as InsightTask["priority"],
          impact: (LEVELS.has(impact) ? impact : "medium") as InsightTask["impact"],
          effort: (LEVELS.has(effort) ? effort : "medium") as InsightTask["effort"],
          metric: text(item.metric, 300),
          target: text(item.target, 300),
        };
      })
      .filter((t) => t.title)
      .slice(0, 20),
    quick_wins: stringList(parsed.quick_wins, 8),
    what_is_working: stringList(parsed.what_is_working, 8),
    watch_list: stringList(parsed.watch_list, 8),
  };
}


/**
 * A stable identity for the same underlying problem across scans.
 *
 * The model will not word a recurring finding identically twice, so matching
 * on the title alone would add a near-duplicate row every scan and the
 * checklist would become a pile. Area plus the significant words of the title
 * is coarse enough to survive a rephrase and specific enough not to collapse
 * two genuinely different tasks in the same area.
 */
function fingerprintTask(task: InsightTask): string {
  const stop = new Set([
    "the", "a", "an", "and", "or", "to", "of", "on", "in", "for", "from",
    "with", "at", "by", "is", "are", "be", "into", "your", "our", "this",
    "that", "add", "make", "improve",
  ]);
  const words = task.title
    .toLowerCase()
    .replace(/[^a-z0-9\s/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .sort()
    .slice(0, 6)
    .join("-");
  return `${task.area}:${words}`.slice(0, 200);
}

/**
 * Write the checklist, preserving everything already done.
 *
 * A re-scan must never resurrect a ticked item or reset progress, so this
 * upserts on the fingerprint and touches only the fields that describe the
 * problem — never `done`, `done_at`, `done_by` or `dismissed`. An item the
 * new scan no longer raises is left alone too: it stopped being top-ten, not
 * necessarily fixed, and silently deleting someone's to-do list is worse than
 * a slightly long one.
 */
async function saveChecklist(
  supabase: DB,
  insightId: string,
  tasks: InsightTask[],
): Promise<void> {
  if (!tasks.length) return;

  const rows = tasks.map((task, index) => ({
    site: SITE,
    insight_id: insightId,
    fingerprint: fingerprintTask(task),
    title: task.title,
    detail: task.detail,
    area: task.area,
    priority: task.priority,
    impact: task.impact,
    effort: task.effort,
    metric: task.metric || null,
    target: task.target || null,
    sort_order: index,
    last_seen_at: new Date().toISOString(),
  }));

  // Deduplicate within this batch — two items that fingerprint the same
  // would make the upsert fail on "affect row a second time".
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (seen.has(r.fingerprint)) return false;
    seen.add(r.fingerprint);
    return true;
  });

  const { data: existing } = await supabase
    .from("web_insight_tasks")
    .select("fingerprint, seen_count")
    .eq("site", SITE)
    .in("fingerprint", unique.map((r) => r.fingerprint));
  const counts = new Map(
    (existing ?? []).map((r) => [r.fingerprint, r.seen_count ?? 1]),
  );

  await supabase.from("web_insight_tasks").upsert(
    unique.map((r) => ({
      ...r,
      // A rising count is the signal that something keeps being raised and
      // keeps not being done.
      seen_count: (counts.get(r.fingerprint) ?? 0) + 1,
    })),
    { onConflict: "site,fingerprint" },
  );
}

/**
 * Run one scan and store it.
 *
 * Falls back from the reasoning model to the ordinary chat model on failure —
 * an install whose key has no `gpt-5` access should still get an answer, just
 * a shallower one, rather than a button that never works. The model actually
 * used is recorded on the row so a thin-looking scan can be explained.
 */
export async function runInsightScan(
  supabase: DB,
  opts: { days?: number; createdBy?: string | null } = {},
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isOpenAIConfigured()) {
    return {
      ok: false,
      error: "OPENAI_API_KEY is not set — the scan needs a model to reason with.",
    };
  }

  const days = opts.days ?? 30;
  const startedAt = Date.now();
  const range = rangeForDays(days);

  let evidence: InsightEvidence;
  try {
    evidence = await collectInsightEvidence(supabase, days);
  } catch (e) {
    return {
      ok: false,
      error: `Could not read the analytics: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!evidence.totals.sessions && !evidence.totals.pageviews) {
    return {
      ok: false,
      error:
        "There is no traffic recorded for this window yet, so there is nothing to analyse. " +
        "Run a sync first, or widen the window.",
    };
  }

  // Trim from the tail-heavy sections first if the export is unusually
  // large. These are the long lists of near-identical rows — the hundredth
  // page and the twentieth journey add length without adding a conclusion,
  // whereas the totals, deltas and funnel are what every finding rests on
  // and are never dropped.
  let trimmed: InsightEvidence = evidence;
  let payload = JSON.stringify(trimmed);
  if (payload.length > MAX_EVIDENCE_CHARS) {
    trimmed = {
      ...evidence,
      topPages: evidence.topPages.slice(0, 15),
      topPaths: evidence.topPaths.slice(0, 10),
      dropOffs: evidence.dropOffs.slice(0, 10),
      friction_pages: evidence.friction_pages.slice(0, 10),
      countries: evidence.countries.slice(0, 8),
      recent_errors: evidence.recent_errors.slice(0, 5),
      daily_series: evidence.daily_series.slice(-60),
    };
    payload = JSON.stringify(trimmed);
  }
  const attempts: { model: string; effort?: string }[] = [
    { model: INSIGHTS_MODEL, effort: INSIGHTS_EFFORT },
    { model: AI_MODELS.chat },
  ];

  let result: InsightResult | null = null;
  let usedModel = "";
  let lastError = "";

  for (const attempt of attempts) {
    try {
      const raw = await openaiChatJSON(
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Window: ${range.from} to ${range.to} (${days} days).\n` +
              `Site: ${evidence.site}\n\nAnalytics export:\n${payload}`,
          },
        ],
        {
          model: attempt.model,
          reasoningEffort: attempt.effort,
          timeoutMs: TIMEOUT_MS,
        },
      );
      result = parseInsight(raw);
      if (result) {
        usedModel = attempt.model;
        break;
      }
      lastError = `${attempt.model} returned something that was not a usable insight.`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  const durationMs = Date.now() - startedAt;

  if (!result) {
    // Stored, not just returned: the panel needs to be able to say what went
    // wrong rather than silently showing the previous scan as if it were new.
    const { data } = await supabase
      .from("web_insights")
      .insert({
        site: SITE,
        period_start: range.from,
        period_end: range.to,
        range_days: days,
        headline: "The scan could not be completed.",
        status: "failed",
        error: lastError.slice(0, 1000),
        model: INSIGHTS_MODEL,
        duration_ms: durationMs,
        created_by: opts.createdBy ?? null,
      })
      .select("id")
      .maybeSingle();
    void data;
    return { ok: false, error: lastError || "The model did not return a usable insight." };
  }

  const { data, error } = await supabase
    .from("web_insights")
    .insert({
      site: SITE,
      period_start: range.from,
      period_end: range.to,
      range_days: days,
      health_score: result.health_score,
      headline: result.headline,
      summary: result.summary,
      findings: result.findings,
      quick_wins: result.quick_wins,
      what_is_working: result.what_is_working,
      watch_list: result.watch_list,
      metrics: evidence as unknown as Record<string, unknown>,
      model: usedModel,
      status: "complete",
      duration_ms: durationMs,
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  // The checklist is the deliverable, but a failure to write it must not
  // throw away the analysis that has already been paid for and stored.
  try {
    await saveChecklist(supabase, data.id, result.checklist);
  } catch (e) {
    console.error("[insights] checklist write failed:", e);
  }

  return { ok: true, id: data.id };
}
