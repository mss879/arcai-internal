import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { SITE } from "./source";

type DB = SupabaseClient<Database>;

/**
 * Turning the raw mirror into the numbers the dashboard reads.
 *
 * The dashboard asks the same handful of questions every time it loads —
 * how many visits yesterday, from where, on what, which pages, did any
 * of it convert. Answering those from raw events on every page load
 * means scanning tens of thousands of rows to render a header. So the
 * scan happens once, on the days the sync actually touched, and the
 * dashboard reads pre-computed rows.
 *
 * Days are UTC. Not because UTC is the right timezone for a business in
 * Birmingham and Colombo — it is nobody's timezone — but because the
 * source stamps in UTC, and a rollup that silently shifted the boundary
 * would make "yesterday" here disagree with "yesterday" in the raw data
 * it was built from. One clock, consistently wrong by a few hours at the
 * edges, beats two clocks that disagree.
 */

/** Separator for composite map keys. A URL path can never contain it. */
const SEP = " → ";

const dayBounds = (day: string) => ({
  start: `${day}T00:00:00.000Z`,
  end: `${day}T23:59:59.999Z`,
});

/** Count occurrences into a plain object, ready for jsonb. */
function tally(values: (string | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = (v ?? "").trim() || "(none)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** The n biggest entries of a tally, as a sorted array. */
function topN(
  counts: Record<string, number>,
  n: number,
): { key: string; count: number }[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

const avg = (nums: number[]): number =>
  nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)) : 0;

const pct = (part: number, whole: number): number =>
  whole ? Number(((part / whole) * 100).toFixed(2)) : 0;

type SessionRow = Database["public"]["Tables"]["web_sessions"]["Row"];
type EventRow = Database["public"]["Tables"]["web_events"]["Row"];

/** Page through a table until it is exhausted — Supabase caps a select at 1000. */
async function fetchAll<T>(
  // PromiseLike, not Promise: a Supabase query builder is thenable but is not
  // an actual Promise, so requiring one here rejects every real call site.
  run: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  cap = 50_000,
): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; from < cap; from += size) {
    const { data, error } = await run(from, from + size - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

// -- one day ----------------------------------------------------------------

/**
 * Recompute `web_daily` and `web_page_daily` for a single day.
 *
 * Bots are excluded from every figure. A crawler that reads forty pages
 * is not forty pages of interest, and leaving it in makes traffic look
 * healthy while conversion rate quietly collapses.
 */
export async function rollupDay(supabase: DB, day: string): Promise<void> {
  const { start, end } = dayBounds(day);

  const sessions = await fetchAll<SessionRow>((from, to) =>
    supabase
      .from("web_sessions")
      .select("*")
      .eq("site", SITE)
      .gte("first_seen_at", start)
      .lte("first_seen_at", end)
      .eq("is_bot", false)
      .range(from, to),
  );

  const events = await fetchAll<EventRow>((from, to) =>
    supabase
      .from("web_events")
      .select("*")
      .eq("site", SITE)
      .gte("occurred_at", start)
      .lte("occurred_at", end)
      .range(from, to),
  );

  const pageViews = events.filter((e) => e.kind === "page_view");
  const visitors = new Set(sessions.map((s) => s.visitor_id));

  // "New" means the visitor's first-ever session is this one. Cheap to
  // check because the mirror holds every session they ever had.
  const firstSeenByVisitor = new Map<string, string>();
  const visitorList = [...visitors];
  // Chunked, because `.in()` on a few thousand ids builds a URL long enough
  // for PostgREST to reject — and a truncated list would silently mark every
  // visitor past the cut-off as returning on the site's busiest days.
  for (let i = 0; i < visitorList.length; i += 500) {
    const chunk = visitorList.slice(i, i + 500);
    const priors = await fetchAll<{ visitor_id: string; first_seen_at: string }>(
      (from, to) =>
        supabase
          .from("web_sessions")
          .select("visitor_id, first_seen_at")
          .in("visitor_id", chunk)
          .order("first_seen_at", { ascending: true })
          .range(from, to),
    );
    for (const prior of priors) {
      const seen = firstSeenByVisitor.get(prior.visitor_id);
      if (!seen || prior.first_seen_at < seen) {
        firstSeenByVisitor.set(prior.visitor_id, prior.first_seen_at);
      }
    }
  }
  let newVisitors = 0;
  for (const v of visitors) {
    const first = firstSeenByVisitor.get(v);
    if (first && first >= start && first <= end) newVisitors++;
  }

  const bounces = sessions.filter((s) => s.is_bounce).length;
  const conversions = sessions.filter((s) => s.converted).length;

  const vitals: Record<string, number[]> = {};
  for (const e of events) {
    if (e.kind !== "web_vital" || !e.element_text) continue;
    (vitals[e.element_text] ??= []).push(Number(e.value ?? 0));
  }
  const webVitals: Record<string, { avg: number; samples: number }> = {};
  for (const [name, values] of Object.entries(vitals)) {
    webVitals[name] = { avg: avg(values), samples: values.length };
  }

  const pageCounts = tally(pageViews.map((e) => e.path));
  const referrerCounts = tally(
    sessions.filter((s) => s.referrer_domain).map((s) => s.referrer_domain),
  );

  await supabase.from("web_daily").upsert(
    {
      site: SITE,
      day,
      sessions: sessions.length,
      visitors: visitors.size,
      new_visitors: newVisitors,
      returning_visitors: Math.max(0, visitors.size - newVisitors),
      pageviews: pageViews.length,
      bounces,
      bounce_rate: pct(bounces, sessions.length),
      avg_duration_seconds: avg(sessions.map((s) => s.duration_seconds)),
      avg_engaged_seconds: avg(sessions.map((s) => s.engaged_seconds)),
      avg_pages_per_session: avg(sessions.map((s) => s.page_count)),
      avg_scroll_pct: avg(sessions.map((s) => s.max_scroll_pct)),
      conversions,
      conversion_rate: pct(conversions, sessions.length),
      forms_started: sessions.reduce((n, s) => n + s.forms_started, 0),
      forms_abandoned: sessions.reduce((n, s) => n + s.forms_abandoned, 0),
      chat_sessions: sessions.filter((s) => s.chat_engaged).length,
      chat_messages: sessions.reduce((n, s) => n + s.chat_message_count, 0),
      rage_clicks: sessions.reduce((n, s) => n + s.rage_clicks, 0),
      outbound_clicks: sessions.reduce((n, s) => n + s.outbound_clicks, 0),
      errors: events.filter((e) => e.kind === "error").length,
      by_channel: tally(sessions.map((s) => s.channel)),
      by_device: tally(sessions.map((s) => s.device_type)),
      by_country: tally(sessions.map((s) => s.country ?? s.country_code)),
      by_browser: tally(sessions.map((s) => s.browser)),
      by_source: tally(sessions.map((s) => s.utm_source ?? s.referrer_domain)),
      by_campaign: tally(
        sessions.filter((s) => s.utm_campaign).map((s) => s.utm_campaign),
      ),
      top_pages: topN(pageCounts, 25),
      top_entry_pages: topN(tally(sessions.map((s) => s.entry_path)), 15),
      top_exit_pages: topN(tally(sessions.map((s) => s.exit_path)), 15),
      top_referrers: topN(referrerCounts, 15),
      web_vitals: webVitals,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "site,day" },
  );

  // ---- per page ----
  // Grouped once rather than filtered per path: the naive version is
  // O(paths x events), which on a busy day is tens of millions of
  // comparisons inside a function that has a time budget.
  const viewsByPath = new Map<string, EventRow[]>();
  for (const e of pageViews) {
    const list = viewsByPath.get(e.path);
    if (list) list.push(e);
    else viewsByPath.set(e.path, [e]);
  }
  const eventsByPath = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = eventsByPath.get(e.path);
    if (list) list.push(e);
    else eventsByPath.set(e.path, [e]);
  }
  const entriesByPath = new Map<string, number>();
  const exitsByPath = new Map<string, number>();
  const bouncesByPath = new Map<string, number>();
  for (const s2 of sessions) {
    entriesByPath.set(s2.entry_path, (entriesByPath.get(s2.entry_path) ?? 0) + 1);
    if (s2.exit_path) {
      exitsByPath.set(s2.exit_path, (exitsByPath.get(s2.exit_path) ?? 0) + 1);
    }
    // Only a session that LANDED here can have bounced here — a bounce is a
    // one-page visit, so attributing it elsewhere would blame a page the
    // visitor never saw.
    if (s2.is_bounce) {
      bouncesByPath.set(s2.entry_path, (bouncesByPath.get(s2.entry_path) ?? 0) + 1);
    }
  }

  const rows: Database["public"]["Tables"]["web_page_daily"]["Insert"][] = [];

  for (const [path, views] of viewsByPath) {
    const onPage = eventsByPath.get(path) ?? [];
    const exits = onPage.filter((e) => e.kind === "page_exit");

    rows.push({
      site: SITE,
      day,
      path,
      page_title: views.find((v) => v.page_title)?.page_title ?? null,
      pageviews: views.length,
      unique_visitors: new Set(views.map((v) => v.visitor_id)).size,
      entries: entriesByPath.get(path) ?? 0,
      exits: exitsByPath.get(path) ?? 0,
      bounces: bouncesByPath.get(path) ?? 0,
      avg_seconds_on_page: avg(exits.map((e) => Number(e.value ?? 0))),
      avg_scroll_pct: avg(
        onPage.filter((e) => e.kind === "scroll_depth").map((e) => Number(e.value ?? 0)),
      ),
      conversions: onPage.filter((e) => e.kind === "conversion").length,
      form_starts: onPage.filter((e) => e.kind === "form_start").length,
      form_abandons: onPage.filter((e) => e.kind === "form_abandon").length,
      rage_clicks: onPage.filter((e) => e.kind === "rage_click").length,
      cta_clicks: onPage.filter((e) => e.kind === "cta_click").length,
      computed_at: new Date().toISOString(),
    });
  }

  if (rows.length) {
    await supabase.from("web_page_daily").upsert(rows, { onConflict: "site,day,path" });
  }
}

// -- journeys ---------------------------------------------------------------

/**
 * Where people go, in order.
 *
 * Two shapes fall out of the same scan. The transition list ("from /,
 * 41 went to /services and 12 left") is the one that shows leaks. The
 * whole-path list ("/ then /services then /contact — 9 sessions, 4
 * converted") is the one that shows what a good visit actually looks
 * like, and the direct answer to "they land on the home page, then
 * where do they go".
 *
 * Paths are capped at 8 steps. Beyond that nearly every route is unique,
 * and a table of one-session routes tells you nothing.
 */
export async function rollupJourneys(
  supabase: DB,
  periodStart: string,
  periodEnd: string,
): Promise<void> {
  const views = await fetchAll<Pick<EventRow, "session_id" | "path" | "seq">>(
    (from, to) =>
      supabase
        .from("web_events")
        .select("session_id, path, seq")
        .eq("site", SITE)
        .eq("kind", "page_view")
        .gte("occurred_at", `${periodStart}T00:00:00.000Z`)
        .lte("occurred_at", `${periodEnd}T23:59:59.999Z`)
        .order("session_id", { ascending: true })
        .order("seq", { ascending: true })
        // Tertiary sort so rows that share a seq still have one defined
        // order. Without it a "journey" is whatever order Postgres returned.
        .order("occurred_at", { ascending: true })
        .range(from, to),
  );

  const bySession = new Map<string, string[]>();
  for (const v of views) {
    const list = bySession.get(v.session_id) ?? [];
    // Collapse a refresh or a re-render of the same page: "/ then /" is
    // not a journey step, and left in it dominates every transition count.
    if (list[list.length - 1] !== v.path) list.push(v.path);
    bySession.set(v.session_id, list);
  }

  const converted = new Set<string>();
  const convertedRows = await fetchAll<{ session_id: string }>((from, to) =>
    supabase
      .from("web_sessions")
      .select("session_id")
      .eq("site", SITE)
      .eq("converted", true)
      .gte("first_seen_at", `${periodStart}T00:00:00.000Z`)
      .lte("first_seen_at", `${periodEnd}T23:59:59.999Z`)
      .range(from, to),
  );
  for (const r of convertedRows) converted.add(r.session_id);

  type Agg = { sessions: number; conversions: number; drop_offs: number };
  const transitions = new Map<string, Agg>();
  const fullPaths = new Map<string, Agg>();

  for (const [sessionId, path] of bySession) {
    const didConvert = converted.has(sessionId);

    for (let idx = 0; idx < path.length; idx++) {
      const from = path[idx];
      const to = path[idx + 1] ?? null;
      const key = `${from}${SEP}${to ?? ""}`;
      const agg = transitions.get(key) ?? { sessions: 0, conversions: 0, drop_offs: 0 };
      agg.sessions++;
      if (didConvert) agg.conversions++;
      // No next page means the visit ended here. That is the number
      // worth acting on: where the journey stops.
      if (!to) agg.drop_offs++;
      transitions.set(key, agg);
    }

    const sequence = path.slice(0, 8).join(SEP);
    const agg = fullPaths.get(sequence) ?? { sessions: 0, conversions: 0, drop_offs: 0 };
    agg.sessions++;
    if (didConvert) agg.conversions++;
    fullPaths.set(sequence, agg);
  }

  await supabase
    .from("web_journeys")
    .delete()
    .eq("site", SITE)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd);

  const rows: Database["public"]["Tables"]["web_journeys"]["Insert"][] = [];
  const now = new Date().toISOString();

  const topTransitions = [...transitions]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, 400);
  for (const [key, agg] of topTransitions) {
    const [from, to] = key.split(SEP);
    rows.push({
      site: SITE,
      period_start: periodStart,
      period_end: periodEnd,
      kind: "transition",
      from_path: from,
      to_path: to || null,
      sessions: agg.sessions,
      conversions: agg.conversions,
      drop_offs: agg.drop_offs,
      computed_at: now,
    });
  }

  const topPaths = [...fullPaths]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, 200);
  for (const [sequence, agg] of topPaths) {
    rows.push({
      site: SITE,
      period_start: periodStart,
      period_end: periodEnd,
      kind: "path",
      path_sequence: sequence,
      step_index: sequence.split(SEP).length,
      sessions: agg.sessions,
      conversions: agg.conversions,
      drop_offs: agg.drop_offs,
      computed_at: now,
    });
  }

  if (rows.length) await supabase.from("web_journeys").insert(rows);
}

/**
 * Recompute everything the sync disturbed.
 *
 * Capped at 60 days so a first run that pulls two years of history does
 * not try to roll all of it up inside one function invocation. The rest
 * catches up on subsequent ticks, newest days first — which is the order
 * that matters, because nobody is staring at last March.
 */
export async function rollupTouchedDays(supabase: DB, days: string[]): Promise<number> {
  const ordered = [...new Set(days)].sort().reverse().slice(0, 60);
  for (const day of ordered) {
    await rollupDay(supabase, day);
  }

  const end = new Date();
  const start = new Date(end.getTime() - 29 * 86_400_000);
  await rollupJourneys(
    supabase,
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  );

  return ordered.length;
}
