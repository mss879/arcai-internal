import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION_GRACE_DAYS,
  attributeContact,
  isAdReferral,
  matchPrefill,
  normaliseMessage,
  parseReferral,
  resolveAdTouch,
  type AdReferral,
} from "./attribution-core";

// The live Sept 2026 Smart Websites campaign — the ads this has to get right.
const AD_A = "120244355303630395";
const AD_B = "120244355304550395";
const PREFILL_A = "Hi Arc, I'd like to book a call about a Smart Website for our company.";
const PREFILL_B = "Hi Arc, our company is missing enquiries. Can we book a call about a Smart Website?";
const ADS = [
  { id: AD_A, prefill: PREFILL_A },
  { id: AD_B, prefill: PREFILL_B },
];
const CAMPAIGN = {
  adIds: [AD_A, AD_B],
  prefills: ADS,
  start: "2026-09-12T19:10:00+05:30",
  end: "2026-09-15T23:59:00+05:30",
};

describe("normaliseMessage", () => {
  it("lower-cases, collapses whitespace and trims end punctuation", () => {
    expect(normaliseMessage("  Hi   Arc,\n\nI'd like a call.  ")).toBe("hi arc, i'd like a call");
  });

  it("straightens the curly apostrophes and quotes phones insert", () => {
    expect(normaliseMessage("I’d like “this”")).toBe(`i'd like "this`);
    expect(normaliseMessage("I‘d")).toBe("i'd");
  });

  it("trims emoji and their joiners at the ends, not in the middle", () => {
    expect(normaliseMessage("👋 Hi Arc 👍🏽")).toBe("hi arc");
    expect(normaliseMessage("Hi 👋 Arc")).toBe("hi 👋 arc");
  });

  it("is empty for nothing", () => {
    expect(normaliseMessage(null)).toBe("");
    expect(normaliseMessage(undefined)).toBe("");
    expect(normaliseMessage("  ?! ")).toBe("");
  });
});

describe("matchPrefill", () => {
  it("matches the prefill sent untouched", () => {
    expect(matchPrefill(PREFILL_A, ADS)).toBe(AD_A);
    expect(matchPrefill(PREFILL_B, ADS)).toBe(AD_B);
  });

  it("survives what a phone does to it: curly apostrophe, case, lost full stop", () => {
    expect(
      matchPrefill("hi arc, I’d like to book a call about a smart website for our company", ADS),
    ).toBe(AD_A);
  });

  it("tolerates the person typing on after the prefill", () => {
    expect(matchPrefill(`${PREFILL_A} We have 40 staff in Colombo.`, ADS)).toBe(AD_A);
    expect(matchPrefill(`${PREFILL_B}\nThanks`, ADS)).toBe(AD_B);
  });

  it("does not match when they rewrote the opening", () => {
    expect(matchPrefill("Hello, I'd like to book a call about a Smart Website", ADS)).toBeNull();
    expect(matchPrefill("Hi Arc", ADS)).toBeNull();
  });

  it("only matches a prefix that ends on a word boundary", () => {
    const ads = [{ id: "1", prefill: "Hi Arc tell me more" }];
    expect(matchPrefill("hi arc tell me more please", ads)).toBe("1");
    expect(matchPrefill("hi arc tell me moreover", ads)).toBeNull();
  });

  it("ignores prefills too short to be evidence", () => {
    expect(matchPrefill("Hello there, what do you do?", [{ id: "1", prefill: "Hello" }])).toBeNull();
  });

  it("prefers the longer prefill when one is a prefix of the other", () => {
    const ads = [
      { id: "short", prefill: "Hi Arc, I'd like to book a call" },
      { id: "long", prefill: "Hi Arc, I'd like to book a call about a Smart Website" },
    ];
    expect(matchPrefill("Hi Arc, I'd like to book a call about a Smart Website!", ads)).toBe("long");
    expect(matchPrefill("Hi Arc, I'd like to book a call today", ads)).toBe("short");
  });

  it("is null for an empty body or no prefills", () => {
    expect(matchPrefill("", ADS)).toBeNull();
    expect(matchPrefill(PREFILL_A, [{ id: "1", prefill: null }])).toBeNull();
  });
});

describe("parseReferral", () => {
  it("rejects anything that is not an object", () => {
    expect(parseReferral(null)).toBeNull();
    expect(parseReferral("ad")).toBeNull();
    expect(parseReferral([{ source_id: "1" }])).toBeNull();
  });

  it("keeps the known fields, trimmed, and drops the rest", () => {
    const r = parseReferral({
      source_url: " https://fb.me/abc ",
      source_id: AD_A,
      source_type: "ad",
      headline: "Smart Websites",
      ctwa_clid: "ARAkLkA8rmlFeiCktEJQ",
      welcome_message: { text: "Hi!" },
      extra: "ignored",
    });
    expect(r).toMatchObject({
      source_url: "https://fb.me/abc",
      source_id: AD_A,
      source_type: "ad",
      headline: "Smart Websites",
      ctwa_clid: "ARAkLkA8rmlFeiCktEJQ",
      body: null,
      welcome_message: { text: "Hi!" },
    });
    expect(r).not.toHaveProperty("extra");
  });

  it("accepts a numeric source id as its string", () => {
    expect(parseReferral({ source_id: 12345 })?.source_id).toBe("12345");
  });

  it("is null when nothing identifies an ad touch", () => {
    expect(parseReferral({ headline: "Just a headline" })).toBeNull();
    expect(parseReferral({ source_id: "  " })).toBeNull();
  });

  it("ignores a malformed welcome message", () => {
    expect(parseReferral({ source_id: "1", welcome_message: "hi" })?.welcome_message).toBeNull();
  });
});

describe("isAdReferral", () => {
  const base = parseReferral({ source_id: AD_A })!;
  it("is true for an ad and false for a post", () => {
    expect(isAdReferral({ ...base, source_type: "ad" })).toBe(true);
    expect(isAdReferral({ ...base, source_type: "AD" })).toBe(true);
    expect(isAdReferral({ ...base, source_type: "post" })).toBe(false);
  });

  it("trusts a click id when the type is missing", () => {
    expect(isAdReferral({ ...base, source_type: null, ctwa_clid: "x" })).toBe(true);
    expect(isAdReferral({ ...base, source_type: null, ctwa_clid: null })).toBe(false);
  });

  it("needs a source id", () => {
    expect(isAdReferral({ ...base, source_id: null, source_type: "ad" })).toBe(false);
    expect(isAdReferral(null)).toBe(false);
  });
});

describe("attributeContact", () => {
  const during = "2026-09-13T10:00:00.000Z";

  it("credits the referral's ad", () => {
    expect(
      attributeContact({ adSourceId: AD_B, firstInboundBody: "hello", createdAt: during }, CAMPAIGN),
    ).toEqual({ adId: AD_B, method: "referral" });
  });

  it("lets the referral win over a prefill for another ad", () => {
    expect(
      attributeContact({ adSourceId: AD_B, firstInboundBody: PREFILL_A, createdAt: during }, CAMPAIGN),
    ).toEqual({ adId: AD_B, method: "referral" });
  });

  it("does not fall back to the prefill when the referral names another campaign's ad", () => {
    expect(
      attributeContact({ adSourceId: "999", firstInboundBody: PREFILL_A, createdAt: during }, CAMPAIGN),
    ).toEqual({ adId: null, method: null });
  });

  it("falls back to the prefill when there is no referral", () => {
    expect(
      attributeContact({ adSourceId: null, firstInboundBody: PREFILL_A, createdAt: during }, CAMPAIGN),
    ).toEqual({ adId: AD_A, method: "prefill" });
  });

  it("credits nothing to an organic first message", () => {
    expect(
      attributeContact({ adSourceId: null, firstInboundBody: "Price for a logo?", createdAt: during }, CAMPAIGN),
    ).toEqual({ adId: null, method: null });
  });

  it("ignores contacts from before the flight — August's ad used the same prefill slot", () => {
    expect(
      attributeContact(
        { adSourceId: null, firstInboundBody: PREFILL_A, createdAt: "2026-08-20T10:00:00Z" },
        CAMPAIGN,
      ),
    ).toEqual({ adId: null, method: null });
  });

  it(`keeps crediting for ${ATTRIBUTION_GRACE_DAYS} days after the end, and no longer`, () => {
    const inGrace = "2026-09-22T12:00:00+05:30";
    const afterGrace = "2026-09-23T00:30:00+05:30";
    expect(
      attributeContact({ adSourceId: null, firstInboundBody: PREFILL_A, createdAt: inGrace }, CAMPAIGN).adId,
    ).toBe(AD_A);
    expect(
      attributeContact({ adSourceId: null, firstInboundBody: PREFILL_A, createdAt: afterGrace }, CAMPAIGN).adId,
    ).toBeNull();
  });

  it("dates a returning contact by when the ad brought them back", () => {
    expect(
      attributeContact(
        {
          adSourceId: AD_A,
          firstInboundBody: "old chat from July",
          createdAt: "2026-07-01T10:00:00Z",
          enteredAt: during,
        },
        CAMPAIGN,
      ),
    ).toEqual({ adId: AD_A, method: "referral" });
  });

  it("has no upper bound for an open-ended campaign", () => {
    expect(
      attributeContact(
        { adSourceId: null, firstInboundBody: PREFILL_A, createdAt: "2027-01-01T00:00:00Z" },
        { ...CAMPAIGN, end: null },
      ).adId,
    ).toBe(AD_A);
  });

  it("credits nothing for an unreadable date", () => {
    expect(
      attributeContact({ adSourceId: AD_A, firstInboundBody: PREFILL_A, createdAt: "not a date" }, CAMPAIGN),
    ).toEqual({ adId: null, method: null });
  });
});

describe("resolveAdTouch", () => {
  const OLD_AD = "120244000000000001"; // August's ad, a different campaign
  const during = "2026-09-13T10:00:00.000Z";
  const adRef = (sourceId: string): AdReferral => ({
    source_url: null,
    source_id: sourceId,
    source_type: "ad",
    headline: null,
    body: null,
    media_type: null,
    image_url: null,
    video_url: null,
    thumbnail_url: null,
    ctwa_clid: "clid",
    welcome_message: null,
  });
  type Evidence = Parameters<typeof resolveAdTouch>[0];
  const none: Evidence = {
    campaignReferral: null,
    firstInboundReferral: null,
    firstInboundAt: null,
    storedAdSourceId: null,
    storedEnteredAt: null,
    createdAt: during,
  };
  // Resolve, then attribute — the way the /ads loader does it.
  const credit = ({ firstBody, ...evidence }: Partial<Evidence> & { firstBody?: string }) => {
    const touch = resolveAdTouch({ ...none, ...evidence }, CAMPAIGN);
    return attributeContact(
      {
        adSourceId: touch.adSourceId,
        firstInboundBody: firstBody ?? null,
        createdAt: evidence.createdAt ?? during,
        enteredAt: touch.enteredAt,
      },
      CAMPAIGN,
    );
  };

  it("credits a returning contact whose first touch was an earlier campaign's ad", () => {
    // The finding: August's id stays on the contact for life; September's
    // tap is proven by the in-window message's referral.
    expect(
      credit({
        createdAt: "2026-08-10T10:00:00Z",
        storedAdSourceId: OLD_AD,
        storedEnteredAt: "2026-08-10T10:00:00Z",
        campaignReferral: { adId: AD_B, at: during },
      }),
    ).toEqual({ adId: AD_B, method: "referral" });
  });

  it("dates the credit by the message that carried the referral", () => {
    expect(
      resolveAdTouch(
        { ...none, createdAt: "2026-07-01T00:00:00Z", campaignReferral: { adId: AD_A, at: during } },
        CAMPAIGN,
      ),
    ).toEqual({ adSourceId: AD_A, enteredAt: during });
  });

  it("ignores a stored first touch from outside this campaign's window, so the prefill still counts", () => {
    // Wrote in during the flight with the prefill (referral dropped), then
    // tapped a LATER campaign's ad after this one's grace ran out.
    expect(
      credit({
        storedAdSourceId: OLD_AD,
        storedEnteredAt: "2026-10-30T10:00:00Z",
        firstBody: PREFILL_A,
      }),
    ).toEqual({ adId: AD_A, method: "prefill" });
  });

  it("still lets an in-window referral to another ad block the prefill", () => {
    expect(
      credit({ firstInboundReferral: adRef(OLD_AD), firstInboundAt: during, firstBody: PREFILL_A }),
    ).toEqual({ adId: null, method: null });
  });

  it("still lets an in-window stored touch to another ad block the prefill", () => {
    expect(
      credit({ storedAdSourceId: OLD_AD, storedEnteredAt: during, firstBody: PREFILL_A }),
    ).toEqual({ adId: null, method: null });
  });

  it("uses the stored touch when the message evidence is missing", () => {
    expect(credit({ storedAdSourceId: AD_A, storedEnteredAt: during })).toEqual({
      adId: AD_A,
      method: "referral",
    });
  });

  it("does not let a boosted-post referral block the prefill", () => {
    const post = { ...adRef("555"), source_type: "post" };
    expect(credit({ firstInboundReferral: post, firstInboundAt: during, firstBody: PREFILL_B })).toEqual({
      adId: AD_B,
      method: "prefill",
    });
  });
});
