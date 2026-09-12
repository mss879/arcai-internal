import { describe, expect, it } from "vitest";

import {
  adLetters,
  contactBounds,
  crmByAd,
  crmTotals,
  dailySeries,
  effectiveFlight,
  formatColombo,
  formatMoney,
  parseWindowKey,
  resolveWindow,
  rowsForTotals,
  sumInsights,
  totalsByEntity,
  type ContactOutcome,
  type InsightRowLike,
} from "./report-core";

const FLIGHT = { start: "2026-09-12T19:10:00+05:30", end: "2026-09-15T23:59:00+05:30" };

function row(level: string, entity_id: string, date: string, spend: number, extra: Partial<InsightRowLike> = {}): InsightRowLike {
  return { level, entity_id, date, spend, impressions: 0, reach: 0, clicks: 0, link_clicks: 0, conversations: 0, ...extra };
}

describe("windows", () => {
  it("defaults anything unknown to the flight", () => {
    expect(parseWindowKey("7d")).toBe("7d");
    expect(parseWindowKey("30d")).toBe("30d");
    expect(parseWindowKey("90d")).toBe("flight");
    expect(parseWindowKey(undefined)).toBe("flight");
  });

  it("runs the flight from its first Colombo day, cut at today while live", () => {
    expect(resolveWindow("flight", FLIGHT, "2026-09-13")).toEqual({ from: "2026-09-12", to: "2026-09-13" });
    expect(resolveWindow("flight", FLIGHT, "2026-09-30")).toEqual({ from: "2026-09-12", to: "2026-09-15" });
  });

  it("reads the start in Colombo, not UTC — 01:00 Colombo is the previous UTC day", () => {
    expect(resolveWindow("flight", { start: "2026-09-12T01:00:00+05:30", end: null }, "2026-09-13").from).toBe(
      "2026-09-12",
    );
  });

  it("is a one-day range on the start day before the flight begins", () => {
    expect(resolveWindow("flight", FLIGHT, "2026-09-10")).toEqual({ from: "2026-09-12", to: "2026-09-12" });
  });

  it("gives trailing 7 and 30 day windows ending today", () => {
    expect(resolveWindow("7d", FLIGHT, "2026-09-13")).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    expect(resolveWindow("30d", FLIGHT, "2026-09-13")).toEqual({ from: "2026-08-15", to: "2026-09-13" });
  });

  it("survives a campaign with unreadable dates", () => {
    expect(resolveWindow("flight", { start: "nope", end: null }, "2026-09-13")).toEqual({
      from: "2026-08-15",
      to: "2026-09-13",
    });
  });
});

describe("effectiveFlight", () => {
  const blank = { start_time: null, end_time: null, daily_budget: null };
  const adset = (start: string | null, end: string | null, budget: number | null) => ({
    start_time: start,
    end_time: end,
    daily_budget: budget,
  });

  it("keeps the campaign's own dates and budget", () => {
    expect(
      effectiveFlight({ start_time: FLIGHT.start, end_time: FLIGHT.end, daily_budget: 2500 }, [
        adset("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", 900),
      ]),
    ).toEqual({ start: FLIGHT.start, end: FLIGHT.end, daily_budget: 2500 });
  });

  it("falls back to the ad sets when the campaign row carries none (no CBO, stop_time unmapped)", () => {
    expect(
      effectiveFlight(blank, [
        adset("2026-09-13T00:00:00+05:30", "2026-09-14T23:59:00+05:30", 1000),
        adset(FLIGHT.start, FLIGHT.end, 1500),
      ]),
    ).toEqual({ start: FLIGHT.start, end: FLIGHT.end, daily_budget: 2500 });
  });

  it("is open-ended when any ad set is", () => {
    expect(effectiveFlight(blank, [adset(FLIGHT.start, FLIGHT.end, null), adset(FLIGHT.start, null, null)]).end).toBeNull();
  });

  it("stays null with no ad sets to fall back on", () => {
    expect(effectiveFlight(blank, [])).toEqual({ start: null, end: null, daily_budget: null });
  });
});

describe("contactBounds", () => {
  it("reads the flight's contacts from launch to seven days after the end", () => {
    const range = resolveWindow("flight", FLIGHT, "2026-09-13");
    expect(contactBounds("flight", range, FLIGHT)).toEqual({
      from: "2026-09-12T13:40:00.000Z",
      to: "2026-09-22T18:29:00.000Z",
    });
  });

  it("cuts a trailing window to what the campaign could have produced", () => {
    const range = resolveWindow("7d", FLIGHT, "2026-09-13");
    expect(contactBounds("7d", range, FLIGHT)).toEqual({
      from: "2026-09-12T13:40:00.000Z",
      to: "2026-09-13T18:30:00.000Z",
    });
  });

  it("is open-ended for an open-ended campaign's flight", () => {
    expect(contactBounds("flight", { from: "2026-09-12", to: "2026-09-13" }, { start: FLIGHT.start, end: null }).to).toBeNull();
  });
});

describe("rowsForTotals", () => {
  it("sums a day from its campaign row, not its campaign AND ad rows", () => {
    const rows = [
      row("campaign", "c", "2026-09-12", 300),
      row("ad", "a", "2026-09-12", 200),
      row("ad", "b", "2026-09-12", 100),
    ];
    expect(sumInsights(rowsForTotals(rows)).spend).toBe(300);
  });

  it("falls back to the ad rows for a day with no campaign row", () => {
    const rows = [
      row("campaign", "c", "2026-09-12", 300),
      row("ad", "a", "2026-09-13", 200),
      row("ad", "b", "2026-09-13", 100.5),
    ];
    expect(sumInsights(rowsForTotals(rows)).spend).toBe(600.5);
  });
});

describe("sumInsights", () => {
  it("adds up and derives the ratios from the totals", () => {
    const t = sumInsights([
      row("campaign", "c", "2026-09-12", 312.5, { impressions: 653, reach: 598, clicks: 16, link_clicks: 9, conversations: 1 }),
      row("campaign", "c", "2026-09-13", 2500, { impressions: 5201, reach: 3802, clicks: 97, link_clicks: 53, conversations: 5 }),
    ]);
    expect(t.spend).toBe(2812.5);
    expect(t.impressions).toBe(5854);
    expect(t.conversations).toBe(6);
    expect(t.costPerConversation).toBeCloseTo(468.75);
    expect(t.cpm).toBeCloseTo((2812.5 / 5854) * 1000);
    expect(t.linkCtr).toBeCloseTo((62 / 5854) * 100);
    expect(t.frequency).toBeCloseTo(5854 / 4400);
  });

  it("rounds away float dust in spend", () => {
    expect(sumInsights([row("ad", "a", "d", 0.1), row("ad", "a", "e", 0.2)]).spend).toBe(0.3);
  });

  it("accepts numeric strings (how some drivers return numeric columns)", () => {
    expect(sumInsights([row("ad", "a", "d", "12.50" as unknown as number)]).spend).toBe(12.5);
  });

  it("is null-safe on nothing", () => {
    const t = sumInsights([]);
    expect(t).toMatchObject({ spend: 0, frequency: null, cpm: null, linkCtr: null, costPerConversation: null });
  });
});

describe("dailySeries / totalsByEntity", () => {
  it("has a point for every day, zero where there is no row", () => {
    const series = dailySeries([row("campaign", "c", "2026-09-13", 2500, { conversations: 5 })], {
      from: "2026-09-12",
      to: "2026-09-14",
    });
    expect(series.map((p) => [p.day, p.spend, p.conversations])).toEqual([
      ["2026-09-12", 0, 0],
      ["2026-09-13", 2500, 5],
      ["2026-09-14", 0, 0],
    ]);
  });

  it("totals each entity of one level", () => {
    const byAd = totalsByEntity(
      [row("ad", "a", "d1", 100), row("ad", "a", "d2", 50), row("ad", "b", "d1", 10), row("campaign", "c", "d1", 160)],
      "ad",
    );
    expect(byAd.get("a")?.spend).toBe(150);
    expect(byAd.get("b")?.spend).toBe(10);
    expect(byAd.has("c")).toBe(false);
  });
});

describe("adLetters", () => {
  it("takes the letter from the name when it has one", () => {
    const letters = adLetters([
      { id: "2", name: "Ad B — Enquiry at 9pm" },
      { id: "1", name: "Ad A — Companies with 20+ staff" },
    ]);
    expect(letters.get("1")).toBe("A");
    expect(letters.get("2")).toBe("B");
  });

  it("hands out letters in name order otherwise, skipping claimed ones", () => {
    const letters = adLetters([
      { id: "1", name: "Zebra" },
      { id: "2", name: "Apple" },
      { id: "3", name: "Variant A" },
    ]);
    expect(letters.get("3")).toBe("A");
    expect(letters.get("2")).toBe("B");
    expect(letters.get("1")).toBe("C");
  });
});

describe("formatting", () => {
  it("writes Colombo wall-clock time", () => {
    expect(formatColombo("2026-09-12T13:40:00Z")).toBe("Sat 12 Sep, 19:10");
    expect(formatColombo("2026-09-15T18:29:00Z")).toBe("Tue 15 Sep, 23:59");
    // Just past Colombo midnight: the next day, hour and minute padded.
    expect(formatColombo("2026-09-12T18:35:00Z")).toBe("Sun 13 Sep, 00:05");
    expect(formatColombo(null)).toBe("—");
    expect(formatColombo("garbage")).toBe("—");
  });

  it("writes money in the account currency", () => {
    expect(formatMoney(2471.15, "LKR")).toBe("LKR 2,471");
    expect(formatMoney(2471.15, "LKR", 2)).toBe("LKR 2,471.15");
    expect(formatMoney(null, "LKR")).toBe("—");
    expect(formatMoney(Number.POSITIVE_INFINITY, "LKR")).toBe("—");
  });
});

describe("crmTotals", () => {
  const c = (adId: string, o: Partial<ContactOutcome> = {}): ContactOutcome => ({
    adId,
    method: "prefill",
    replied: false,
    inCrm: false,
    qualified: false,
    booked: false,
    ...o,
  });

  it("counts a booking as qualified even without a hot lead", () => {
    const t = crmTotals([c("a", { booked: true }), c("a", { qualified: true, inCrm: true }), c("b", { replied: true })]);
    expect(t).toEqual({ adContacts: 3, replied: 1, inCrm: 1, qualified: 2, booked: 1 });
  });

  it("splits the same totals by ad", () => {
    const byAd = crmByAd([c("a", { booked: true }), c("a"), c("b")]);
    expect(byAd.get("a")).toMatchObject({ adContacts: 2, booked: 1 });
    expect(byAd.get("b")).toMatchObject({ adContacts: 1, booked: 0 });
  });
});
