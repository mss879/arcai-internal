import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { createInboundLead } from "@/lib/lead-intake";

import { chatCursorAfter, dedupeById, nudgeCursor } from "./job-core";
import { SITE, createWebsiteClient, isWebsiteSourceConfigured } from "./source";

type DB = SupabaseClient<Database>;

/**
 * The pull.
 *
 * Every stream is incremental, idempotent, and — the part that was missing
 * — BOUNDED. Incremental because a job that re-reads a year of events
 * would time out long before it finished; idempotent because a serverless
 * run that dies halfway WILL be retried, and the retry must not double
 * every number on the dashboard; bounded because the platform kills a
 * function at roughly 26 seconds, and a stream that needs longer than that
 * has to be able to stop, record where it got to, and carry on next time.
 *
 * Those three together dictate the shape of each stream:
 *
 *   • A watermark in `web_sync_state` says where the last page got to. It
 *     is written after EVERY page, not at the end of the stream, so a
 *     killed step loses one page of progress at most. Timestamp watermarks
 *     are read with `>=` rather than `>`, because two rows can share a
 *     millisecond and `>` would silently skip the second one forever.
 *
 *   • Every write is an upsert on a natural key from the source, so
 *     re-reading those rows changes nothing. `analytics_sessions` in
 *     particular MUST be re-read: a visit that was three pages deep when
 *     it was first pulled may be nine pages and a conversion by the time
 *     the visitor leaves, and only the source's `updated_at` moving brings
 *     the finished version across.
 *
 *   • Every stream takes a deadline and stops STARTING pages once it has
 *     passed. It reports whether it ran out of rows (`exhausted`) or out
 *     of time, and the job in `run.ts` calls it again on the next step
 *     until every stream reports exhausted.
 */

const PAGE = 1000;
/** A sanity cap on pages per step; the deadline is the real bound. */
const MAX_PAGES_PER_STEP = 30;
/** Chat messages are scanned in smaller pages: each page can fan out into
 *  dozens of conversation rebuilds, and a rebuild is three round trips. */
const CHAT_PAGE = 500;
/** Conversations rebuilt per step, at ~1s each. */
const MAX_CONVERSATIONS_PER_STEP = 12;
const CHAT_LOG_PAGE = 25;

export type StreamName =
  | "sessions"
  | "events"
  | "page_visits"
  | "chat_messages"
  | "chat_logs";

export type StreamResult = {
  stream: StreamName;
  rows: number;
  ok: boolean;
  /** True when the stream ran out of rows, false when it ran out of time. */
  exhausted: boolean;
  error?: string;
  durationMs: number;
};

export type SyncStepResult = {
  streams: StreamResult[];
  totalRows: number;
  /** Every stream that ran is up to date — the sync phase can end. */
  exhausted: boolean;
};

type StreamOutcome = { rows: number; exhausted: boolean };

// ── watermarks ──────────────────────────────────────────────────────────────

type Cursor = { cursor_ts: string | null; cursor_id: number | null; rows_synced: number };

async function readCursor(supabase: DB, stream: StreamName): Promise<Cursor> {
  const { data } = await supabase
    .from("web_sync_state")
    .select("cursor_ts, cursor_id, rows_synced")
    .eq("stream", stream)
    .maybeSingle();
  return {
    cursor_ts: data?.cursor_ts ?? null,
    cursor_id: data?.cursor_id ?? null,
    rows_synced: Number(data?.rows_synced ?? 0),
  };
}

/**
 * One round trip per write. The running total comes in from the caller,
 * which read it once with the cursor, rather than being re-read here —
 * this is called after every page now, and a read-then-write per page
 * would double the time the stream spends on bookkeeping.
 */
async function writeCursor(
  supabase: DB,
  stream: StreamName,
  patch: Partial<Pick<Cursor, "cursor_ts" | "cursor_id">> & {
    rowsTotal: number;
    error?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("web_sync_state").upsert(
    {
      stream,
      ...(patch.cursor_ts !== undefined ? { cursor_ts: patch.cursor_ts } : {}),
      ...(patch.cursor_id !== undefined ? { cursor_id: patch.cursor_id } : {}),
      last_run_at: now,
      last_ok_at: patch.error ? undefined : now,
      rows_synced: patch.rowsTotal,
      last_error: patch.error ?? null,
      updated_at: now,
    },
    { onConflict: "stream" },
  );
}

/** How far back a stream with no watermark starts. */
function initialSince(days = 400): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Every stream that reads from the website and can be re-read from scratch. */
export const REPLAYABLE_STREAMS: StreamName[] = [
  "sessions",
  "events",
  "page_visits",
  "chat_messages",
  "chat_logs",
];

/**
 * Wind the watermarks back to the beginning.
 *
 * The pull is incremental by design, and that design has one sharp edge:
 * a row mirrored by a mapper that was later corrected is never looked at
 * again, because the cursor has already moved past it. Every fix to the
 * mapping — channel classification, session length, the legacy cutover —
 * is therefore invisible on the data that provoked the fix. This is the
 * escape hatch: clear the cursors, and the next pull re-reads the source
 * and rewrites every mirrored row through the current logic.
 *
 * Safe to run at any time. Each write is still an upsert on a natural
 * key, so a replay overwrites rather than duplicates.
 */
export async function resetSyncCursors(
  crm: DB,
  streams: StreamName[] = REPLAYABLE_STREAMS,
): Promise<void> {
  const now = new Date().toISOString();
  await crm.from("web_sync_state").upsert(
    streams.map((stream) => ({
      stream,
      cursor_ts: null,
      cursor_id: null,
      last_run_at: now,
      last_error: null,
      updated_at: now,
    })),
    { onConflict: "stream" },
  );
}

/**
 * Throw away the synthesised legacy sessions so they can be rebuilt.
 *
 * `web_events` is deliberately left alone: its natural key is the immutable
 * `page_visits` row id, so a re-mirror overwrites every one of those rows in
 * place, and deleting them would open a window where the dashboard reads zero
 * page views. `web_sessions` is the opposite case — the key
 * `legacy:<visitor>:<date>` is DERIVED from the grouping logic, so any change
 * to that logic orphans the old ids rather than replacing them, and an orphan
 * is indistinguishable from a real quiet visit forever after.
 */
export async function purgeLegacyMirror(crm: DB): Promise<void> {
  await crm.from("web_sessions").delete().eq("site", SITE).like("session_id", "legacy:%");
}

/** True when PostgREST is telling us the table simply is not there. */
function isMissingTable(message: string): boolean {
  return /does not exist|schema cache|PGRST205/i.test(message);
}

/**
 * The message the Setup tab shows when the site's analytics tables have not
 * been created yet. A raw "could not find the table in the schema cache" is
 * accurate and tells the reader nothing about what to do about it.
 */
const MIGRATION_HINT =
  "The website's analytics tables do not exist yet. Run " +
  "supabase_web_analytics_migration.sql in the WEBSITE project's SQL editor, " +
  "then sync again.";

const day = (iso: string | null | undefined): string | null =>
  iso ? iso.slice(0, 10) : null;

const s = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const str = String(v).trim();
  return str ? str.slice(0, max) : null;
};

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const i = (v: unknown): number => Math.round(n(v) ?? 0);

const timeLeft = (deadline: number): boolean => Date.now() < deadline;

const SEARCH_ENGINES =
  /(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|brave|qwant|startpage|naver|seznam)\./i;
const SOCIAL =
  /(facebook|instagram|linkedin|twitter|x\.com|t\.co|tiktok|pinterest|reddit|youtube|threads|snapchat|whatsapp|telegram|quora|medium)\./i;
const AI_ASSISTANTS =
  /(chatgpt|chat\.openai|perplexity|claude\.ai|gemini\.google|copilot\.microsoft|bard\.google|you\.com|phind)\./i;
const EMAIL_CLIENTS = /(mail\.google|outlook|mail\.yahoo|superhuman|hey\.com)\./i;

/**
 * The host a legacy referrer came from.
 *
 * `new URL()` covers the ordinary cases and the `android-app://` scheme the
 * Google app on Android sends. What it does NOT cover is a referrer stored
 * without a scheme at all — `com.google.android.googlequicksearchbox`,
 * `www.google.com` — which the old log has plenty of, because it recorded
 * `document.referrer` verbatim from whatever the browser handed it. Those
 * throw, and a thrown referrer used to become a null domain and a "direct"
 * visit: search traffic quietly reclassified as nobody-knows.
 */
function legacyReferrerHost(referrer: string | null): string | null {
  if (!referrer) return null;
  const raw = referrer.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname;
    if (host) return host.toLowerCase();
  } catch {
    /* no scheme — fall through and read it as a bare host */
  }
  // A bare host, possibly with a path: take everything up to the first slash.
  const bare = raw.replace(/^\/+/, "").split(/[/?#]/)[0]?.toLowerCase() ?? "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare) || /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/.test(bare)
    ? bare
    : null;
}

/**
 * Channel for a legacy row, from its referrer alone.
 *
 * The old `page_visits` log kept a referrer and nothing else, so this is the
 * same classification the live tracker does minus the UTM and click-id legs.
 * Without it every referred visit was filed as "referral" — which is how 174
 * Google visits ended up not counted as organic search.
 */
function classifyLegacyChannel(referrer: string | null, host: string | null): string {
  if (!referrer || !host) return "direct";
  if (host === "arcai.agency" || host.endsWith(".arcai.agency")) return "internal";
  if (AI_ASSISTANTS.test(`${host}.`)) return "ai_assistant";
  if (SEARCH_ENGINES.test(`${host}.`)) return "organic";
  if (SOCIAL.test(`${host}.`)) return "social";
  if (EMAIL_CLIENTS.test(`${host}.`)) return "email";
  return "referral";
}

/**
 * A legacy visit that no human plausibly made.
 *
 * The old log was written by a server route with no user-agent check of any
 * kind, so every crawler that ever hit the site is in there indistinguishable
 * from a customer. There is no UA to test after the fact, which leaves shape:
 * a crawler walks many distinct URLs in seconds and never comes back to one.
 * Deliberately conservative — the cost of a false positive is deleting real
 * traffic from every number, and the cost of a false negative is one more
 * bounce in an archive already labelled as an estimate.
 */
function looksAutomated(paths: string[], timestamps: string[]): boolean {
  if (paths.length < 8) return false;
  const distinct = new Set(paths).size;
  // A person re-reads pages; a crawler almost never does.
  if (distinct < paths.length * 0.9) return false;
  const first = new Date(timestamps[0]).getTime();
  const last = new Date(timestamps[timestamps.length - 1]).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  const seconds = (last - first) / 1000;
  // Eight or more distinct pages at better than two seconds a page.
  return seconds >= 0 && seconds < paths.length * 2;
}

/**
 * A believable length for a day of legacy page views.
 *
 * The old log has no session boundary, so a visitor who read something at
 * 09:00 and came back at 17:00 looks like one eight-hour visit. Summing the
 * gaps and capping each at 30 minutes — the same idle window the live tracker
 * uses — turns that back into two short reads. Without this the site-wide
 * average duration read 443 seconds against an engaged time of 0.08s, which
 * is the kind of contradiction that makes every other number suspect.
 */
function legacyDuration(timestamps: string[]): number {
  const CAP_MS = 30 * 60 * 1000;
  let total = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = new Date(timestamps[i]).getTime() - new Date(timestamps[i - 1]).getTime();
    if (Number.isFinite(gap) && gap > 0) total += Math.min(gap, CAP_MS);
  }
  return Math.round(total / 1000);
}

/**
 * The moment the rich tracker took over, and the hard boundary of the
 * legacy stream.
 *
 * This matters more than it looks. The site's collector writes BOTH tables
 * for every page view — `analytics_events` for the real event stream and
 * `page_visits` so the old /admin dashboard keeps working. Mirroring both
 * streams unconditionally therefore counts every modern page view twice:
 * once as an `analytics_events` row and again as a `page_visits` row, and
 * — far worse — synthesises a `legacy:<visitor>:<date>` session ALONGSIDE
 * the real `s_<uuid>` one for the same visit. That phantom twin carries no
 * device, no country and no engagement, so it drags every breakdown toward
 * "unknown" and every engagement average toward zero while inflating the
 * session count.
 *
 * So: page_visits rows are mirrored only from BEFORE the first real
 * session. After that instant the rich stream is the only truth, and the
 * legacy log is a duplicate of it.
 */
async function trackerCutover(site: SupabaseClient): Promise<string | null> {
  const { data, error } = await site
    .from("analytics_sessions")
    .select("first_seen_at")
    .order("first_seen_at", { ascending: true })
    .limit(1);
  // No tracker table, or no tracked session yet: the legacy log is still
  // the only record there is, so nothing is excluded.
  if (error || !data?.length) return null;
  return s(data[0].first_seen_at, 40);
}

/**
 * Remove legacy rows that the cutover now says should never have existed.
 *
 * Runs once per job rather than only on a rebuild, because the damage is
 * silent: a phantom twin looks exactly like a real quiet visit, and the
 * only way to notice is to reconcile two totals that nobody reconciles.
 * Both deletes are indexed and normally match nothing. Returns the days
 * that lost rows, because a day whose numbers change and never gets rolled
 * up again keeps the wrong total forever.
 */
async function pruneLegacyAfterCutover(crm: DB, cutover: string | null): Promise<string[]> {
  if (!cutover) return [];

  // Which days lose rows — read before the delete, because afterwards
  // there is nothing left to ask. Paged: PostgREST caps a select at 1000
  // rows whatever `limit` asks for.
  const days = new Set<string>();
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data } = await crm
      .from("web_events")
      .select("occurred_at")
      .eq("site", SITE)
      .eq("source", "page_visits")
      .gte("occurred_at", cutover)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    for (const row of data ?? []) {
      const d = day(row.occurred_at);
      if (d) days.add(d);
    }
    if (!data || data.length < PAGE) break;
  }

  await crm
    .from("web_events")
    .delete()
    .eq("site", SITE)
    .eq("source", "page_visits")
    .gte("occurred_at", cutover);
  await crm
    .from("web_sessions")
    .delete()
    .eq("site", SITE)
    .like("session_id", "legacy:%")
    .gte("first_seen_at", cutover);

  return [...days];
}

/**
 * The once-per-job preparation: read where the tracker starts and drop any
 * legacy rows past it. Kept out of the per-step stream loop so a job that
 * needs ten steps does not scan for phantom twins ten times.
 */
export async function prepareSync(
  crm: DB,
): Promise<{ cutover: string | null; prunedDays: string[] }> {
  const site = createWebsiteClient();
  const cutover = await trackerCutover(site).catch(() => null);
  const prunedDays = await pruneLegacyAfterCutover(crm, cutover).catch(() => []);
  return { cutover, prunedDays };
}

// ── sessions ────────────────────────────────────────────────────────────────

async function syncSessions(
  crm: DB,
  site: SupabaseClient,
  deadline: number,
): Promise<StreamOutcome> {
  const cursor = await readCursor(crm, "sessions");
  let since = cursor.cursor_ts ?? initialSince();
  let total = cursor.rows_synced;
  let rows = 0;
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES_PER_STEP && timeLeft(deadline); page++) {
    const { data, error } = await site
      .from("analytics_sessions")
      .select("*")
      .gte("updated_at", since)
      .order("updated_at", { ascending: true })
      .limit(PAGE);
    if (error) {
      throw new Error(isMissingTable(error.message) ? MIGRATION_HINT : error.message);
    }
    if (!data?.length) {
      exhausted = true;
      break;
    }

    const mapped = data.map((r: Record<string, unknown>) => ({
      session_id: s(r.session_id, 120)!,
      visitor_id: s(r.visitor_id, 120) ?? "unknown",
      site: s(r.site, 100) ?? SITE,
      first_seen_at: s(r.first_seen_at, 40) ?? new Date().toISOString(),
      last_seen_at: s(r.last_seen_at, 40) ?? new Date().toISOString(),
      entry_path: s(r.entry_path, 500) ?? "/",
      exit_path: s(r.exit_path, 500),
      page_count: i(r.page_count),
      event_count: i(r.event_count),
      duration_seconds: i(r.duration_seconds),
      engaged_seconds: i(r.engaged_seconds),
      is_bounce: Boolean(r.is_bounce),
      max_scroll_pct: i(r.max_scroll_pct),
      landing_referrer: s(r.landing_referrer, 2000),
      referrer_domain: s(r.referrer_domain, 255),
      channel: s(r.channel, 40) ?? "direct",
      utm_source: s(r.utm_source, 255),
      utm_medium: s(r.utm_medium, 255),
      utm_campaign: s(r.utm_campaign, 255),
      utm_term: s(r.utm_term, 255),
      utm_content: s(r.utm_content, 255),
      gclid: s(r.gclid, 255),
      fbclid: s(r.fbclid, 255),
      msclkid: s(r.msclkid, 255),
      first_touch_channel: s(r.first_touch_channel, 40),
      first_touch_campaign: s(r.first_touch_campaign, 255),
      landing_page_title: s(r.landing_page_title, 300),
      device_type: s(r.device_type, 20) ?? "unknown",
      browser: s(r.browser, 60),
      browser_version: s(r.browser_version, 40),
      os: s(r.os, 60),
      os_version: s(r.os_version, 40),
      screen_w: n(r.screen_w),
      screen_h: n(r.screen_h),
      viewport_w: n(r.viewport_w),
      viewport_h: n(r.viewport_h),
      device_pixel_ratio: n(r.device_pixel_ratio),
      language: s(r.language, 20),
      timezone: s(r.timezone, 80),
      connection_type: s(r.connection_type, 20),
      user_agent: s(r.user_agent, 500),
      country: s(r.country, 100),
      country_code: s(r.country_code, 10),
      region: s(r.region, 100),
      city: s(r.city, 100),
      converted: Boolean(r.converted),
      conversion_kind: s(r.conversion_kind, 60),
      conversion_at: s(r.conversion_at, 40),
      chat_engaged: Boolean(r.chat_engaged),
      chat_message_count: i(r.chat_message_count),
      identified_email: s(r.identified_email, 200)?.toLowerCase() ?? null,
      forms_started: i(r.forms_started),
      forms_abandoned: i(r.forms_abandoned),
      outbound_clicks: i(r.outbound_clicks),
      rage_clicks: i(r.rage_clicks),
      is_bot: Boolean(r.is_bot),
      source_updated_at: s(r.updated_at, 40) ?? new Date().toISOString(),
      synced_at: new Date().toISOString(),
    }));

    const { error: upErr } = await crm
      .from("web_sessions")
      .upsert(mapped, { onConflict: "session_id" });
    if (upErr) throw new Error(`sessions upsert: ${upErr.message}`);

    rows += mapped.length;
    total += mapped.length;
    since = nudgeCursor(mapped[mapped.length - 1].source_updated_at, since, data.length === PAGE);
    await writeCursor(crm, "sessions", { cursor_ts: since, rowsTotal: total });
    if (data.length < PAGE) {
      exhausted = true;
      break;
    }
  }

  if (exhausted) await writeCursor(crm, "sessions", { cursor_ts: since, rowsTotal: total });
  return { rows, exhausted };
}

// ── events ──────────────────────────────────────────────────────────────────

async function syncEvents(
  crm: DB,
  site: SupabaseClient,
  deadline: number,
): Promise<StreamOutcome> {
  const cursor = await readCursor(crm, "events");
  let lastId = cursor.cursor_id ?? 0;
  let total = cursor.rows_synced;
  let rows = 0;
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES_PER_STEP && timeLeft(deadline); page++) {
    const { data, error } = await site
      .from("analytics_events")
      .select("*")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) {
      throw new Error(isMissingTable(error.message) ? MIGRATION_HINT : error.message);
    }
    if (!data?.length) {
      exhausted = true;
      break;
    }

    const mapped = data.map((r: Record<string, unknown>) => ({
      source: "analytics_events",
      source_id: String(r.id),
      session_id: s(r.session_id, 120) ?? "unknown",
      visitor_id: s(r.visitor_id, 120) ?? "unknown",
      site: s(r.site, 100) ?? SITE,
      seq: i(r.seq),
      occurred_at: s(r.occurred_at, 40) ?? new Date().toISOString(),
      kind: s(r.kind, 40) ?? "page_view",
      path: s(r.path, 500) ?? "/",
      page_title: s(r.page_title, 300),
      referrer: s(r.referrer, 2000),
      element: s(r.element, 200),
      element_text: s(r.element_text, 300),
      href: s(r.href, 2000),
      value: n(r.value),
      meta: (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>,
      synced_at: new Date().toISOString(),
    }));

    const { error: upErr } = await crm
      .from("web_events")
      .upsert(mapped, { onConflict: "source,source_id" });
    if (upErr) throw new Error(`events upsert: ${upErr.message}`);

    rows += mapped.length;
    total += mapped.length;
    lastId = Number(data[data.length - 1].id);
    await writeCursor(crm, "events", { cursor_id: lastId, rowsTotal: total });
    if (data.length < PAGE) {
      exhausted = true;
      break;
    }
  }

  if (exhausted) await writeCursor(crm, "events", { cursor_id: lastId, rowsTotal: total });
  return { rows, exhausted };
}

// ── legacy page_visits ──────────────────────────────────────────────────────

/**
 * The site's original thin log, mirrored for its history.
 *
 * These rows pre-date the rich tracker and have no session of their own,
 * so one is synthesised per visitor per day. That is not a real session
 * — it cannot be, the data to build one was never captured — but it does
 * make the archive queryable on the same axes as everything after it,
 * which is better than a hole in the timeline before the cutover.
 */
async function syncPageVisits(
  crm: DB,
  site: SupabaseClient,
  deadline: number,
  cutover: string | null,
): Promise<StreamOutcome> {
  const cursor = await readCursor(crm, "page_visits");
  let since = cursor.cursor_ts ?? initialSince(730);
  let total = cursor.rows_synced;

  // Anything the rich tracker also recorded is not history, it is a
  // duplicate. Stop the legacy stream dead at the cutover.
  if (cutover && since >= cutover) {
    await writeCursor(crm, "page_visits", { cursor_ts: since, rowsTotal: total });
    return { rows: 0, exhausted: true };
  }

  // Read the whole step's worth of rows FIRST, then group.
  //
  // Grouping inside the pagination loop looks equivalent and is not: a
  // visitor-day whose rows straddle a 1000-row boundary produces the same
  // `legacy:<visitor>:<date>` key on two consecutive pages, and the second
  // upsert replaces the first wholesale. The surviving row then describes
  // only the tail of that visit — too few pages, the wrong entry path, a
  // duration that stops early, and a bounce flag that may have flipped.
  // Assembling every page of the step before writing anything removes the
  // boundary entirely.
  const raw: Record<string, unknown>[] = [];
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES_PER_STEP && timeLeft(deadline); page++) {
    let query = site
      .from("page_visits")
      .select("id, visitor_id, page_path, referrer, created_at")
      .gte("created_at", since);
    if (cutover) query = query.lt("created_at", cutover);
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .limit(PAGE);
    if (error) {
      // The table may not exist on a fresh project — that is not a failure.
      if (isMissingTable(error.message)) return { rows: 0, exhausted: true };
      throw new Error(`page_visits: ${error.message}`);
    }
    if (!data?.length) {
      exhausted = true;
      break;
    }

    raw.push(...(data as Record<string, unknown>[]));

    const last = s(data[data.length - 1].created_at, 40)!;
    since = nudgeCursor(last, since, data.length === PAGE);
    if (data.length < PAGE) {
      exhausted = true;
      break;
    }
  }

  // The `>=` cursor re-reads the last row of each page at the top of the
  // next. Assembled into ONE batch, that duplicate makes Postgres refuse the
  // whole upsert — "ON CONFLICT DO UPDATE command cannot affect row a second
  // time" — and refusing it meant the cursor never moved, so every run
  // re-read the same seven thousand rows and failed the same way.
  const collected = dedupeById(raw);

  if (!collected.length) {
    await writeCursor(crm, "page_visits", { cursor_ts: since, rowsTotal: total });
    return { rows: 0, exhausted };
  }

  // If the step stopped on the page cap or the deadline rather than on the
  // end of the table, the newest UTC day it reached is almost certainly
  // half-read. Holding it back — and winding the cursor to the start of that
  // day — means the next step assembles it whole rather than writing a
  // truncated session now and a replacement later.
  let batch = collected;
  if (!exhausted) {
    const lastDay = String(collected[collected.length - 1].created_at ?? "").slice(0, 10);
    const complete = collected.filter(
      (r) => String(r.created_at ?? "").slice(0, 10) < lastDay,
    );
    // Unless a single day is bigger than the whole step, in which case there
    // is no way to assemble it whole and taking it as-is beats stalling.
    if (complete.length) {
      batch = complete;
      since = `${lastDay}T00:00:00.000Z`;
    }
  }

  // Group by visitor and day: that grouping IS the synthetic session, and it
  // also gives each row a stable `seq` so the journey rollup can put a legacy
  // day back in order. Without a seq these rows all sort equally and any
  // "journey" read out of them is whatever order Postgres returned.
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of batch) {
    const created = s(r.created_at, 40) ?? new Date().toISOString();
    const visitor = s(r.visitor_id, 120) ?? "unknown";
    const key = `legacy:${visitor}:${created.slice(0, 10)}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const mapped: Database["public"]["Tables"]["web_events"]["Insert"][] = [];
  const synthetic: Database["public"]["Tables"]["web_sessions"]["Insert"][] = [];

  for (const [sessionId, group] of groups) {
    group.sort((a, b) =>
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
    );
    const visitor = s(group[0].visitor_id, 120) ?? "unknown";
    const firstAt = s(group[0].created_at, 40) ?? new Date().toISOString();
    const lastAt = s(group[group.length - 1].created_at, 40) ?? firstAt;

    group.forEach((r, idx) => {
      mapped.push({
        source: "page_visits",
        source_id: String(r.id),
        session_id: sessionId,
        visitor_id: visitor,
        site: SITE,
        seq: idx,
        occurred_at: s(r.created_at, 40) ?? firstAt,
        kind: "page_view",
        path: s(r.page_path, 500) ?? "/",
        page_title: null,
        referrer: s(r.referrer, 2000),
        element: null,
        element_text: null,
        href: null,
        value: null,
        meta: { legacy: true },
        synced_at: new Date().toISOString(),
      });
    });

    // A session row per visitor per day.
    //
    // It is an approximation and it is labelled as one — the data to build
    // a real session was never captured. But WITHOUT it, `web_daily` counts
    // sessions from `web_sessions` (which has none of this) while counting
    // pageviews from `web_events` (which has all of it), and the dashboard
    // reports 2 visits against 214 page views. Two numbers from the same
    // period that cannot both be true is worse than an honest estimate.
    const referrer = s(group[0].referrer, 2000);
    const referrerDomain = legacyReferrerHost(referrer);
    const timestamps = group.map((r) => s(r.created_at, 40) ?? firstAt);
    const paths = group.map((r) => s(r.page_path, 500) ?? "/");

    synthetic.push({
      session_id: sessionId,
      visitor_id: visitor,
      site: SITE,
      first_seen_at: firstAt,
      last_seen_at: lastAt,
      entry_path: paths[0],
      exit_path: paths[paths.length - 1],
      page_count: group.length,
      event_count: group.length,
      duration_seconds: legacyDuration(timestamps),
      // Never fabricated: the old log recorded no engagement at all, and a
      // guess here would flow straight into the bounce rate.
      engaged_seconds: 0,
      is_bounce: group.length <= 1,
      landing_referrer: referrer,
      referrer_domain: referrerDomain,
      channel: classifyLegacyChannel(referrer, referrerDomain),
      // Genuinely unknown — the old log never captured it. The rollup
      // excludes these rows from the device/browser/country breakdowns
      // rather than letting "unknown" swamp them.
      device_type: "unknown",
      // The old log ran with no user-agent check of any kind, so the one
      // signal left is behavioural. Stated explicitly rather than left to
      // the column default, which quietly asserted "human" about rows
      // nothing had ever examined.
      is_bot: looksAutomated(paths, timestamps),
      source_updated_at: lastAt,
      synced_at: new Date().toISOString(),
    });
  }

  // Chunked: a single upsert of 20,000 rows is a request body large enough
  // for PostgREST to refuse, and refusing it loses the whole step.
  for (let i = 0; i < mapped.length; i += PAGE) {
    const { error: upErr } = await crm
      .from("web_events")
      .upsert(mapped.slice(i, i + PAGE), { onConflict: "source,source_id" });
    if (upErr) throw new Error(`page_visits upsert: ${upErr.message}`);
  }

  // Never overwrite a REAL session that happens to share an id — the rich
  // tracker's ids are `s_<uuid>`, these are `legacy:<visitor>:<date>`, so
  // they cannot collide, but the upsert is scoped by that id regardless.
  for (let i = 0; i < synthetic.length; i += PAGE) {
    const { error: sessErr } = await crm
      .from("web_sessions")
      .upsert(synthetic.slice(i, i + PAGE), { onConflict: "session_id" });
    if (sessErr) throw new Error(`page_visits sessions upsert: ${sessErr.message}`);
  }

  total += mapped.length;
  await writeCursor(crm, "page_visits", { cursor_ts: since, rowsTotal: total });
  return { rows: mapped.length, exhausted };
}

// ── the website's AI agent ──────────────────────────────────────────────────

type ChatMsg = { role: string; content: string; created_at: string; id: string };

function summariseTranscript(messages: ChatMsg[]): {
  transcript: string;
  first_user_message: string | null;
  user_messages: number;
  assistant_messages: number;
  captured_email: string | null;
  captured_phone: string | null;
} {
  const lines: string[] = [];
  let firstUser: string | null = null;
  let userCount = 0;
  let assistantCount = 0;

  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : "Visitor";
    if (m.role === "assistant") assistantCount++;
    else {
      userCount++;
      if (!firstUser) firstUser = m.content.slice(0, 500);
    }
    lines.push(`${role}: ${m.content}`);
  }

  const joined = lines.join("\n");
  // What the visitor volunteered in the conversation is often the only
  // contact detail there is — they chatted instead of filling the form.
  const email = joined.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/)?.[0] ?? null;
  const phone = joined.match(/(?:\+|00)[\d][\d\s().-]{7,}\d/)?.[0] ?? null;

  return {
    // Long conversations are truncated: the tail is what the AI pass and
    // a person both actually read, and the raw messages are all still in
    // web_chat_messages if the whole thing is ever needed.
    transcript: joined.length > 40_000 ? `${joined.slice(0, 40_000)}\n…[truncated]` : joined,
    first_user_message: firstUser,
    user_messages: userCount,
    assistant_messages: assistantCount,
    captured_email: email?.toLowerCase().slice(0, 200) ?? null,
    captured_phone: phone?.trim().slice(0, 40) ?? null,
  };
}

/**
 * Re-read one conversation whole and rewrite its mirror.
 *
 * A conversation is only meaningful as a unit — its counts, its transcript
 * and the email buried in message six all change when a seventh arrives —
 * so it is rebuilt from every message it has, not appended to.
 */
async function rebuildConversation(
  crm: DB,
  site: SupabaseClient,
  sessionId: string,
): Promise<number> {
  const { data: msgs } = await site
    .from("chat_messages")
    .select("id, session_id, role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (!msgs?.length) return 0;

  const typed: ChatMsg[] = msgs.map((m: Record<string, unknown>) => ({
    id: String(m.id),
    role: String(m.role ?? "user"),
    content: String(m.content ?? ""),
    created_at: s(m.created_at, 40) ?? new Date().toISOString(),
  }));
  const summary = summariseTranscript(typed);

  const { data: chatRow } = await crm
    .from("web_chat_sessions")
    .upsert(
      {
        source_id: `chat_messages:${sessionId}`,
        site: SITE,
        source_table: "chat_messages",
        started_at: typed[0].created_at,
        last_message_at: typed[typed.length - 1].created_at,
        message_count: typed.length,
        user_messages: summary.user_messages,
        assistant_messages: summary.assistant_messages,
        first_user_message: summary.first_user_message,
        transcript: summary.transcript,
        captured_email: summary.captured_email,
        captured_phone: summary.captured_phone,
        web_session_id: sessionId,
        synced_at: new Date().toISOString(),
      },
      { onConflict: "source_id" },
    )
    .select("id")
    .maybeSingle();

  if (chatRow?.id) {
    await crm.from("web_chat_messages").upsert(
      typed.map((m) => ({
        source_id: `chat_messages:${m.id}`,
        chat_id: chatRow.id,
        session_id: sessionId,
        role: m.role,
        content: m.content.slice(0, 20_000),
        char_count: m.content.length,
        created_at: m.created_at,
        synced_at: new Date().toISOString(),
      })),
      { onConflict: "source_id" },
    );
  }
  return typed.length;
}

/**
 * The message stream, bounded by conversations rather than by rows.
 *
 * A page of messages fans out into one rebuild per conversation it touches,
 * and a rebuild is three round trips. Rewinding the cursor over the whole
 * archive — 431 messages across 126 conversations — therefore meant
 * several minutes of work inside a function killed at 26 seconds, and
 * because the cursor was only written at the very end, the killed run
 * recorded nothing and the next one started from the beginning again.
 * This never finished, on any run, after the first rebuild.
 *
 * Now a step rebuilds a bounded number of conversations in order of first
 * appearance and moves the cursor to the first one it did not reach.
 */
async function syncChatMessages(
  crm: DB,
  site: SupabaseClient,
  deadline: number,
): Promise<StreamOutcome> {
  const cursor = await readCursor(crm, "chat_messages");
  const since = cursor.cursor_ts ?? initialSince(730);
  let total = cursor.rows_synced;

  const { data, error } = await site
    .from("chat_messages")
    .select("id, session_id, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(CHAT_PAGE);
  if (error) {
    if (isMissingTable(error.message)) return { rows: 0, exhausted: true };
    throw new Error(`chat_messages: ${error.message}`);
  }
  if (!data?.length) {
    await writeCursor(crm, "chat_messages", { cursor_ts: since, rowsTotal: total });
    return { rows: 0, exhausted: true };
  }

  const order: string[] = [];
  const firstAt = new Map<string, string>();
  for (const r of data as Record<string, unknown>[]) {
    const sid = s(r.session_id, 120);
    const created = s(r.created_at, 40);
    if (!sid || !created) continue;
    if (!firstAt.has(sid)) {
      firstAt.set(sid, created);
      order.push(sid);
    }
  }

  let processed = 0;
  let rows = 0;
  for (const sid of order) {
    if (processed >= MAX_CONVERSATIONS_PER_STEP) break;
    if (processed > 0 && !timeLeft(deadline)) break;
    rows += await rebuildConversation(crm, site, sid);
    processed++;
  }

  const next = chatCursorAfter({
    since,
    order,
    firstAt,
    processed,
    lastCreatedAt: s(data[data.length - 1].created_at, 40) ?? since,
    pageFull: data.length === CHAT_PAGE,
  });

  total += rows;
  await writeCursor(crm, "chat_messages", { cursor_ts: next.since, rowsTotal: total });
  return { rows, exhausted: next.exhausted };
}

/** The older one-blob-per-conversation format, kept for its history. */
async function syncChatLogs(
  crm: DB,
  site: SupabaseClient,
  deadline: number,
): Promise<StreamOutcome> {
  const cursor = await readCursor(crm, "chat_logs");
  let since = cursor.cursor_ts ?? initialSince(730);
  let total = cursor.rows_synced;
  let rows = 0;
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES_PER_STEP && timeLeft(deadline); page++) {
    const { data, error } = await site
      .from("chat_logs")
      .select("id, created_at, ip_address, user_location, messages, metadata")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(CHAT_LOG_PAGE);
    if (error) {
      if (isMissingTable(error.message)) return { rows: 0, exhausted: true };
      throw new Error(`chat_logs: ${error.message}`);
    }
    if (!data?.length) {
      exhausted = true;
      break;
    }

    let done = 0;
    let lastProcessed = since;
    for (const r of data as Record<string, unknown>[]) {
      // Each row is two round trips; stop between rows, not mid-row.
      if (done > 0 && !timeLeft(deadline)) break;
      const created = s(r.created_at, 40) ?? new Date().toISOString();
      const raw = Array.isArray(r.messages) ? r.messages : [];
      const typed: ChatMsg[] = raw.map((m, idx) => {
        const msg = (m ?? {}) as Record<string, unknown>;
        return {
          id: `${r.id}-${idx}`,
          role: String(msg.role ?? "user"),
          content: String(msg.content ?? msg.text ?? ""),
          created_at: s(msg.created_at, 40) ?? created,
        };
      });
      done++;
      lastProcessed = created;
      if (!typed.length) continue;

      const summary = summariseTranscript(typed);
      const { data: chatRow } = await crm
        .from("web_chat_sessions")
        .upsert(
          {
            source_id: `chat_logs:${r.id}`,
            site: SITE,
            source_table: "chat_logs",
            started_at: typed[0].created_at,
            last_message_at: typed[typed.length - 1].created_at,
            message_count: typed.length,
            user_messages: summary.user_messages,
            assistant_messages: summary.assistant_messages,
            first_user_message: summary.first_user_message,
            transcript: summary.transcript,
            captured_email: summary.captured_email,
            captured_phone: summary.captured_phone,
            ip_location: s(r.user_location, 200),
            metadata: (r.metadata && typeof r.metadata === "object"
              ? r.metadata
              : {}) as Record<string, unknown>,
            synced_at: new Date().toISOString(),
          },
          { onConflict: "source_id" },
        )
        .select("id")
        .maybeSingle();

      if (chatRow?.id) {
        await crm.from("web_chat_messages").upsert(
          typed.map((m) => ({
            source_id: `chat_logs:${m.id}`,
            chat_id: chatRow.id,
            session_id: `chat_logs:${r.id}`,
            role: m.role,
            content: m.content.slice(0, 20_000),
            char_count: m.content.length,
            created_at: m.created_at,
            synced_at: new Date().toISOString(),
          })),
          { onConflict: "source_id" },
        );
      }
      rows += 1;
    }

    const wholePage = done === data.length;
    since = wholePage
      ? nudgeCursor(lastProcessed, since, data.length === CHAT_LOG_PAGE)
      : lastProcessed;
    total += done;
    await writeCursor(crm, "chat_logs", { cursor_ts: since, rowsTotal: total });
    if (!wholePage) break;
    if (data.length < CHAT_LOG_PAGE) {
      exhausted = true;
      break;
    }
  }

  if (exhausted) await writeCursor(crm, "chat_logs", { cursor_ts: since, rowsTotal: total });
  return { rows, exhausted };
}

// ── identity stitching ──────────────────────────────────────────────────────

/**
 * Join anonymous browsing to the people already in the CRM.
 *
 * The moment a visitor types an email into a form or gives it to the
 * chat agent, every page they viewed before that becomes attributable
 * to a named lead — which is the difference between "someone read the
 * pricing page" and "the £8k prospect read the pricing page twice".
 */
export async function stitchIdentities(crm: DB): Promise<number> {
  const { data: sessions } = await crm
    .from("web_sessions")
    .select("session_id, identified_email")
    .not("identified_email", "is", null)
    .is("matched_lead_id", null)
    .limit(500);

  const { data: chats } = await crm
    .from("web_chat_sessions")
    .select("id, captured_email, captured_phone, first_user_message, summary, topic")
    .not("captured_email", "is", null)
    .is("matched_lead_id", null)
    .limit(500);

  const emails = new Set<string>();
  for (const row of sessions ?? []) {
    if (row.identified_email) emails.add(row.identified_email.toLowerCase());
  }
  for (const row of chats ?? []) {
    if (row.captured_email) emails.add(row.captured_email.toLowerCase());
  }
  if (!emails.size) return 0;

  const list = [...emails];
  const [leadsRes, clientsRes] = await Promise.all([
    // A lead's address lives in `contact_email` — `email` is the clients table.
    crm
      .from("leads")
      .select("id, contact_email")
      .in("contact_email", list)
      .is("deleted_at", null),
    crm.from("clients").select("id, email").in("email", list),
  ]);

  const leadByEmail = new Map<string, string>();
  for (const l of leadsRes.data ?? []) {
    if (l.contact_email) leadByEmail.set(l.contact_email.toLowerCase(), l.id);
  }
  const clientByEmail = new Map<string, string>();
  for (const c of clientsRes.data ?? []) {
    if (c.email) clientByEmail.set(c.email.toLowerCase(), c.id);
  }

  let matched = 0;
  for (const row of sessions ?? []) {
    const email = row.identified_email?.toLowerCase();
    if (!email) continue;
    const leadId = leadByEmail.get(email) ?? null;
    const clientId = clientByEmail.get(email) ?? null;
    if (!leadId && !clientId) continue;
    await crm
      .from("web_sessions")
      .update({ matched_lead_id: leadId, matched_client_id: clientId })
      .eq("session_id", row.session_id);
    matched++;
  }
  // Somebody who left an address in the chat and matches nothing in the CRM
  // is a lead nobody has. Off by default — turning strangers into pipeline
  // rows is a decision, not a default — and gated so it can be switched off
  // again without a deploy.
  const autoLead = await chatAutoLeadEnabled(crm);

  for (const row of chats ?? []) {
    const email = row.captured_email?.toLowerCase();
    if (!email) continue;
    let leadId = leadByEmail.get(email) ?? null;

    if (!leadId && autoLead && !clientByEmail.has(email)) {
      const created = await createInboundLead(crm, {
        email: row.captured_email,
        phone: row.captured_phone,
        name: null,
        message: row.summary || row.first_user_message,
        service: row.topic,
        source: "website_chat",
        tags: ["chat"],
        meta: { chat_session_id: row.id },
      }).catch(() => null);
      // createInboundLead dedupes against open leads itself, so a visitor who
      // chats on three days is one lead, not three.
      if (created?.ok) {
        leadId = created.lead.id;
        leadByEmail.set(email, leadId);
      }
    }

    if (!leadId) continue;
    await crm.from("web_chat_sessions").update({ matched_lead_id: leadId }).eq("id", row.id);
    matched++;
  }
  return matched;
}

/** `app_settings.web_chat_auto_lead` — off unless somebody turned it on. */
async function chatAutoLeadEnabled(crm: DB): Promise<boolean> {
  try {
    const { data } = await crm
      .from("app_settings")
      .select("value")
      .eq("key", "web_chat_auto_lead")
      .maybeSingle();
    return (data?.value as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    return false;
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

async function runStream(
  crm: DB,
  name: StreamName,
  work: () => Promise<StreamOutcome>,
): Promise<StreamResult> {
  const startedAt = Date.now();
  try {
    const { rows, exhausted } = await work();
    const durationMs = Date.now() - startedAt;
    // A run row only when something happened. The old version logged every
    // check, and a stuck pipeline wrote twenty-seven thousand of them.
    if (rows > 0) {
      await crm.from("web_sync_runs").insert({
        stream: name,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date().toISOString(),
        rows_synced: rows,
        ok: true,
        duration_ms: durationMs,
      });
    }
    return { stream: name, rows, ok: true, exhausted, durationMs };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const durationMs = Date.now() - startedAt;
    await crm.from("web_sync_runs").insert({
      stream: name,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      ok: false,
      error: message.slice(0, 1000),
      duration_ms: durationMs,
    });
    const cursor = await readCursor(crm, name);
    await writeCursor(crm, name, { rowsTotal: cursor.rows_synced, error: message.slice(0, 1000) });
    return { stream: name, rows: 0, ok: false, exhausted: true, error: message, durationMs };
  }
}

/**
 * One bounded step of the pull.
 *
 * Streams run in sequence, not in parallel: they share one connection to
 * a small Supabase instance, and five concurrent 1000-row scans is how
 * you get rate-limited on the source rather than finishing faster. A
 * stream that throws is caught and recorded — one broken table must not
 * cost the step the other four — and is reported so the job can leave it
 * alone for the rest of its run instead of hitting the same error every
 * step. Once the deadline passes no further stream is started; the ones
 * not reached simply report "not exhausted" and are picked up next step.
 */
export async function syncStep(
  crm: DB,
  opts: { deadline: number; cutover: string | null; skip?: StreamName[] },
): Promise<SyncStepResult> {
  if (!isWebsiteSourceConfigured()) {
    throw new Error(
      "Website source not configured — set WEBSITE_SUPABASE_URL and " +
        "WEBSITE_SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  const site = createWebsiteClient();
  const { deadline, cutover } = opts;
  const skip = new Set(opts.skip ?? []);

  const plan: [StreamName, () => Promise<StreamOutcome>][] = [
    ["sessions", () => syncSessions(crm, site, deadline)],
    ["events", () => syncEvents(crm, site, deadline)],
    ["page_visits", () => syncPageVisits(crm, site, deadline, cutover)],
    ["chat_messages", () => syncChatMessages(crm, site, deadline)],
    ["chat_logs", () => syncChatLogs(crm, site, deadline)],
  ];

  const streams: StreamResult[] = [];
  let exhausted = true;
  for (const [name, work] of plan) {
    if (skip.has(name)) continue;
    if (Date.now() >= deadline) {
      exhausted = false;
      break;
    }
    const result = await runStream(crm, name, work);
    streams.push(result);
    if (!result.exhausted) exhausted = false;
  }

  return {
    streams,
    totalRows: streams.reduce((sum, r) => sum + r.rows, 0),
    exhausted,
  };
}
