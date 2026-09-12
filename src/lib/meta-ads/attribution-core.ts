/**
 * Which ad brought this WhatsApp contact? (0132)
 *
 * Two pieces of evidence, in order of trust:
 *
 *   1. REFERRAL — Meta attaches a `referral` object to the first message
 *      after someone taps a Click-to-WhatsApp ad. Its `source_id` is the ad
 *      id. When present it is proof, so it always wins.
 *   2. PREFILL — every ad pre-types a distinct opening line into the chat
 *      box ("Hi Arc, I'd like to book a call about a Smart Website…"). When
 *      a first message starts with an ad's prefill, that ad opened the chat.
 *      WhatsApp drops the referral often enough (older clients, forwarded
 *      links, the webhook before 0132) that the prefill is the fallback that
 *      keeps the count honest.
 *
 * What it deliberately does NOT use: wa_contacts.campaign_id. That column is
 * "whichever wa_campaigns row was active when they first wrote" — timing,
 * not evidence — and the Sept 2026 row is the same row id the August ad
 * used, so it mixes two campaigns and every organic chat in between.
 *
 * Pure: strings and dates in, answers out. Nothing here reads the database.
 */

/** Days after a campaign ends that a new chat can still be credited to it —
 * people screenshot an ad, or tap it on the last night and write next week. */
export const ATTRIBUTION_GRACE_DAYS = 7;

/**
 * Prefills shorter than this (after normalising) are ignored for matching.
 * A prefill of "Hi" or "Hello" would claim every organic chat that opens
 * with a greeting — silently inflating the ad's numbers is the worse error.
 */
export const MIN_PREFILL_LENGTH = 12;

/** The CTWA referral as Meta sends it, every field optional and trimmed. */
export type AdReferral = {
  source_url: string | null;
  source_id: string | null;
  source_type: string | null;
  headline: string | null;
  body: string | null;
  media_type: string | null;
  image_url: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  ctwa_clid: string | null;
  welcome_message: { text: string } | null;
};

export type AttributionMethod = "referral" | "prefill";

export type Attribution = {
  adId: string | null;
  method: AttributionMethod | null;
};

const NONE: Attribution = { adId: null, method: null };

// Everything WhatsApp keyboards and autocorrect turn a straight quote into.
const SINGLE_QUOTES = /[‘’‚‛′`´]/g;
const DOUBLE_QUOTES = /[“”„‟″«»]/g;
// Punctuation, symbols (emoji included) and the emoji joiners, at either end.
const EDGE_JUNK = /^[\s\p{P}\p{S}️‍]+|[\s\p{P}\p{S}️‍]+$/gu;

/**
 * The comparable form of a chat message.
 *
 * Lower-cased, Unicode-normalised, curly quotes and apostrophes made straight,
 * runs of whitespace collapsed, and punctuation/emoji trimmed from both ends
 * — the edits a phone makes to a prefill without the person meaning to.
 * Interior punctuation stays: "Hi Arc, I'd like" must not equal "Hi Arc Id like"
 * for the prefix test to stay meaningful.
 */
export function normaliseMessage(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .replace(EDGE_JUNK, "")
    .trim();
}

/**
 * The ad whose prefill this first message starts with, or null.
 *
 * Equality, or a prefix that ends on a word boundary — so the person may
 * keep typing after the prefill ("…for our company. We have 40 staff") and
 * still count, but "hi arc" never matches "hi arcade". When one prefill is
 * a prefix of another, the longer (more specific) one wins.
 */
export function matchPrefill(
  firstInboundBody: string | null | undefined,
  ads: { id: string; prefill: string | null | undefined }[],
): string | null {
  const body = normaliseMessage(firstInboundBody);
  if (!body) return null;

  let best: { id: string; length: number } | null = null;
  for (const ad of ads) {
    const prefill = normaliseMessage(ad.prefill);
    if (prefill.length < MIN_PREFILL_LENGTH) continue;
    const hit =
      body === prefill ||
      (body.startsWith(prefill) && !/[\p{L}\p{N}]/u.test(body.charAt(prefill.length)));
    if (hit && (!best || prefill.length > best.length)) {
      best = { id: ad.id, length: prefill.length };
    }
  }
  return best?.id ?? null;
}

const REFERRAL_FIELDS = [
  "source_url",
  "source_id",
  "source_type",
  "headline",
  "body",
  "media_type",
  "image_url",
  "video_url",
  "thumbnail_url",
  "ctwa_clid",
] as const;

/** A string field from untrusted JSON: trimmed, capped, empty → null. */
function str(value: unknown, max = 2000): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const out = String(value).trim();
  return out ? out.slice(0, max) : null;
}

/**
 * The referral object from a webhook message, typed — or null.
 *
 * Defensive because it is Meta's JSON arriving at an endpoint that must
 * always answer 200: anything that is not an object, or carries none of the
 * fields that identify an ad touch (source id, click id, source url), is
 * not a referral worth storing.
 */
export function parseReferral(value: unknown): AdReferral | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;

  const out = {} as AdReferral;
  for (const field of REFERRAL_FIELDS) out[field] = str(input[field]);

  const welcome = input.welcome_message;
  const welcomeText =
    welcome && typeof welcome === "object" && !Array.isArray(welcome)
      ? str((welcome as Record<string, unknown>).text)
      : null;
  out.welcome_message = welcomeText ? { text: welcomeText } : null;

  if (!out.source_id && !out.ctwa_clid && !out.source_url) return null;
  return out;
}

/**
 * Whether a referral is an AD touch (vs. a boosted post or other source),
 * and so may take the contact's first-touch ad slot. A post id in
 * ad_source_id would match no ad and block the real ad that follows.
 */
export function isAdReferral(referral: AdReferral | null): boolean {
  if (!referral || !referral.source_id) return false;
  if (referral.source_type) return referral.source_type.toLowerCase() === "ad";
  // Some deliveries omit source_type; a click id only exists for ad clicks.
  return Boolean(referral.ctwa_clid);
}

function toMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** [start, end + grace] as epoch ms; an open side is null. */
function attributionWindow(campaign: {
  start: string | Date | null;
  end: string | Date | null;
}): { start: number | null; end: number | null } {
  const end = toMs(campaign.end);
  return {
    start: toMs(campaign.start),
    end: end === null ? null : end + ATTRIBUTION_GRACE_DAYS * 86_400_000,
  };
}

/**
 * Which ad touch speaks for this contact in THIS campaign — the
 * `adSourceId` and `enteredAt` to hand attributeContact.
 *
 * The contact's stored first touch (wa_contacts.ad_source_id) is the WRONG
 * thing to trust first: it is first-touch for life, so someone who tapped
 * August's ad keeps August's id forever. When they tap September's ad, the
 * proof is on that message's `meta.referral`, not on the contact. So, in
 * order:
 *
 *   1. a message inside the window whose referral names one of this
 *      campaign's ads — proof, dated by that message;
 *   2. the first in-window message's AD referral naming some other ad —
 *      proof they came from elsewhere, which blocks the prefill;
 *   3. the stored first touch, but only when it landed inside this
 *      campaign's attribution window (a first touch from another time says
 *      nothing about this one);
 *   4. nothing — the prefill decides, dated by when the contact was created.
 */
export function resolveAdTouch(
  evidence: {
    /** Earliest in-window inbound message whose referral names one of the campaign's ads. */
    campaignReferral: { adId: string; at: string } | null;
    /** The referral on the first inbound message in the window, if any. */
    firstInboundReferral: AdReferral | null;
    firstInboundAt: string | null;
    storedAdSourceId: string | null | undefined;
    storedEnteredAt: string | null | undefined;
    createdAt: string;
  },
  campaign: { start: string | Date | null; end: string | Date | null },
): { adSourceId: string | null; enteredAt: string } {
  if (evidence.campaignReferral) {
    return { adSourceId: evidence.campaignReferral.adId, enteredAt: evidence.campaignReferral.at };
  }

  const first = evidence.firstInboundReferral;
  if (isAdReferral(first) && first?.source_id) {
    return { adSourceId: first.source_id, enteredAt: evidence.firstInboundAt ?? evidence.createdAt };
  }

  const stored = evidence.storedAdSourceId?.trim();
  const storedAt = toMs(evidence.storedEnteredAt);
  if (stored && storedAt !== null) {
    const { start, end } = attributionWindow(campaign);
    const inside = (start === null || storedAt >= start) && (end === null || storedAt <= end);
    if (inside) return { adSourceId: stored, enteredAt: evidence.storedEnteredAt as string };
  }

  return { adSourceId: null, enteredAt: evidence.createdAt };
}

/**
 * Credit one contact to one of a campaign's ads, or to none.
 *
 * `enteredAt` is when the referral landed (wa_contacts.ad_entered_at); it
 * falls back to `createdAt`. A contact counts only if that moment is inside
 * [campaign start, campaign end + ATTRIBUTION_GRACE_DAYS]; an open-ended
 * campaign has no upper bound.
 *
 * A referral to an ad OUTSIDE this campaign is proof they came from
 * elsewhere, so it returns none rather than falling through to the prefill.
 * Pass the touch resolveAdTouch picked, not the contact's lifetime first
 * touch — otherwise an old ad's id would block every later campaign.
 */
export function attributeContact(
  contact: {
    adSourceId: string | null | undefined;
    firstInboundBody: string | null | undefined;
    createdAt: string | Date;
    enteredAt?: string | Date | null;
  },
  campaign: {
    adIds: string[];
    prefills: { id: string; prefill: string | null | undefined }[];
    start: string | Date | null;
    end: string | Date | null;
  },
): Attribution {
  const at = toMs(contact.enteredAt) ?? toMs(contact.createdAt);
  if (at === null) return NONE;

  const { start, end } = attributionWindow(campaign);
  if (start !== null && at < start) return NONE;
  if (end !== null && at > end) return NONE;

  const sourceId = contact.adSourceId?.trim();
  if (sourceId) {
    return campaign.adIds.includes(sourceId)
      ? { adId: sourceId, method: "referral" }
      : NONE;
  }

  const adId = matchPrefill(contact.firstInboundBody, campaign.prefills);
  return adId ? { adId, method: "prefill" } : NONE;
}
