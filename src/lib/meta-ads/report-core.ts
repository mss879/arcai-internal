/**
 * The arithmetic behind /ads (0132): which days a window covers, how daily
 * insight rows become totals, and how attributed contacts become the CRM
 * half of the funnel.
 *
 * Kept apart from the loader so every number on the page is a function of
 * its inputs and can be pinned by report-core.test.ts. The loader only
 * fetches; this decides.
 *
 * Days are Asia/Colombo — the ad account's own timezone, which is how Meta
 * buckets `date` with time_increment=1. The only account today is
 * Colombo; a second account elsewhere would need its timezone stored with
 * its entities before these helpers could serve it.
 */

import { addDays, colomboDay, colomboDayStartIso, daysBetween } from "@/lib/ai-projects/time-core";

import { ATTRIBUTION_GRACE_DAYS, type AttributionMethod } from "./attribution-core";
import { costPer, percent } from "./health-core";

export const ADS_TIME_ZONE = "Asia/Colombo";

export type AdsWindowKey = "flight" | "7d" | "30d";
export const ADS_WINDOWS: AdsWindowKey[] = ["flight", "7d", "30d"];

/** Anything unrecognised is the flight — the window the campaign is judged on. */
export function parseWindowKey(value: unknown): AdsWindowKey {
  return value === "7d" || value === "30d" ? value : "flight";
}

/** An inclusive range of Colombo days, YYYY-MM-DD. */
export type DayRange = { from: string; to: string };

type Bounds = { start: string | null; end: string | null };

function validMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

type FlightSource = {
  start_time: string | null;
  end_time: string | null;
  daily_budget: number | string | null;
};

/**
 * The campaign's flight and daily budget, falling back to its ad sets.
 *
 * Meta keeps these on the ad set unless the campaign uses campaign budget
 * optimisation, and a campaign's end is `stop_time` — so a faithful sync can
 * leave the campaign row's dates and budget null. Without this fallback the
 * flight would be open-ended: attribution never closes, and the "ended",
 * "ending soon" and underspend signals never fire.
 *
 * Start: the earliest ad set start. End: the latest ad set end, or none if
 * any ad set runs open-ended. Budget: the ad sets' daily budgets summed.
 */
export function effectiveFlight(
  campaign: FlightSource,
  adsets: FlightSource[],
): { start: string | null; end: string | null; daily_budget: number | null } {
  const byMs = (values: (string | null)[]) =>
    values
      .map((v) => ({ v, ms: validMs(v) }))
      .filter((x): x is { v: string; ms: number } => x.ms !== null)
      .sort((a, b) => a.ms - b.ms);

  let start = validMs(campaign.start_time) !== null ? campaign.start_time : null;
  if (start === null) start = byMs(adsets.map((a) => a.start_time))[0]?.v ?? null;

  let end = validMs(campaign.end_time) !== null ? campaign.end_time : null;
  if (end === null && adsets.length && adsets.every((a) => validMs(a.end_time) !== null)) {
    end = byMs(adsets.map((a) => a.end_time)).at(-1)?.v ?? null;
  }

  const own = Number(campaign.daily_budget);
  let dailyBudget: number | null = campaign.daily_budget !== null && Number.isFinite(own) && own > 0 ? own : null;
  if (dailyBudget === null) {
    const budgets = adsets.map((a) => Number(a.daily_budget)).filter((n) => Number.isFinite(n) && n > 0);
    dailyBudget = budgets.length ? round2(budgets.reduce((n, b) => n + b, 0)) : null;
  }

  return { start, end, daily_budget: dailyBudget };
}

/**
 * The days a window covers.
 *
 * "flight" runs from the campaign's first Colombo day to its last, cut at
 * today while it is still running (tomorrow has no numbers). 7d and 30d are
 * trailing windows ending today, whatever the campaign's dates.
 */
export function resolveWindow(key: AdsWindowKey, campaign: Bounds, today: string): DayRange {
  if (key === "7d") return { from: addDays(today, -6), to: today };
  if (key === "30d") return { from: addDays(today, -29), to: today };

  const start = validMs(campaign.start);
  const end = validMs(campaign.end);
  const from = start !== null ? colomboDay(new Date(start)) : addDays(today, -29);
  const last = end !== null ? colomboDay(new Date(end)) : today;
  const to = last < today ? last : today;
  // Not started yet: a one-day range on the start day, which reads as empty.
  return { from, to: to < from ? from : to };
}

/**
 * The instants CRM contacts are read between, as ISO strings (`to` null =
 * open-ended).
 *
 * For the flight it is the attribution window itself — start to end plus
 * the grace days — because a chat on day 3 after the ad stopped still came
 * from the ad. For 7d/30d it is those days, cut to the same bounds, so a
 * contact is never shown for a window its campaign cannot have produced.
 */
export function contactBounds(
  key: AdsWindowKey,
  range: DayRange,
  campaign: Bounds,
): { from: string; to: string | null } {
  const start = validMs(campaign.start);
  const end = validMs(campaign.end);
  const campaignTo = end !== null ? end + ATTRIBUTION_GRACE_DAYS * 86_400_000 : null;

  if (key === "flight") {
    return {
      from: start !== null ? new Date(start).toISOString() : colomboDayStartIso(range.from),
      to: campaignTo !== null ? new Date(campaignTo).toISOString() : null,
    };
  }

  const rangeFrom = Date.parse(colomboDayStartIso(range.from));
  const rangeTo = Date.parse(colomboDayStartIso(addDays(range.to, 1)));
  const from = start !== null ? Math.max(rangeFrom, start) : rangeFrom;
  const to = campaignTo !== null ? Math.min(rangeTo, campaignTo) : rangeTo;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

// -- insights -------------------------------------------------------------------

export type InsightRowLike = {
  level: string;
  entity_id: string;
  date: string;
  spend: number | string;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  conversations: number;
};

export type InsightTotals = {
  spend: number;
  impressions: number;
  /** Daily reach, summed. Meta de-duplicates people; a sum over days over-counts. */
  reach: number;
  clicks: number;
  link_clicks: number;
  conversations: number;
  /** Impressions ÷ summed daily reach — a floor on the true frequency. */
  frequency: number | null;
  cpm: number | null;
  /** Link clicks ÷ impressions, as a percentage. */
  linkCtr: number | null;
  costPerConversation: number | null;
};

const LEVEL_PRIORITY = ["campaign", "adset", "ad"];

/**
 * The rows a campaign's totals should be summed from.
 *
 * Per day, the highest level present: the campaign row when Meta was asked
 * for one (it is Meta's own number), else the ad sets, else the ads. Summing
 * every level at once would count each rupee two or three times.
 */
export function rowsForTotals<T extends InsightRowLike>(rows: T[]): T[] {
  const byDay = new Map<string, T[]>();
  for (const row of rows) {
    const list = byDay.get(row.date) ?? [];
    list.push(row);
    byDay.set(row.date, list);
  }
  const out: T[] = [];
  for (const list of byDay.values()) {
    const level = LEVEL_PRIORITY.find((l) => list.some((r) => r.level === l));
    out.push(...list.filter((r) => r.level === level));
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Totals over rows of ONE level (see rowsForTotals). Every ratio is null-safe. */
export function sumInsights(rows: InsightRowLike[]): InsightTotals {
  let spend = 0;
  let impressions = 0;
  let reach = 0;
  let clicks = 0;
  let linkClicks = 0;
  let conversations = 0;
  for (const r of rows) {
    spend += Number(r.spend) || 0;
    impressions += Number(r.impressions) || 0;
    reach += Number(r.reach) || 0;
    clicks += Number(r.clicks) || 0;
    linkClicks += Number(r.link_clicks) || 0;
    conversations += Number(r.conversations) || 0;
  }
  spend = round2(spend);
  const cpm = costPer(spend, impressions);
  return {
    spend,
    impressions,
    reach,
    clicks,
    link_clicks: linkClicks,
    conversations,
    frequency: reach > 0 ? impressions / reach : null,
    cpm: cpm === null ? null : cpm * 1000,
    linkCtr: percent(linkClicks, impressions),
    costPerConversation: costPer(spend, conversations),
  };
}

export type DailyPoint = {
  day: string;
  spend: number;
  conversations: number;
  impressions: number;
  link_clicks: number;
};

/** One point per day in the range — a day with no row is a zero, not a gap. */
export function dailySeries(rows: InsightRowLike[], range: DayRange): DailyPoint[] {
  const byDay = new Map<string, InsightRowLike[]>();
  for (const row of rows) {
    const list = byDay.get(row.date) ?? [];
    list.push(row);
    byDay.set(row.date, list);
  }
  return daysBetween(range.from, range.to).map((day) => {
    const t = sumInsights(byDay.get(day) ?? []);
    return {
      day,
      spend: t.spend,
      conversations: t.conversations,
      impressions: t.impressions,
      link_clicks: t.link_clicks,
    };
  });
}

/** Totals per entity, over the rows of one level. */
export function totalsByEntity(rows: InsightRowLike[], level: string): Map<string, InsightTotals> {
  const grouped = new Map<string, InsightRowLike[]>();
  for (const row of rows) {
    if (row.level !== level) continue;
    const list = grouped.get(row.entity_id) ?? [];
    list.push(row);
    grouped.set(row.entity_id, list);
  }
  return new Map([...grouped].map(([id, list]) => [id, sumInsights(list)]));
}

// -- labels ---------------------------------------------------------------------

/**
 * A short letter per ad, so a conversation row can say "A" instead of a
 * forty-character ad name.
 *
 * Taken from the name when it carries one ("Ad A — …", "Variant B"), because
 * that is the letter the owner already calls it by; otherwise handed out in
 * name order, skipping letters a name has already claimed.
 */
export function adLetters(ads: { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...ads].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  for (const ad of sorted) {
    const m = ad.name.match(/\b(?:ad|variant|version)\s*[-_:#]?\s*([a-z])\b/i);
    const letter = m?.[1]?.toUpperCase();
    if (letter && !used.has(letter)) {
      out.set(ad.id, letter);
      used.add(letter);
    }
  }
  let next = 0;
  for (const ad of sorted) {
    if (out.has(ad.id)) continue;
    let label = "";
    do {
      label = next < 26 ? String.fromCharCode(65 + next) : String(next + 1);
      next += 1;
    } while (used.has(label));
    out.set(ad.id, label);
    used.add(label);
  }
  return out;
}

// Only NUMBERS are taken from ICU; the words come from these tables. ICU
// versions disagree on the words — Node's current ICU spells September
// "Sept" in en-GB where many browsers say "Sep" — and the same instant
// rendering two strings on server and client is a hydration mismatch.
const COLOMBO_NUMBERS = new Intl.DateTimeFormat("en-US", {
  timeZone: ADS_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sat 12 Sep, 19:10" in Colombo wall-clock time; "—" for nothing. */
export function formatColombo(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "—";
  const p = Object.fromEntries(
    COLOMBO_NUMBERS.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  // Some engines write midnight as "24" even under h23.
  const hour = String(Number(p.hour) % 24).padStart(2, "0");
  const minute = String(Number(p.minute)).padStart(2, "0");
  return `${weekday} ${d} ${MONTHS[m - 1]}, ${hour}:${minute}`;
}

/**
 * When a sync's numbers were READ from Meta: the payload's synced_at,
 * falling back to when the row was written. "Last synced" and the
 * stale-sync rule use this, so re-running an old payload can never make old
 * numbers look fresh.
 */
export function syncedAtOf(
  sync: { synced_at?: string | null; created_at: string } | null | undefined,
): string | null {
  return sync?.synced_at ?? sync?.created_at ?? null;
}

/** "LKR 2,471" — or "—" when there is no number (a cost with nothing to divide by). */
export function formatMoney(
  amount: number | null | undefined,
  currency: string,
  digits = 0,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

// -- the CRM half ---------------------------------------------------------------

export type ContactOutcome = {
  adId: string;
  method: AttributionMethod;
  /** Wrote again after the ad's opening message — engaged, not just tapped. */
  replied: boolean;
  /** Linked to a lead in the pipeline. */
  inCrm: boolean;
  /** Booked a call, or their lead is scored hot. */
  qualified: boolean;
  booked: boolean;
};

export type CrmTotals = {
  adContacts: number;
  replied: number;
  inCrm: number;
  qualified: number;
  booked: number;
};

export function crmTotals(contacts: ContactOutcome[]): CrmTotals {
  return {
    adContacts: contacts.length,
    replied: contacts.filter((c) => c.replied).length,
    inCrm: contacts.filter((c) => c.inCrm).length,
    // Booked counts as qualified even when nobody scored the lead: a person
    // who agreed to a call has qualified themselves.
    qualified: contacts.filter((c) => c.qualified || c.booked).length,
    booked: contacts.filter((c) => c.booked).length,
  };
}

/** The same totals, per ad. */
export function crmByAd(contacts: ContactOutcome[]): Map<string, CrmTotals> {
  const grouped = new Map<string, ContactOutcome[]>();
  for (const c of contacts) {
    const list = grouped.get(c.adId) ?? [];
    list.push(c);
    grouped.set(c.adId, list);
  }
  return new Map([...grouped].map(([id, list]) => [id, crmTotals(list)]));
}
