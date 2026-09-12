import { describe, expect, it } from "vitest";

import {
  COST_PER_CONVERSATION_ACT,
  COST_PER_CONVERSATION_WATCH,
  computeFunnel,
  costPer,
  healthSignals,
  percent,
  worstLevel,
  type HealthInput,
} from "./health-core";

const START = "2026-09-12T19:10:00+05:30";
const END = "2026-09-15T23:59:00+05:30";

/** Day two of the live flight, going well: the baseline every test bends. */
function input(overrides: {
  now?: string;
  campaign?: Partial<HealthInput["campaign"]>;
  totals?: Partial<HealthInput["totals"]>;
  crm?: Partial<HealthInput["crm"]>;
  lastSyncedAt?: string | null;
} = {}): HealthInput {
  return {
    now: new Date(overrides.now ?? "2026-09-13T22:00:00+05:30"),
    currency: "LKR",
    campaign: {
      status: "ACTIVE",
      effective_status: "ACTIVE",
      start: START,
      end: END,
      daily_budget: 2500,
      ...overrides.campaign,
    },
    totals: {
      spend: 2812.5,
      impressions: 5854,
      clicks: 113,
      link_clicks: 62,
      conversations: 6,
      frequency: 1.4,
      ...overrides.totals,
    },
    crm: { adContacts: 6, replied: 4, inCrm: 3, qualified: 2, booked: 1, ...overrides.crm },
    lastSyncedAt: overrides.lastSyncedAt === undefined ? "2026-09-13T21:00:00+05:30" : overrides.lastSyncedAt,
  };
}

const codes = (i: HealthInput) => healthSignals(i).map((s) => `${s.level}:${s.code}`);

describe("healthSignals — a healthy day", () => {
  it("says only good things", () => {
    expect(codes(input())).toEqual(["good:cost_per_conversation", "good:booked"]);
  });

  it("quotes the cost per booked call, the number to decide on", () => {
    const booked = healthSignals(input()).find((s) => s.code === "booked")!;
    expect(booked.detail).toContain("LKR 2,813 per booked call");
  });
});

describe("healthSignals — the data", () => {
  it("acts when nothing was ever synced", () => {
    expect(codes(input({ lastSyncedAt: null }))).toContain("act:never_synced");
  });

  it("watches a day-old sync and acts on a two-day-old one", () => {
    expect(codes(input({ lastSyncedAt: "2026-09-12T20:00:00+05:30" }))).toContain("watch:sync_stale");
    expect(codes(input({ now: "2026-09-15T22:00:00+05:30" }))).toContain("act:sync_stale");
  });

  it("does not call final numbers stale", () => {
    const after = input({ now: "2026-09-25T10:00:00+05:30", lastSyncedAt: "2026-09-16T09:00:00+05:30" });
    expect(codes(after).some((c) => c.endsWith("sync_stale"))).toBe(false);
  });
});

describe("healthSignals — delivery", () => {
  it("acts on a live campaign with zero impressions six hours in", () => {
    const stuck = input({
      totals: { spend: 0, impressions: 0, clicks: 0, link_clicks: 0, conversations: 0, frequency: null },
      crm: { adContacts: 0, replied: 0, inCrm: 0, qualified: 0, booked: 0 },
      now: "2026-09-13T02:00:00+05:30",
      lastSyncedAt: "2026-09-13T01:30:00+05:30",
    });
    expect(codes(stuck)).toContain("act:no_delivery");
  });

  it("says nothing about delivery from a sync taken an hour after launch", () => {
    const early = input({
      totals: { spend: 0, impressions: 0, clicks: 0, link_clicks: 0, conversations: 0, frequency: null },
      crm: { adContacts: 0, replied: 0, inCrm: 0, qualified: 0, booked: 0 },
      now: "2026-09-12T20:30:00+05:30",
      lastSyncedAt: "2026-09-12T20:10:00+05:30",
    });
    expect(codes(early)).not.toContain("act:no_delivery");
  });

  it("flags review and disapproval", () => {
    expect(codes(input({ campaign: { effective_status: "PENDING_REVIEW" } }))).toContain("watch:in_review");
    expect(codes(input({ campaign: { effective_status: "DISAPPROVED" } }))).toContain("act:delivery_blocked");
  });

  it("watches the last day, and the end", () => {
    expect(codes(input({ now: "2026-09-15T10:00:00+05:30", lastSyncedAt: "2026-09-15T09:00:00+05:30" }))).toContain(
      "watch:ending_soon",
    );
    expect(codes(input({ now: "2026-09-16T10:00:00+05:30", lastSyncedAt: "2026-09-16T09:00:00+05:30" }))).toContain(
      "watch:ended",
    );
  });

  it("watches a campaign spending well under its daily budget", () => {
    expect(codes(input({ totals: { spend: 900 } }))).toContain("watch:underspend");
    expect(codes(input())).not.toContain("watch:underspend");
  });
});

describe("healthSignals — creative, audience, cost", () => {
  it("watches a link CTR under 0.8% once there are 1,000 impressions", () => {
    expect(codes(input({ totals: { impressions: 5000, link_clicks: 30 } }))).toContain("watch:low_ctr");
    expect(codes(input({ totals: { impressions: 900, link_clicks: 1 } }))).not.toContain("watch:low_ctr");
  });

  it("watches frequency above 3", () => {
    expect(codes(input({ totals: { frequency: 3.4 } }))).toContain("watch:high_frequency");
    expect(codes(input({ totals: { frequency: 3 } }))).not.toContain("watch:high_frequency");
  });

  it("grades cost per conversation once there are three", () => {
    const at = (spend: number, conversations: number) =>
      codes(input({ totals: { spend, conversations } })).find((c) => c.endsWith("cost_per_conversation"));
    expect(at(COST_PER_CONVERSATION_WATCH * 3 + 30, 3)).toBe("watch:cost_per_conversation");
    expect(at(COST_PER_CONVERSATION_ACT * 3 + 30, 3)).toBe("act:cost_per_conversation");
    expect(at(COST_PER_CONVERSATION_ACT * 2 + 30, 2)).toBeUndefined();
    expect(at(1800, 3)).toBe("good:cost_per_conversation");
  });

  it("acts on money out with no chats in", () => {
    expect(codes(input({ totals: { spend: 1600, conversations: 0 } }))).toContain("act:spend_no_conversations");
  });
});

describe("healthSignals — what the CRM made of it", () => {
  it("acts when five ad contacts booked nothing", () => {
    expect(codes(input({ crm: { adContacts: 5, booked: 0 } }))).toContain("act:no_bookings");
    expect(codes(input({ crm: { adContacts: 4, booked: 0 } }))).not.toContain("act:no_bookings");
  });

  it("watches Meta and the CRM disagreeing by more than half", () => {
    expect(codes(input({ totals: { conversations: 12 }, crm: { adContacts: 4 } }))).toContain(
      "watch:attribution_gap",
    );
    expect(codes(input({ totals: { conversations: 6 }, crm: { adContacts: 5 } }))).not.toContain(
      "watch:attribution_gap",
    );
  });
});

describe("healthSignals — order", () => {
  it("puts act before watch before good", () => {
    const levels = healthSignals(
      input({ totals: { frequency: 4 }, crm: { adContacts: 6, booked: 0 }, lastSyncedAt: null }),
    ).map((s) => s.level);
    expect(levels).toEqual([...levels].sort((a, b) => ["act", "watch", "good"].indexOf(a) - ["act", "watch", "good"].indexOf(b)));
    expect(levels[0]).toBe("act");
  });

  it("worstLevel picks the most urgent", () => {
    expect(worstLevel([])).toBeNull();
    expect(worstLevel(healthSignals(input()))).toBe("good");
    expect(worstLevel(healthSignals(input({ lastSyncedAt: null })))).toBe("act");
  });
});

describe("costPer / percent", () => {
  it("never divides by zero", () => {
    expect(costPer(100, 0)).toBeNull();
    expect(costPer(100, -1)).toBeNull();
    expect(costPer(Number.NaN, 2)).toBeNull();
    expect(costPer(100, 4)).toBe(25);
    expect(percent(1, 0)).toBeNull();
    expect(percent(1, 4)).toBe(25);
  });
});

describe("computeFunnel", () => {
  it("runs Meta's stages into the CRM's, with rates against the stage above", () => {
    const f = computeFunnel({
      impressions: 5000,
      link_clicks: 50,
      conversations: 10,
      adContacts: 8,
      qualified: 4,
      booked: 2,
    });
    expect(f.map((s) => s.key)).toEqual([
      "impressions",
      "link_clicks",
      "conversations",
      "ad_contacts",
      "qualified",
      "booked",
    ]);
    expect(f.map((s) => s.source)).toEqual(["meta", "meta", "meta", "crm", "crm", "crm"]);
    expect(f[0].ofPrevious).toBeNull();
    expect(f[1].ofPrevious).toBe(1);
    expect(f[5].ofPrevious).toBe(50);
    expect(f[5].ofFirst).toBe(0.04);
  });

  it("is null-safe on an empty funnel", () => {
    const f = computeFunnel({ impressions: 0, link_clicks: 0, conversations: 0, adContacts: 0, qualified: 0, booked: 0 });
    expect(f.every((s) => s.ofFirst === null)).toBe(true);
  });
});
