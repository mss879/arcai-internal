/**
 * Is this campaign healthy? (0132)
 *
 * A short list of rules over the numbers /ads already shows, each one a
 * thing the owner would otherwise have to notice by reading every card:
 * a sync gone stale, an ad stuck in review, money going out with no chats
 * coming in, chats coming in with no calls booked.
 *
 * Ordered by what to do first (act → watch → good), so the top line is
 * always the most urgent. The thresholds are named constants because every
 * one of them is a judgement call someone will want to move.
 *
 * Money thresholds are in the ad account's currency — LKR for the only
 * account today. The rules never convert; they compare the numbers they are
 * given. `currency` is used only to write the sentences.
 *
 * Pure: `now` is an argument, never read from the clock.
 */

export type HealthLevel = "good" | "watch" | "act";

export type HealthSignal = {
  level: HealthLevel;
  code: string;
  title: string;
  detail: string;
};

/** Hours without a sync before the numbers are called stale / unusable. */
export const SYNC_STALE_WATCH_HOURS = 24;
export const SYNC_STALE_ACT_HOURS = 48;
/** Hours into a flight with zero impressions before it is a delivery problem. */
export const NO_DELIVERY_HOURS = 6;
/** Hours before the end when "ending soon" is raised. */
export const ENDING_SOON_HOURS = 24;
/** Link CTR (%) below which the creative is not earning the tap… */
export const LOW_CTR_PERCENT = 0.8;
/** …once there are enough impressions for the rate to mean anything. */
export const LOW_CTR_MIN_IMPRESSIONS = 1_000;
/** Average times each person has seen it; above this, the audience tires. */
export const HIGH_FREQUENCY = 3;
/** Cost per WhatsApp conversation (account currency) worth a look… */
export const COST_PER_CONVERSATION_WATCH = 900;
/** …and the level at which to change something now. */
export const COST_PER_CONVERSATION_ACT = 1_500;
/** Conversations needed before cost per conversation is judged at all. */
export const COST_MIN_CONVERSATIONS = 3;
/** Ad contacts in the CRM with nothing booked before the agent is suspect. */
export const NO_BOOKINGS_MIN_CONTACTS = 5;
/** Meta's conversation count vs. contacts the CRM credited, as a fraction. */
export const ATTRIBUTION_GAP_RATIO = 0.5;
export const ATTRIBUTION_GAP_MIN = 5;
/** Spend below this share of the daily budget, after a full day, is under-delivery. */
export const UNDERSPEND_RATIO = 0.5;

export type HealthInput = {
  now: Date;
  currency: string;
  campaign: {
    status: string | null;
    effective_status: string | null;
    start: string | null;
    end: string | null;
    daily_budget: number | null;
  };
  totals: {
    spend: number;
    impressions: number;
    clicks: number;
    link_clicks: number;
    conversations: number;
    frequency: number | null;
  };
  crm: {
    adContacts: number;
    replied: number;
    inCrm: number;
    qualified: number;
    booked: number;
  };
  /** When Claude last synced this account; null = never. */
  lastSyncedAt: string | null;
};

/** `amount / count`, or null when there is nothing to divide by. */
export function costPer(amount: number, count: number): number | null {
  if (!Number.isFinite(amount) || !Number.isFinite(count) || count <= 0) return null;
  return amount / count;
}

/** `part / whole` as a percentage, or null when the whole is empty. */
export function percent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

export type FunnelStage = {
  key: string;
  label: string;
  value: number;
  /** Share of the stage above, 0–100; null for the first stage or an empty one above. */
  ofPrevious: number | null;
  /** Share of the first stage, 0–100. */
  ofFirst: number | null;
  /** Where the number comes from — the two halves are counted by different systems. */
  source: "meta" | "crm";
};

/**
 * Impressions → link clicks → conversations (Meta) → ad contacts → qualified
 * → booked (CRM). The Meta/CRM seam is marked because the two halves are
 * counted by different systems and will never reconcile exactly.
 */
export function computeFunnel(input: {
  impressions: number;
  link_clicks: number;
  conversations: number;
  adContacts: number;
  qualified: number;
  booked: number;
}): FunnelStage[] {
  const stages: Omit<FunnelStage, "ofPrevious" | "ofFirst">[] = [
    { key: "impressions", label: "Impressions", value: input.impressions, source: "meta" },
    { key: "link_clicks", label: "Taps to WhatsApp", value: input.link_clicks, source: "meta" },
    { key: "conversations", label: "Conversations (Meta)", value: input.conversations, source: "meta" },
    { key: "ad_contacts", label: "Ad contacts in CRM", value: input.adContacts, source: "crm" },
    { key: "qualified", label: "Qualified", value: input.qualified, source: "crm" },
    { key: "booked", label: "Calls booked", value: input.booked, source: "crm" },
  ];
  const first = stages[0].value;
  return stages.map((stage, i) => ({
    ...stage,
    ofPrevious: i === 0 ? null : percent(stage.value, stages[i - 1].value),
    ofFirst: percent(stage.value, first),
  }));
}

const HOUR = 3_600_000;
const ORDER: Record<HealthLevel, number> = { act: 0, watch: 1, good: 2 };

function ms(value: string | null): number | null {
  if (!value) return null;
  const out = Date.parse(value);
  return Number.isFinite(out) ? out : null;
}

function money(amount: number, currency: string): string {
  return `${currency} ${Math.round(amount).toLocaleString("en-US")}`;
}

function hours(n: number): string {
  if (n < 48) return `${Math.round(n)}h`;
  return `${Math.round(n / 24)} days`;
}

function isLive(campaign: HealthInput["campaign"]): boolean {
  const s = (campaign.effective_status ?? campaign.status ?? "").toUpperCase();
  return s === "ACTIVE";
}

/**
 * Every signal that applies, most urgent first.
 *
 * Delivery rules judge the numbers AS OF THE LAST SYNC, not as of now: zero
 * impressions in a sync taken an hour after launch says nothing, and the
 * stale-sync rule already speaks for data that is old.
 */
export function healthSignals(input: HealthInput): HealthSignal[] {
  const { campaign, totals, crm, currency } = input;
  const now = input.now.getTime();
  const start = ms(campaign.start);
  const end = ms(campaign.end);
  const synced = ms(input.lastSyncedAt);
  const out: HealthSignal[] = [];
  const add = (level: HealthLevel, code: string, title: string, detail: string) =>
    out.push({ level, code, title, detail });

  // -- the data itself --------------------------------------------------------
  if (synced === null) {
    add("act", "never_synced", "No sync yet", "Nothing has been pulled from Meta for this account. Ask Claude: “sync my ads”.");
  } else {
    const age = (now - synced) / HOUR;
    // Once the flight is over and a sync landed after it, the numbers are final.
    const final = end !== null && now > end && synced >= end;
    if (!final && age > SYNC_STALE_ACT_HOURS) {
      add("act", "sync_stale", "Numbers are out of date", `Last synced ${hours(age)} ago — every figure below is older than that. Ask Claude to sync.`);
    } else if (!final && age > SYNC_STALE_WATCH_HOURS) {
      add("watch", "sync_stale", "Numbers are a day old", `Last synced ${hours(age)} ago. Ask Claude to sync before deciding anything.`);
    }
  }

  // -- delivery ---------------------------------------------------------------
  const effective = (campaign.effective_status ?? "").toUpperCase();
  if (effective === "DISAPPROVED" || effective === "WITH_ISSUES") {
    add("act", "delivery_blocked", "Meta has stopped delivery", `Status is ${effective.toLowerCase().replace(/_/g, " ")} — open Ads Manager and fix the flagged ad.`);
  } else if (effective === "PENDING_REVIEW" || effective === "IN_PROCESS") {
    add("watch", "in_review", "Still in review", "Meta has not approved delivery yet. Nothing is spending, and nothing will arrive until it does.");
  }

  if (isLive(campaign) && start !== null && synced !== null && synced - start >= NO_DELIVERY_HOURS * HOUR && totals.impressions === 0) {
    add("act", "no_delivery", "Live but not delivering", `Zero impressions ${hours((synced - start) / HOUR)} after the start. Usually review, a payment problem or an audience too narrow to serve — check the ad set in Ads Manager.`);
  }

  if (end !== null && now > end) {
    add("watch", "ended", "Flight has ended", "Decide from calls booked, not cost per chat: extend it, change the creative, or stop.");
  } else if (end !== null && end - now <= ENDING_SOON_HOURS * HOUR && isLive(campaign)) {
    add("watch", "ending_soon", "Ends within a day", `Ends in ${hours((end - now) / HOUR)}. If it is booking calls, extend it before it stops.`);
  }

  if (isLive(campaign) && campaign.daily_budget && campaign.daily_budget > 0 && start !== null && synced !== null) {
    const liveDays = (Math.min(synced, end ?? synced) - start) / (24 * HOUR);
    const expected = campaign.daily_budget * liveDays;
    if (liveDays >= 1 && totals.spend < expected * UNDERSPEND_RATIO) {
      add("watch", "underspend", "Spending under budget", `${money(totals.spend, currency)} spent over ${liveDays.toFixed(1)} days on a ${money(campaign.daily_budget, currency)}/day budget — the audience may be too small to fill it.`);
    }
  }

  // -- creative and audience --------------------------------------------------
  const ctr = percent(totals.link_clicks, totals.impressions);
  if (ctr !== null && totals.impressions >= LOW_CTR_MIN_IMPRESSIONS && ctr < LOW_CTR_PERCENT) {
    add("watch", "low_ctr", "Few people tap it", `Link CTR is ${ctr.toFixed(2)}% over ${totals.impressions.toLocaleString("en-US")} impressions (watch below ${LOW_CTR_PERCENT}%). The image or first line is not earning the tap.`);
  }

  if (totals.frequency !== null && totals.frequency > HIGH_FREQUENCY) {
    add("watch", "high_frequency", "Same people, again and again", `Frequency ${totals.frequency.toFixed(1)} — the audience is seeing it more than ${HIGH_FREQUENCY} times. Widen it or refresh the creative.`);
  }

  // -- cost -------------------------------------------------------------------
  const perConversation = costPer(totals.spend, totals.conversations);
  if (totals.conversations === 0 && totals.spend >= COST_PER_CONVERSATION_ACT) {
    add("act", "spend_no_conversations", "Spending with no chats", `${money(totals.spend, currency)} spent and not one conversation started. Check the ad opens WhatsApp on the right number.`);
  } else if (perConversation !== null && totals.conversations >= COST_MIN_CONVERSATIONS) {
    if (perConversation > COST_PER_CONVERSATION_ACT) {
      add("act", "cost_per_conversation", "Chats are too expensive", `${money(perConversation, currency)} per conversation (act above ${money(COST_PER_CONVERSATION_ACT, currency)}). Tighten the audience or change the creative.`);
    } else if (perConversation > COST_PER_CONVERSATION_WATCH) {
      add("watch", "cost_per_conversation", "Chats cost more than usual", `${money(perConversation, currency)} per conversation (watch above ${money(COST_PER_CONVERSATION_WATCH, currency)}).`);
    } else {
      add("good", "cost_per_conversation", "Chats at a healthy cost", `${money(perConversation, currency)} per conversation over ${totals.conversations}.`);
    }
  }

  // -- what the CRM made of them ----------------------------------------------
  if (crm.booked >= 1) {
    const perBooked = costPer(totals.spend, crm.booked);
    add("good", "booked", `${crm.booked} call${crm.booked === 1 ? "" : "s"} booked`, perBooked !== null ? `${money(perBooked, currency)} per booked call — the number to decide on.` : "Calls are being booked from this campaign.");
  } else if (crm.adContacts >= NO_BOOKINGS_MIN_CONTACTS) {
    add("act", "no_bookings", "Chats, but no calls booked", `${crm.adContacts} people wrote in from the ad and none booked. Read their threads: the agent's qualification or its ask for the call is where it breaks.`);
  }

  const larger = Math.max(totals.conversations, crm.adContacts);
  if (larger >= ATTRIBUTION_GAP_MIN && Math.abs(totals.conversations - crm.adContacts) / larger > ATTRIBUTION_GAP_RATIO) {
    add("watch", "attribution_gap", "Meta and the CRM disagree", `Meta counts ${totals.conversations} conversations; the CRM credited ${crm.adContacts} contacts to these ads. Some chats are arriving without a referral or with an edited prefill — or on a different number.`);
  }

  return out
    .map((signal, index) => ({ signal, index }))
    .sort((a, b) => ORDER[a.signal.level] - ORDER[b.signal.level] || a.index - b.index)
    .map(({ signal }) => signal);
}

/** The single worst level in a list — what a header badge shows. */
export function worstLevel(signals: HealthSignal[]): HealthLevel | null {
  if (!signals.length) return null;
  return signals.reduce<HealthLevel>(
    (worst, s) => (ORDER[s.level] < ORDER[worst] ? s.level : worst),
    "good",
  );
}
