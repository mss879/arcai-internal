import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  colomboDay,
  colomboHour,
  colomboPeriod,
  daysBetween,
  monthStart,
  nextPeriod,
  periodEnd,
  periodLabel,
  previousPeriod,
} from "./time-core";

describe("Colombo calendar", () => {
  it("rolls the day over at Colombo midnight, not UTC midnight", () => {
    // 18:31 UTC is 00:01 the next day in Colombo (UTC+5:30).
    expect(colomboDay(new Date("2026-09-30T18:31:00Z"))).toBe("2026-10-01");
    expect(colomboDay(new Date("2026-09-30T18:29:00Z"))).toBe("2026-09-30");
    expect(colomboHour(new Date("2026-09-30T18:31:00Z"))).toBe(0);
    expect(colomboHour(new Date("2026-09-30T00:31:00Z"))).toBe(6);
  });

  it("places late-evening usage on the right month's bill", () => {
    expect(colomboPeriod(new Date("2026-09-30T18:31:00Z"))).toBe("2026-10-01");
    expect(colomboPeriod(new Date("2026-09-30T17:00:00Z"))).toBe("2026-09-01");
  });

  it("walks months across year ends", () => {
    expect(previousPeriod("2026-01-01")).toBe("2025-12-01");
    expect(nextPeriod("2026-12-01")).toBe("2027-01-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
    expect(periodEnd("2026-02-01")).toBe("2026-02-28");
    expect(periodEnd("2028-02-01")).toBe("2028-02-29");
    expect(monthStart("2026-09-17")).toBe("2026-09-01");
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-09-29", "2026-10-01")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    expect(daysBetween("2026-10-02", "2026-10-01")).toEqual([]);
  });

  it("labels a period in words", () => {
    expect(periodLabel("2026-09-01")).toBe("September 2026");
  });
});
