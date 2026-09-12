import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { colomboDay } from "@/lib/ai-projects/time-core";
import type { Database } from "@/lib/database.types";
import type { MetaAdEntity, MetaAdInsight, MetaAdSync, WaContact } from "@/lib/types";

import {
  attributeContact,
  isAdReferral,
  parseReferral,
  resolveAdTouch,
  type AttributionMethod,
} from "./attribution-core";
import {
  computeFunnel,
  costPer,
  healthSignals,
  type FunnelStage,
  type HealthSignal,
} from "./health-core";
import {
  adLetters,
  contactBounds,
  crmByAd,
  crmTotals,
  dailySeries,
  effectiveFlight,
  parseWindowKey,
  resolveWindow,
  rowsForTotals,
  sumInsights,
  syncedAtOf,
  totalsByEntity,
  type AdsWindowKey,
  type ContactOutcome,
  type CrmTotals,
  type DailyPoint,
  type DayRange,
  type InsightTotals,
} from "./report-core";

/**
 * Everything /ads shows, read in one pass (0132).
 *
 * The Meta half comes from the meta_ad_* tables Claude's sync writes. The
 * CRM half is computed LIVE from wa_contacts, wa_messages and leads on every
 * load — never stored — so a call booked a minute ago is on the page now,
 * without waiting for the next ad sync.
 *
 * Reads go through the signed-in user's client: meta_ad_* is admin-read
 * under RLS and the page is admin-only, so the database enforces what the
 * route already checks.
 */

type DB = SupabaseClient<Database>;

/** PostgREST's page size; every list that can grow is read in pages of this. */
const PAGE = 1000;
/** Contacts considered per load. A three-day flight brings a few hundred. */
export const CONTACT_CAP = 1000;
/** Contact ids per wa_messages request — keeps the `in.(…)` URL short. */
const MESSAGE_CHUNK = 50;
/** Conversation rows sent to the browser. */
const CONVERSATION_ROWS = 200;

/** The clock, outside any component (react-hooks/purity). */
function now(): Date {
  return new Date();
}

export type CampaignOption = {
  id: string;
  name: string;
  status: string | null;
  effective_status: string | null;
  start_time: string | null;
  end_time: string | null;
  synced_at: string;
};

export type AdRow = {
  id: string;
  letter: string;
  name: string;
  status: string | null;
  headline: string | null;
  prefill: string | null;
  spend: number;
  impressions: number;
  linkCtr: number | null;
  conversations: number;
  costPerConversation: number | null;
  contacts: number;
  qualified: number;
  booked: number;
  costPerBooked: number | null;
};

export type ConversationRow = {
  contactId: string;
  name: string;
  firstMessage: string | null;
  adId: string;
  adLetter: string;
  adName: string;
  method: AttributionMethod;
  replied: boolean;
  leadId: string | null;
  leadTitle: string | null;
  leadScore: string | null;
  bookedAt: string | null;
  enteredAt: string;
  href: string;
};

export type AdsReport = {
  state: "ready";
  campaigns: CampaignOption[];
  campaign: CampaignOption & {
    ad_account_id: string;
    objective: string | null;
    daily_budget: number | null;
    lifetime_budget: number | null;
  };
  window: AdsWindowKey;
  range: DayRange;
  currency: string;
  totals: InsightTotals;
  crm: CrmTotals;
  /** How the ad contacts were matched — a prefill-heavy mix means the referral is being lost. */
  matched: { referral: number; prefill: number };
  costPerBooked: number | null;
  funnel: FunnelStage[];
  signals: HealthSignal[];
  daily: DailyPoint[];
  ads: AdRow[];
  conversations: ConversationRow[];
  lastSync: MetaAdSync | null;
  /** True when CONTACT_CAP was hit — the CRM figures are then a floor. */
  capped: boolean;
};

export type AdsPageData =
  | { state: "setup"; detail: string }
  | { state: "empty"; lastSync: MetaAdSync | null }
  | AdsReport;

type PgError = { code?: string; message?: string } | null | undefined;

/** A missing 0132/0133: the table (or a column they add) does not exist yet. */
function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.code === "42703" ||
    /could not find the table|does not exist/i.test(error.message ?? "")
  );
}

class SchemaMissing extends Error {}

function check<T>(res: { data: T | null; error: PgError }): T | null {
  if (res.error) {
    if (isMissingSchema(res.error)) throw new SchemaMissing(res.error.message ?? "missing");
    throw new Error(res.error.message ?? "query failed");
  }
  return res.data;
}

/** Every row a query can return, a PostgREST page at a time. */
async function paged<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError }>,
  max: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const rows = check(await page(from, Math.min(from + PAGE, max) - 1)) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toOption(c: MetaAdEntity): CampaignOption {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    effective_status: c.effective_status,
    start_time: c.start_time,
    end_time: c.end_time,
    synced_at: c.synced_at,
  };
}

const isLive = (c: { status: string | null; effective_status: string | null }) =>
  (c.effective_status ?? c.status ?? "").toUpperCase() === "ACTIVE";

/** Read and compute the whole page. Never throws for a missing 0132. */
export async function loadAdsPage(
  supabase: DB,
  params: { campaign?: string; window?: string },
): Promise<AdsPageData> {
  try {
    return await load(supabase, params);
  } catch (e) {
    if (e instanceof SchemaMissing) return { state: "setup", detail: e.message };
    throw e;
  }
}

async function load(
  supabase: DB,
  params: { campaign?: string; window?: string },
): Promise<AdsPageData> {
  const campaignRows =
    check(
      await supabase
        .from("meta_ad_entities")
        .select("*")
        .eq("level", "campaign")
        .order("synced_at", { ascending: false })
        .limit(50),
    ) ?? [];
  if (!campaignRows.length) {
    // A sync can land with insights and no campaign entity; say it happened.
    const lastSync = check(
      await supabase
        .from("meta_ad_syncs")
        .select("*")
        .order("synced_at", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    return { state: "empty", lastSync: lastSync ?? null };
  }

  // The one asked for, else the most recently synced live one, else the newest.
  const campaign =
    campaignRows.find((c) => c.id === params.campaign) ??
    campaignRows.find(isLive) ??
    campaignRows[0];

  // Children first: the ad sets can supply the flight the campaign row lacks.
  const [children, lastSync] = await Promise.all([
    supabase
      .from("meta_ad_entities")
      .select("*")
      .eq("campaign_id", campaign.id)
      .in("level", ["adset", "ad"])
      .order("name")
      .limit(500)
      .then((res) => check(res) ?? []),
    supabase
      .from("meta_ad_syncs")
      .select("*")
      .eq("ad_account_id", campaign.ad_account_id)
      // When the numbers were read, not when the row was written (syncedAtOf).
      .order("synced_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((res) => check(res)),
  ]);

  const window = parseWindowKey(params.window);
  const planned = effectiveFlight(
    campaign,
    children.filter((e) => e.level === "adset"),
  );
  const flight = { start: planned.start, end: planned.end };
  const range = resolveWindow(window, flight, colomboDay(now()));
  const bounds = contactBounds(window, range, flight);

  const insights = await paged<MetaAdInsight>(
    (from, to) =>
      supabase
        .from("meta_ad_insights")
        .select("*")
        .eq("campaign_id", campaign.id)
        .gte("date", range.from)
        .lte("date", range.to)
        .order("date")
        .order("id")
        .range(from, to),
    10_000,
  );

  const ads = children.filter((e) => e.level === "ad");
  const letters = adLetters(ads);
  const adById = new Map(ads.map((a) => [a.id, a]));

  // -- the CRM half -----------------------------------------------------------
  const { outcomes, conversations, capped } = await loadOutcomes(supabase, {
    ads,
    letters,
    adById,
    flight,
    bounds,
  });

  // -- the numbers --------------------------------------------------------------
  const currency = campaign.currency ?? insights[0]?.currency ?? "LKR";
  const totals = sumInsights(rowsForTotals(insights));
  const crm = crmTotals(outcomes);
  const perAd = totalsByEntity(insights, "ad");
  const crmPerAd = crmByAd(outcomes);

  const adRows: AdRow[] = ads
    .map((ad) => {
      const t = perAd.get(ad.id) ?? sumInsights([]);
      const c = crmPerAd.get(ad.id);
      return {
        id: ad.id,
        letter: letters.get(ad.id) ?? "?",
        name: ad.name,
        status: ad.effective_status ?? ad.status,
        headline: ad.creative?.headline ?? null,
        prefill: ad.creative?.prefill ?? null,
        spend: t.spend,
        impressions: t.impressions,
        linkCtr: t.linkCtr,
        conversations: t.conversations,
        costPerConversation: t.costPerConversation,
        contacts: c?.adContacts ?? 0,
        qualified: c?.qualified ?? 0,
        booked: c?.booked ?? 0,
        costPerBooked: costPer(t.spend, c?.booked ?? 0),
      };
    })
    .sort((a, b) => a.letter.localeCompare(b.letter));

  const signals = healthSignals({
    now: now(),
    currency,
    campaign: {
      status: campaign.status,
      effective_status: campaign.effective_status,
      start: planned.start,
      end: planned.end,
      daily_budget: planned.daily_budget,
    },
    totals: {
      spend: totals.spend,
      impressions: totals.impressions,
      clicks: totals.clicks,
      link_clicks: totals.link_clicks,
      conversations: totals.conversations,
      frequency: totals.frequency,
    },
    crm,
    lastSyncedAt: syncedAtOf(lastSync),
  });

  return {
    state: "ready",
    campaigns: campaignRows.map(toOption),
    campaign: {
      ...toOption(campaign),
      // The flight as judged — the ad sets' when the campaign row has none.
      start_time: planned.start,
      end_time: planned.end,
      ad_account_id: campaign.ad_account_id,
      objective: campaign.objective,
      daily_budget: planned.daily_budget,
      lifetime_budget: campaign.lifetime_budget,
    },
    window,
    range,
    currency,
    totals,
    crm,
    matched: {
      referral: outcomes.filter((o) => o.method === "referral").length,
      prefill: outcomes.filter((o) => o.method === "prefill").length,
    },
    costPerBooked: costPer(totals.spend, crm.booked),
    funnel: computeFunnel({
      impressions: totals.impressions,
      link_clicks: totals.link_clicks,
      conversations: totals.conversations,
      adContacts: crm.adContacts,
      qualified: crm.qualified,
      booked: crm.booked,
    }),
    signals,
    daily: dailySeries(rowsForTotals(insights), range),
    ads: adRows,
    conversations,
    lastSync: lastSync ?? null,
    capped,
  };
}

type FirstInbound = { body: string; at: string; meta: Record<string, unknown>; count: number };

/**
 * Attribute the contacts in the window to this campaign's ads, and what
 * each one went on to do.
 *
 * Three contact reads:
 *   * everyone created inside the window — new chats, the prefill's domain;
 *   * anyone with an inbound message inside the window whose referral names
 *     one of these ads. A returning contact who tapped the ad was created
 *     long before the flight, and their stored first touch may be an
 *     EARLIER campaign's ad (it is first-touch for life) — the message's
 *     meta.referral is the proof. It needs no 0132 column: meta is on every
 *     database;
 *   * (0132) anyone whose stored first touch names one of these ads, in
 *     case that message's referral never made it into meta.
 * select("*") on wa_contacts on purpose: naming the ad_* columns would fail
 * the whole read on a database without them.
 */
async function loadOutcomes(
  supabase: DB,
  ctx: {
    ads: MetaAdEntity[];
    letters: Map<string, string>;
    adById: Map<string, MetaAdEntity>;
    flight: { start: string | null; end: string | null };
    bounds: { from: string; to: string | null };
  },
): Promise<{ outcomes: ContactOutcome[]; conversations: ConversationRow[]; capped: boolean }> {
  const empty = { outcomes: [], conversations: [], capped: false };
  const { ads, bounds } = ctx;
  if (!ads.length) return empty;
  if (bounds.to && bounds.from > bounds.to) return empty;

  const adIds = ads.map((a) => a.id);
  const prefills = ads.map((a) => ({ id: a.id, prefill: a.creative?.prefill ?? null }));

  let inWindow = supabase
    .from("wa_contacts")
    .select("*")
    .gte("created_at", bounds.from)
    .order("created_at", { ascending: false })
    .limit(CONTACT_CAP);
  let referred = supabase
    .from("wa_messages")
    .select("contact_id, created_at, meta")
    .eq("direction", "in")
    .in("meta->referral->>source_id", adIds)
    .gte("created_at", bounds.from)
    .order("created_at", { ascending: true })
    .limit(CONTACT_CAP);
  if (bounds.to) {
    inWindow = inWindow.lte("created_at", bounds.to);
    referred = referred.lte("created_at", bounds.to);
  }

  const [windowRes, referredRes, returningRes] = await Promise.all([
    inWindow,
    referred,
    supabase.from("wa_contacts").select("*").in("ad_source_id", adIds).limit(500),
  ]);
  const windowContacts = (check(windowRes) ?? []) as WaContact[];
  // Both of these only ADD evidence; a failure costs returners, never the page.
  if (referredRes.error) console.warn("[ads] referral message read failed:", referredRes.error.message);
  const referredRows = referredRes.error ? [] : (referredRes.data ?? []);
  // A missing ad_source_id column (0132 not applied) just means no returners.
  const returning = returningRes.error ? [] : ((returningRes.data ?? []) as WaContact[]);

  // Per contact, the earliest in-window message proving a tap on one of these ads.
  const campaignRefs = new Map<string, { adId: string; at: string }>();
  for (const m of referredRows) {
    if (campaignRefs.has(m.contact_id)) continue;
    const referral = parseReferral(m.meta?.referral);
    if (isAdReferral(referral) && referral?.source_id && adIds.includes(referral.source_id)) {
      campaignRefs.set(m.contact_id, { adId: referral.source_id, at: m.created_at });
    }
  }

  const contacts = new Map<string, WaContact>();
  for (const c of [...windowContacts, ...returning]) contacts.set(c.id, c);
  // The referred contacts not read yet: returning people, created before the window.
  const unread = [...campaignRefs.keys()].filter((id) => !contacts.has(id));
  const unreadBatches = await Promise.all(
    chunk(unread, 100).map((ids) =>
      supabase
        .from("wa_contacts")
        .select("*")
        .in("id", ids)
        .then((res) => (check(res) ?? []) as WaContact[]),
    ),
  );
  for (const rows of unreadBatches) for (const c of rows) contacts.set(c.id, c);
  if (!contacts.size) return empty;

  // Every inbound message since the window opened, oldest first: the first
  // is the one that carries the prefill (and the referral); a second means
  // they engaged with the agent rather than only tapping.
  const firsts = new Map<string, FirstInbound>();
  const batches = await Promise.all(
    chunk([...contacts.keys()], MESSAGE_CHUNK).map((ids) =>
      supabase
        .from("wa_messages")
        .select("contact_id, body, created_at, meta")
        .in("contact_id", ids)
        .eq("direction", "in")
        .gte("created_at", bounds.from)
        .order("created_at", { ascending: true })
        .limit(PAGE)
        .then((res) => check(res) ?? []),
    ),
  );
  for (const rows of batches) {
    for (const m of rows) {
      const seen = firsts.get(m.contact_id);
      if (seen) seen.count += 1;
      else firsts.set(m.contact_id, { body: m.body, at: m.created_at, meta: m.meta ?? {}, count: 1 });
    }
  }

  type Hit = { contact: WaContact; adId: string; method: AttributionMethod; enteredAt: string; first: FirstInbound | undefined };
  const hits: Hit[] = [];
  const fromMs = Date.parse(bounds.from);
  const toMs = bounds.to ? Date.parse(bounds.to) : Number.POSITIVE_INFINITY;

  for (const contact of contacts.values()) {
    const first = firsts.get(contact.id);
    // The in-window message evidence first; the lifetime first touch only
    // when it landed inside this campaign's window (resolveAdTouch).
    const touch = resolveAdTouch(
      {
        campaignReferral: campaignRefs.get(contact.id) ?? null,
        firstInboundReferral: parseReferral(first?.meta?.referral),
        firstInboundAt: first?.at ?? null,
        storedAdSourceId: contact.ad_source_id,
        storedEnteredAt: contact.ad_entered_at,
        createdAt: contact.created_at,
      },
      ctx.flight,
    );
    const hit = attributeContact(
      {
        adSourceId: touch.adSourceId,
        firstInboundBody: first?.body ?? null,
        createdAt: contact.created_at,
        enteredAt: touch.enteredAt,
      },
      { adIds, prefills, start: ctx.flight.start, end: ctx.flight.end },
    );
    const enteredAt = touch.enteredAt;
    const at = Date.parse(enteredAt);
    // The campaign's bounds are checked above; a 7d/30d window narrows them.
    if (!hit.adId || !hit.method || at < fromMs || at > toMs) continue;
    hits.push({ contact, adId: hit.adId, method: hit.method, enteredAt, first });
  }

  // The leads they became, for "qualified" (a hot score) and the title.
  const leadIds = [...new Set(hits.map((h) => h.contact.lead_id).filter((id): id is string => Boolean(id)))];
  const leads = new Map<string, { title: string; score: string | null }>();
  const leadBatches = await Promise.all(
    chunk(leadIds, 100).map((ids) =>
      supabase
        .from("leads")
        .select("id, title, score")
        .in("id", ids)
        .then((res) => check(res) ?? []),
    ),
  );
  for (const rows of leadBatches) for (const l of rows) leads.set(l.id, { title: l.title, score: l.score });

  const outcomes: ContactOutcome[] = [];
  const conversations: ConversationRow[] = [];
  for (const h of hits.sort((a, b) => b.enteredAt.localeCompare(a.enteredAt))) {
    const c = h.contact;
    const lead = c.lead_id ? leads.get(c.lead_id) : undefined;
    // call_booked_at is the agreed SLOT. For a returning contact an old slot
    // from before the ad is not this campaign's booking.
    const booked = Boolean(c.call_booked_at && c.call_booked_at >= h.enteredAt);
    const outcome: ContactOutcome = {
      adId: h.adId,
      method: h.method,
      replied: (h.first?.count ?? 0) >= 2,
      inCrm: Boolean(c.lead_id),
      qualified: booked || lead?.score === "hot",
      booked,
    };
    outcomes.push(outcome);
    if (conversations.length < CONVERSATION_ROWS) {
      conversations.push({
        contactId: c.id,
        name: c.display_name || c.profile_name || `+${c.wa_id}`,
        firstMessage: h.first?.body?.slice(0, 160) ?? null,
        adId: h.adId,
        adLetter: ctx.letters.get(h.adId) ?? "?",
        adName: ctx.adById.get(h.adId)?.name ?? h.adId,
        method: h.method,
        replied: outcome.replied,
        leadId: c.lead_id,
        leadTitle: lead?.title ?? null,
        leadScore: lead?.score ?? null,
        bookedAt: booked ? c.call_booked_at : null,
        enteredAt: h.enteredAt,
        href: `/inbox?thread=whatsapp:${c.id}`,
      });
    }
  }

  return {
    outcomes,
    conversations,
    capped: windowContacts.length >= CONTACT_CAP || referredRows.length >= CONTACT_CAP,
  };
}
