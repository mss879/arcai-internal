import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import type { WebLead } from "@/lib/types";

import {
  categoryOf,
  classifyConversion,
  countsAsConversion,
  isGenuine,
  leadOutcome,
  ledgerKey,
  mergeVerdict,
  sessionLedgerKey,
  utcDay,
  type ConversionCategory,
  type LedgerStatus,
} from "./ledger-core";
import { SITE } from "./source";

type DB = SupabaseClient<Database>;
type LedgerRow = Database["public"]["Tables"]["web_leads"]["Row"];
type LedgerInsert = Database["public"]["Tables"]["web_leads"]["Insert"];
type SessionRow = Database["public"]["Tables"]["web_sessions"]["Row"];
type EventRow = Database["public"]["Tables"]["web_events"]["Row"];

/**
 * The lead ledger: every website conversion, reconciled.
 *
 * `web_events` holds what the website's tracker saw — a `conversion` event
 * per enquiry, chat lead or contact click, each carrying the lead id the
 * form minted. `leads` holds what the CRM was told — the inbound webhook
 * stores the same lead id on the lead it creates. This module joins the
 * two into `web_leads`: one row per conversion, with where it came from,
 * who it turned out to be, a verdict (lead / test / spam / unreviewed) and,
 * read live from the matched lead, how it ended.
 *
 * Every conversion figure on the dashboard is then computed FROM this
 * table (see `ledgerRowsForRange` and `countsAsConversion`), so the funnel,
 * the per-day totals, the per-page counts and the AI scan all describe the
 * same list of people — and a spam script's fifteen newsletter signups stop
 * being the month's conversions the moment a rule or a person says so.
 *
 * It runs as the `ledger` phase of the sync job, between the mirror and the
 * rollup, in bounded pages with the cursor written after each. Before
 * migration 0125 is applied the table does not exist; every reader here
 * returns null in that case and its caller falls back to the session flag,
 * so the pipeline keeps running and says what is missing.
 */

const STREAM = "ledger";
const PAGE = 400;
const CHUNK = 150;

export const LEDGER_MISSING =
  "The lead ledger table (web_leads) does not exist yet — run " +
  "supabase/migrations/0125_web_lead_ledger.sql in the CRM project's SQL editor, " +
  "then press Rebuild history so every past conversion is reconciled.";

/** PostgREST's ways of saying the table is not there. */
export function isMissingLedger(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /web_leads/i.test(error.message ?? "") && /exist|find|schema cache/i.test(error.message ?? "");
}

// ── the cursor ──────────────────────────────────────────────────────────────

type Cursor = { eventId: number; sessionsSince: string | null; total: number };

async function readCursor(db: DB): Promise<Cursor> {
  const { data } = await db
    .from("web_sync_state")
    .select("cursor_id, cursor_ts, rows_synced")
    .eq("stream", STREAM)
    .maybeSingle();
  return {
    eventId: Number(data?.cursor_id ?? 0),
    sessionsSince: data?.cursor_ts ?? null,
    total: Number(data?.rows_synced ?? 0),
  };
}

async function writeCursor(
  db: DB,
  cursor: Cursor,
  opts: { error?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db.from("web_sync_state").upsert(
    {
      stream: STREAM,
      cursor_id: cursor.eventId,
      cursor_ts: cursor.sessionsSince,
      rows_synced: cursor.total,
      last_run_at: now,
      last_ok_at: opts.error ? undefined : now,
      last_error: opts.error ?? null,
      updated_at: now,
    },
    { onConflict: "stream" },
  );
}

/** Wind the ledger back to the first conversion event. Part of Rebuild history. */
export async function resetLedgerCursor(db: DB): Promise<void> {
  await writeCursor(db, { eventId: 0, sessionsSince: null, total: 0 });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const uniq = <T>(list: (T | null | undefined)[]): T[] => [
  ...new Set(list.filter((v): v is T => v != null)),
];

const lower = (s: string | null | undefined): string | null =>
  s ? s.trim().toLowerCase() || null : null;

type LeadLite = {
  id: string;
  title: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  status: string;
  score: string | null;
  deleted_at: string | null;
  website_lead_id: string | null;
  web_session_id: string | null;
};

const LEAD_COLUMNS =
  "id, title, contact_name, contact_email, contact_phone, status, score, deleted_at, " +
  "website_lead_id, web_session_id";

async function fetchLeads(
  db: DB,
  column: "id" | "website_lead_id" | "web_session_id" | "contact_email",
  values: string[],
): Promise<LeadLite[]> {
  const out: LeadLite[] = [];
  for (const chunk of chunks(uniq(values))) {
    if (!chunk.length) continue;
    const { data } = await db
      .from("leads")
      .select(LEAD_COLUMNS)
      .in(column, chunk)
      .is("deleted_at", null);
    // The column list is a runtime string, so the typed select parser cannot
    // name the row shape; it is exactly LEAD_COLUMNS.
    out.push(...((data ?? []) as unknown as LeadLite[]));
  }
  return out;
}

async function fetchSessions(db: DB, ids: string[]): Promise<Map<string, SessionRow>> {
  const map = new Map<string, SessionRow>();
  for (const chunk of chunks(uniq(ids))) {
    if (!chunk.length) continue;
    const { data } = await db.from("web_sessions").select("*").in("session_id", chunk);
    for (const row of (data ?? []) as SessionRow[]) map.set(row.session_id, row);
  }
  return map;
}

async function fetchExisting(db: DB, keys: string[]): Promise<Map<string, LedgerRow>> {
  const map = new Map<string, LedgerRow>();
  for (const chunk of chunks(uniq(keys))) {
    if (!chunk.length) continue;
    const { data, error } = await db
      .from("web_leads")
      .select("*")
      .eq("site", SITE)
      .in("lead_key", chunk);
    if (error) throw new Error(isMissingLedger(error) ? LEDGER_MISSING : error.message);
    for (const row of (data ?? []) as LedgerRow[]) map.set(row.lead_key, row);
  }
  return map;
}

type ChatLite = {
  source_id: string;
  matched_lead_id: string | null;
  captured_email: string | null;
  captured_phone: string | null;
};

/** The chat mirror rows for `chat:<id>` keys — the website's chat session id is inside `source_id`. */
async function fetchChats(db: DB, chatIds: string[]): Promise<Map<string, ChatLite>> {
  const map = new Map<string, ChatLite>();
  const sourceIds = uniq(chatIds).flatMap((id) => [`chat_messages:${id}`, `chat_logs:${id}`]);
  for (const chunk of chunks(sourceIds)) {
    if (!chunk.length) continue;
    const { data } = await db
      .from("web_chat_sessions")
      .select("source_id, matched_lead_id, captured_email, captured_phone")
      .in("source_id", chunk);
    for (const row of (data ?? []) as ChatLite[]) {
      map.set(row.source_id.replace(/^chat_(messages|logs):/, ""), row);
    }
  }
  return map;
}

/** One conversion as the ledger is about to judge it. */
type Candidate = {
  key: string;
  sessionId: string;
  visitorId: string | null;
  kind: string;
  category: ConversionCategory;
  occurredAt: string;
  path: string | null;
  meta: Record<string, unknown> | null;
  sourceEventId: number | null;
  occurrences: number;
};

/**
 * Match, classify and write a batch of candidates — the shared core of the
 * event pass and the converted-session pass.
 */
async function writeCandidates(
  db: DB,
  candidates: Candidate[],
  opts: { rebuild: boolean },
): Promise<number> {
  if (!candidates.length) return 0;

  const sessions = await fetchSessions(db, candidates.map((c) => c.sessionId));
  const existing = await fetchExisting(db, candidates.map((c) => c.key));

  // Every route to a CRM lead, gathered in a handful of queries rather than
  // one per row.
  const byKey = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(
    db,
    "website_lead_id",
    candidates.map((c) => c.key).filter((k) => k.startsWith("lead_")),
  )) {
    if (lead.website_lead_id) byKey.set(lead.website_lead_id, lead);
  }
  const bySession = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(db, "web_session_id", candidates.map((c) => c.sessionId))) {
    if (lead.web_session_id) bySession.set(lead.web_session_id, lead);
  }
  const chats = await fetchChats(
    db,
    candidates.filter((c) => c.key.startsWith("chat:")).map((c) => c.key.slice(5)),
  );
  const emails = uniq(
    candidates.map((c) => lower(sessions.get(c.sessionId)?.identified_email)),
  );
  const byEmail = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(db, "contact_email", emails)) {
    const email = lower(lead.contact_email);
    if (email) byEmail.set(email, lead);
  }
  const stitchedIds = uniq([
    ...candidates.map((c) => sessions.get(c.sessionId)?.matched_lead_id),
    ...[...chats.values()].map((c) => c.matched_lead_id),
    ...[...existing.values()].map((r) => r.crm_lead_id),
  ]);
  const byId = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(db, "id", stitchedIds)) byId.set(lead.id, lead);
  for (const lead of [...byKey.values(), ...bySession.values(), ...byEmail.values()]) {
    byId.set(lead.id, lead);
  }

  const rows: LedgerInsert[] = [];
  for (const c of candidates) {
    const session = sessions.get(c.sessionId) ?? null;
    const prior = existing.get(c.key) ?? null;
    const chat = c.key.startsWith("chat:") ? (chats.get(c.key.slice(5)) ?? null) : null;
    const email = lower(session?.identified_email) ?? lower(chat?.captured_email);

    // In order of how sure the match is. A match already recorded is kept
    // unless the lead id itself says otherwise.
    const routes: [LeadLite | null | undefined, string][] = [
      [byKey.get(c.key), "lead_id"],
      [prior?.crm_lead_id ? byId.get(prior.crm_lead_id) : null, prior?.match_method ?? "kept"],
      [bySession.get(c.sessionId), "session"],
      [chat?.matched_lead_id ? byId.get(chat.matched_lead_id) : null, "chat"],
      [session?.matched_lead_id ? byId.get(session.matched_lead_id) : null, "session_stitch"],
      [email ? byEmail.get(email) : null, "email"],
    ];
    const found = routes.find(([candidate]) => Boolean(candidate));
    const matched: LeadLite | null = found?.[0] ?? null;
    const method: string | null = found ? found[1] : null;

    const fresh = classifyConversion({
      kind: c.kind,
      category: c.category,
      meta: c.meta,
      session: session
        ? {
            is_bot: session.is_bot,
            engaged_seconds: session.engaged_seconds,
            forms_started: session.forms_started,
            page_count: session.page_count,
            user_agent: session.user_agent,
            identified_email: session.identified_email,
          }
        : null,
      email: email ?? lower(matched?.contact_email),
    });
    const verdict = mergeVerdict(prior, fresh);

    // A rebuild recounts from the events; an incremental pass adds to what
    // was there. A person's row keeps its count either way.
    const occurrences = !prior
      ? c.occurrences
      : opts.rebuild && prior.status_source !== "manual"
        ? Math.max(c.occurrences, 1)
        : prior.occurrences + c.occurrences;

    rows.push({
      site: SITE,
      lead_key: c.key,
      session_id: c.sessionId,
      visitor_id: c.visitorId ?? session?.visitor_id ?? prior?.visitor_id ?? null,
      kind: c.kind,
      category: c.category,
      occurred_at: prior && prior.occurred_at < c.occurredAt ? prior.occurred_at : c.occurredAt,
      day: utcDay(prior && prior.occurred_at < c.occurredAt ? prior.occurred_at : c.occurredAt),
      path: c.path ?? prior?.path ?? null,
      entry_path: session?.entry_path ?? prior?.entry_path ?? null,
      landing_page_title: session?.landing_page_title ?? prior?.landing_page_title ?? null,
      channel: session?.channel ?? prior?.channel ?? null,
      utm_source: session?.utm_source ?? prior?.utm_source ?? null,
      utm_medium: session?.utm_medium ?? prior?.utm_medium ?? null,
      utm_campaign: session?.utm_campaign ?? prior?.utm_campaign ?? null,
      referrer_domain: session?.referrer_domain ?? prior?.referrer_domain ?? null,
      country: session?.country ?? session?.country_code ?? prior?.country ?? null,
      device_type: session?.device_type ?? prior?.device_type ?? null,
      identified_email: session?.identified_email ?? chat?.captured_email ?? prior?.identified_email ?? null,
      contact_name: matched?.contact_name ?? prior?.contact_name ?? null,
      contact_email: matched?.contact_email ?? chat?.captured_email ?? prior?.contact_email ?? null,
      contact_phone: matched?.contact_phone ?? chat?.captured_phone ?? prior?.contact_phone ?? null,
      crm_lead_id: matched?.id ?? null,
      match_method: matched ? method : null,
      status: verdict.status,
      status_source: verdict.status_source,
      status_reason: verdict.status_reason,
      status_set_by: prior?.status_set_by ?? null,
      status_set_at: prior?.status_set_at ?? null,
      source_event_id: c.sourceEventId ?? prior?.source_event_id ?? null,
      occurrences,
      flags: { ...(prior?.flags ?? {}), ...fresh.flags },
    });
  }

  for (const chunk of chunks(rows, 200)) {
    const { error } = await db.from("web_leads").upsert(chunk, { onConflict: "site,lead_key" });
    if (error) throw new Error(isMissingLedger(error) ? LEDGER_MISSING : error.message);
  }
  return rows.length;
}

/** Group a page of conversion events into one candidate per ledger key. */
function candidatesFromEvents(events: EventRow[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const e of events) {
    const meta = (e.meta && typeof e.meta === "object" ? e.meta : null) as Record<
      string,
      unknown
    > | null;
    const kind =
      (e.element_text ?? "").trim() ||
      (typeof meta?.kind === "string" ? meta.kind : "") ||
      "unspecified";
    const declared = typeof meta?.category === "string" ? meta.category : null;
    const category: ConversionCategory =
      declared === "enquiry" || declared === "contact_click" || declared === "other"
        ? declared
        : categoryOf(kind);
    const key = ledgerKey(kind, e.session_id, meta);
    const current = map.get(key);
    if (current) {
      current.occurrences += 1;
      if (e.occurred_at < current.occurredAt) {
        current.occurredAt = e.occurred_at;
        current.path = e.path;
        current.sourceEventId = Number(e.id);
        current.meta = meta;
      }
      continue;
    }
    map.set(key, {
      key,
      sessionId: e.session_id,
      visitorId: e.visitor_id,
      kind,
      category,
      occurredAt: e.occurred_at,
      path: e.path,
      meta,
      sourceEventId: Number(e.id),
      occurrences: 1,
    });
  }
  return [...map.values()];
}

// ── the step ────────────────────────────────────────────────────────────────

/**
 * Advance the ledger by up to `deadline`. Two passes:
 *
 *   1. conversion EVENTS newer than the id cursor, a page at a time — the
 *      normal case;
 *   2. SESSIONS flagged `converted` that have no ledger row at all — the
 *      event was lost (a beacon that never landed, a browser without
 *      storage), but the session flag survived, so the row is synthesised
 *      from the session and keyed `session:<id>`.
 *
 * Then, with whatever time is left, enquiries still unmatched to a CRM lead
 * from the last three weeks are tried again — the lead may have arrived
 * after the event did.
 */
export async function ledgerStep(
  db: DB,
  opts: { deadline: number; rebuild: boolean },
): Promise<{ rows: number; exhausted: boolean }> {
  const cursor = await readCursor(db);
  let rows = 0;

  // ---- pass 1: conversion events -------------------------------------------
  let eventsDone = false;
  while (Date.now() < opts.deadline) {
    const { data, error } = await db
      .from("web_events")
      .select("*")
      .eq("site", SITE)
      .eq("kind", "conversion")
      .gt("id", cursor.eventId)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(error.message);
    const events = (data ?? []) as EventRow[];
    if (!events.length) {
      eventsDone = true;
      break;
    }
    const written = await writeCandidates(db, candidatesFromEvents(events), opts);
    rows += written;
    cursor.eventId = Number(events[events.length - 1].id);
    cursor.total += written;
    await writeCursor(db, cursor);
    if (events.length < PAGE) {
      eventsDone = true;
      break;
    }
  }
  if (!eventsDone) return { rows, exhausted: false };

  // ---- pass 2: converted sessions with no row ----------------------------------
  let sessionsDone = false;
  let since = cursor.sessionsSince ?? "1970-01-01T00:00:00.000Z";
  while (Date.now() < opts.deadline) {
    const { data, error } = await db
      .from("web_sessions")
      .select("*")
      .eq("site", SITE)
      .eq("converted", true)
      .gte("synced_at", since)
      .order("synced_at", { ascending: true })
      .order("session_id", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(error.message);
    const sessions = (data ?? []) as SessionRow[];
    if (!sessions.length) {
      sessionsDone = true;
      break;
    }

    const covered = new Set<string>();
    for (const chunk of chunks(sessions.map((s) => s.session_id))) {
      const { data: have, error: haveErr } = await db
        .from("web_leads")
        .select("session_id")
        .eq("site", SITE)
        .in("session_id", chunk);
      if (haveErr) throw new Error(isMissingLedger(haveErr) ? LEDGER_MISSING : haveErr.message);
      for (const r of have ?? []) covered.add(r.session_id);
    }

    const candidates: Candidate[] = sessions
      .filter((s) => !covered.has(s.session_id))
      .map((s) => {
        const kind = (s.conversion_kind ?? "").trim() || "unspecified";
        return {
          key: sessionLedgerKey(s.session_id),
          sessionId: s.session_id,
          visitorId: s.visitor_id,
          kind,
          category: categoryOf(kind),
          occurredAt: s.conversion_at ?? s.last_seen_at ?? s.first_seen_at,
          path: s.exit_path ?? s.entry_path,
          meta: null,
          sourceEventId: null,
          occurrences: 1,
        };
      });
    const written = await writeCandidates(db, candidates, opts);
    rows += written;
    cursor.total += written;

    const last = sessions[sessions.length - 1].synced_at;
    // `>=` re-reads the tied tail row on the next page, which is harmless —
    // except on a full page of one timestamp, where it would never move.
    since =
      last === since && sessions.length === PAGE
        ? new Date(new Date(last).getTime() + 1).toISOString()
        : last;
    cursor.sessionsSince = since;
    await writeCursor(db, cursor);
    if (sessions.length < PAGE) {
      sessionsDone = true;
      break;
    }
  }
  if (!sessionsDone) return { rows, exhausted: false };

  // ---- pass 3: late matches ------------------------------------------------------
  if (Date.now() < opts.deadline) {
    await rematchUnmatched(db).catch(() => undefined);
  }
  return { rows, exhausted: true };
}

/** Enquiries from the last three weeks with no CRM lead yet — the lead may have arrived since. */
async function rematchUnmatched(db: DB): Promise<number> {
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const { data, error } = await db
    .from("web_leads")
    .select("*")
    .eq("site", SITE)
    .eq("category", "enquiry")
    .is("crm_lead_id", null)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (error || !data?.length) return 0;
  const rows = data as LedgerRow[];

  const byKey = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(
    db,
    "website_lead_id",
    rows.map((r) => r.lead_key).filter((k) => k.startsWith("lead_")),
  )) {
    if (lead.website_lead_id) byKey.set(lead.website_lead_id, lead);
  }
  const bySession = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(db, "web_session_id", rows.map((r) => r.session_id))) {
    if (lead.web_session_id) bySession.set(lead.web_session_id, lead);
  }
  const byEmail = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(
    db,
    "contact_email",
    uniq(rows.map((r) => lower(r.identified_email))),
  )) {
    const email = lower(lead.contact_email);
    if (email) byEmail.set(email, lead);
  }

  let matched = 0;
  for (const row of rows) {
    const email = lower(row.identified_email);
    let hit: { lead: LeadLite; how: string } | null = null;
    const viaKey = byKey.get(row.lead_key);
    const viaSession = bySession.get(row.session_id);
    const viaEmail = email ? byEmail.get(email) : undefined;
    if (viaKey) hit = { lead: viaKey, how: "lead_id" };
    else if (viaSession) hit = { lead: viaSession, how: "session" };
    else if (viaEmail) hit = { lead: viaEmail, how: "email" };
    if (!hit) continue;
    await db
      .from("web_leads")
      .update({
        crm_lead_id: hit.lead.id,
        match_method: hit.how,
        contact_name: row.contact_name ?? hit.lead.contact_name,
        contact_email: row.contact_email ?? hit.lead.contact_email,
        contact_phone: row.contact_phone ?? hit.lead.contact_phone,
      })
      .eq("id", row.id);
    matched++;
  }
  return matched;
}

// ── the webhook's side ──────────────────────────────────────────────────────

/**
 * Record an enquiry the moment the inbound webhook creates its lead.
 *
 * The analytics event for the same conversion arrives on the next sync,
 * keyed by the same lead id, and merges into this row — but this side is
 * written first because it is the side that cannot be lost: a browser with
 * storage blocked or a beacon that never landed loses the event, never the
 * webhook. `crm_lead_id` is set here and kept by every later merge.
 */
export async function recordHookConversion(
  db: DB,
  input: {
    leadKey: string;
    sessionId: string | null;
    visitorId: string | null;
    crmLeadId: string;
    kind?: string;
    test?: boolean;
    contact: { name: string | null; email: string | null; phone: string | null };
    landingUrl: string | null;
    utm: Record<string, string>;
  },
): Promise<void> {
  const kind = input.kind ?? "contact_form";
  const now = new Date().toISOString();
  const test = Boolean(input.test) || (input.contact.email ? /(^|[.+_-])test([.+_0-9-]|@)/i.test(input.contact.email) : false);
  let entryPath: string | null = null;
  try {
    entryPath = input.landingUrl ? new URL(input.landingUrl).pathname : null;
  } catch {
    entryPath = null;
  }

  const { data: prior, error: readErr } = await db
    .from("web_leads")
    .select("*")
    .eq("site", SITE)
    .eq("lead_key", input.leadKey)
    .maybeSingle();
  if (readErr) {
    if (isMissingLedger(readErr)) return;
    throw new Error(readErr.message);
  }
  const existing = (prior ?? null) as LedgerRow | null;
  const verdict = mergeVerdict(existing, {
    status: test ? "test" : "unreviewed",
    source: test ? "rule" : "none",
    reason: test ? "Sent in test mode." : null,
    flags: {},
  });

  const { error } = await db.from("web_leads").upsert(
    {
      site: SITE,
      lead_key: input.leadKey,
      session_id: input.sessionId ?? existing?.session_id ?? `hook:${input.leadKey}`,
      visitor_id: input.visitorId ?? existing?.visitor_id ?? null,
      kind: existing?.kind ?? kind,
      category: existing?.category ?? categoryOf(kind),
      occurred_at: existing?.occurred_at ?? now,
      day: utcDay(existing?.occurred_at ?? now),
      path: existing?.path ?? null,
      entry_path: existing?.entry_path ?? entryPath,
      utm_source: existing?.utm_source ?? input.utm.utm_source ?? null,
      utm_medium: existing?.utm_medium ?? input.utm.utm_medium ?? null,
      utm_campaign: existing?.utm_campaign ?? input.utm.utm_campaign ?? null,
      contact_name: input.contact.name ?? existing?.contact_name ?? null,
      contact_email: input.contact.email ?? existing?.contact_email ?? null,
      contact_phone: input.contact.phone ?? existing?.contact_phone ?? null,
      crm_lead_id: input.crmLeadId,
      match_method: "hook",
      status: verdict.status,
      status_source: verdict.status_source,
      status_reason: verdict.status_reason,
      occurrences: existing?.occurrences ?? 1,
      flags: { ...(existing?.flags ?? {}), ...(test ? { test_mode: true } : {}), hook: true },
    },
    { onConflict: "site,lead_key" },
  );
  if (error && !isMissingLedger(error)) throw new Error(error.message);
}

// ── readers ─────────────────────────────────────────────────────────────────

/** The slice of a ledger row every conversion figure is computed from. */
export type LedgerConversion = Pick<
  LedgerRow,
  "lead_key" | "session_id" | "day" | "path" | "kind" | "category" | "status" | "occurrences"
>;

/**
 * Every ledger row in a window, or null when the table does not exist yet
 * — the caller then falls back to the session flag, so the dashboard keeps
 * working before migration 0125 has been applied.
 */
export async function ledgerRowsForRange(
  db: DB,
  fromIso: string,
  toIso: string,
): Promise<LedgerConversion[] | null> {
  const out: LedgerConversion[] = [];
  const size = 1000;
  for (let from = 0; from < 20_000; from += size) {
    const { data, error } = await db
      .from("web_leads")
      .select("lead_key, session_id, day, path, kind, category, status, occurrences")
      .eq("site", SITE)
      .gte("occurred_at", fromIso)
      .lte("occurred_at", toIso)
      .order("occurred_at", { ascending: true })
      .order("lead_key", { ascending: true })
      .range(from, from + size - 1);
    if (error) {
      if (isMissingLedger(error)) return null;
      throw new Error(error.message);
    }
    if (!data?.length) break;
    out.push(...(data as LedgerConversion[]));
    if (data.length < size) break;
  }
  return out;
}

/** The sessions whose ledger rows count as conversions. */
export function countingSessions(rows: LedgerConversion[]): Set<string> {
  return new Set(rows.filter(countsAsConversion).map((r) => r.session_id));
}

/** The sessions that showed genuine intent of any kind — everything but spam and tests. */
export function intentSessions(rows: LedgerConversion[]): Set<string> {
  return new Set(rows.filter(isGenuine).map((r) => r.session_id));
}

export type LedgerSummary = {
  /** Conversion events the website recorded (rows × occurrences). */
  events: number;
  /** Distinct ledger rows. */
  rows: number;
  /** Rows counted as conversions on the dashboard. */
  counted: number;
  enquiries: number;
  contact_clicks: number;
  confirmed_leads: number;
  unreviewed: number;
  unreviewed_enquiries: number;
  unreviewed_contact_clicks: number;
  spam: number;
  test: number;
  /** Genuine rows with a CRM lead attached. */
  matched: number;
  unmatched_enquiries: number;
  qualified: number;
  won: number;
  lost: number;
  by_kind: { kind: string; category: ConversionCategory; rows: number; counted: number }[];
};

export type LedgerEntry = WebLead & {
  lead: {
    id: string;
    title: string;
    status: string;
    score: string | null;
    contact_name: string | null;
  } | null;
  qualified: boolean;
  outcome: "open" | "won" | "lost" | "none";
};

async function leadsById(db: DB, ids: string[]): Promise<Map<string, LeadLite>> {
  const map = new Map<string, LeadLite>();
  for (const lead of await fetchLeads(db, "id", ids)) map.set(lead.id, lead);
  return map;
}

/** The reconciliation totals for a window, or null before migration 0125. */
export async function ledgerSummary(
  db: DB,
  range: { from: string; to: string },
): Promise<LedgerSummary | null> {
  const rows: LedgerRow[] = [];
  const size = 1000;
  for (let from = 0; from < 10_000; from += size) {
    const { data, error } = await db
      .from("web_leads")
      .select("*")
      .eq("site", SITE)
      .gte("occurred_at", `${range.from}T00:00:00.000Z`)
      .lte("occurred_at", `${range.to}T23:59:59.999Z`)
      .order("occurred_at", { ascending: false })
      .order("lead_key", { ascending: true })
      .range(from, from + size - 1);
    if (error) {
      if (isMissingLedger(error)) return null;
      throw new Error(error.message);
    }
    if (!data?.length) break;
    rows.push(...(data as LedgerRow[]));
    if (data.length < size) break;
  }

  const leads = await leadsById(db, uniq(rows.map((r) => r.crm_lead_id)));
  const kinds = new Map<string, LedgerSummary["by_kind"][number]>();
  const s: LedgerSummary = {
    events: 0,
    rows: rows.length,
    counted: 0,
    enquiries: 0,
    contact_clicks: 0,
    confirmed_leads: 0,
    unreviewed: 0,
    unreviewed_enquiries: 0,
    unreviewed_contact_clicks: 0,
    spam: 0,
    test: 0,
    matched: 0,
    unmatched_enquiries: 0,
    qualified: 0,
    won: 0,
    lost: 0,
    by_kind: [],
  };
  for (const r of rows) {
    s.events += r.occurrences;
    const counted = countsAsConversion(r);
    const genuine = isGenuine(r);
    if (counted) s.counted++;
    if (r.status === "lead") s.confirmed_leads++;
    if (r.status === "spam") s.spam++;
    if (r.status === "test") s.test++;
    if (r.status === "unreviewed") {
      s.unreviewed++;
      if (r.category === "enquiry") s.unreviewed_enquiries++;
      if (r.category === "contact_click") s.unreviewed_contact_clicks++;
    }
    if (genuine && r.category === "enquiry") s.enquiries++;
    if (genuine && r.category === "contact_click") s.contact_clicks++;
    const lead = r.crm_lead_id ? (leads.get(r.crm_lead_id) ?? null) : null;
    if (genuine && lead) s.matched++;
    if (genuine && r.category === "enquiry" && !lead) s.unmatched_enquiries++;
    if (genuine) {
      const out = leadOutcome(r, lead);
      if (out.qualified) s.qualified++;
      if (out.won) s.won++;
      if (out.outcome === "lost") s.lost++;
    }
    const k = kinds.get(r.kind) ?? { kind: r.kind, category: r.category, rows: 0, counted: 0 };
    k.rows++;
    if (counted) k.counted++;
    kinds.set(r.kind, k);
  }
  s.by_kind = [...kinds.values()].sort((a, b) => b.rows - a.rows);
  return s;
}

/** The newest ledger rows in a window with their CRM lead, or null before 0125. */
export async function ledgerEntries(
  db: DB,
  range: { from: string; to: string },
  limit = 200,
): Promise<LedgerEntry[] | null> {
  const { data, error } = await db
    .from("web_leads")
    .select("*")
    .eq("site", SITE)
    .gte("occurred_at", `${range.from}T00:00:00.000Z`)
    .lte("occurred_at", `${range.to}T23:59:59.999Z`)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingLedger(error)) return null;
    throw new Error(error.message);
  }
  const rows = (data ?? []) as LedgerRow[];
  const leads = await leadsById(db, uniq(rows.map((r) => r.crm_lead_id)));
  return rows.map((r) => {
    const lead = r.crm_lead_id ? (leads.get(r.crm_lead_id) ?? null) : null;
    const out = leadOutcome(r, lead);
    return {
      ...r,
      lead: lead
        ? {
            id: lead.id,
            title: lead.title,
            status: lead.status,
            score: lead.score,
            contact_name: lead.contact_name,
          }
        : null,
      qualified: out.qualified,
      outcome: out.outcome,
    };
  });
}

/**
 * A person's verdict on a row. Final: no rule will change it again. Returns
 * the row's day so the caller can recompute that day's rollup.
 */
export async function setLedgerStatus(
  db: DB,
  id: string,
  status: LedgerStatus,
  userId: string | null,
  reason?: string | null,
): Promise<{ ok: true; day: string } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("web_leads")
    .update({
      status,
      status_source: "manual",
      status_reason: reason?.trim() || "Set by hand on the Web Analytics page.",
      status_set_by: userId,
      status_set_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("day")
    .single();
  if (error || !data) {
    return { ok: false, error: error ? (isMissingLedger(error) ? LEDGER_MISSING : error.message) : "Row not found." };
  }
  return { ok: true, day: data.day };
}
