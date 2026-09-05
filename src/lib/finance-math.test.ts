import { describe, expect, it } from "vitest";

import {
  forecastCash,
  monthlyInflows,
  monthlyOutflows,
  monthKey,
  recentMonths,
  seriesByMonth,
  totalForMonth,
  weekStart,
} from "./finance-math";

describe("monthlyInflows", () => {
  const sources = {
    payments: [
      { amount: 10_000, paid_at: "2026-09-03", created_at: "2026-09-01T00:00:00Z" },
      // No paid_at: fall back to when the row was made.
      { amount: 5_000, paid_at: null, created_at: "2026-09-20T00:00:00Z" },
    ],
    installments: [
      { amount: 20_000, status: "paid", paid_at: "2026-09-10", due_date: "2026-09-01" },
      // A promise, not money.
      { amount: 99_000, status: "pending", paid_at: null, due_date: "2026-09-15" },
    ],
    recurring: [
      {
        entries: [
          { amount: 7_000, status: "received", received_on: "2026-09-05", due_date: "2026-09-01" },
          { amount: 7_000, status: "pending", received_on: null, due_date: "2026-10-01" },
        ],
      },
    ],
  };

  it("counts only money that actually arrived", () => {
    // A pending instalment in a cash-flow chart is how a month looks fine
    // right up until payroll.
    const rows = monthlyInflows(sources);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(42_000);
    expect(rows.some((r) => r.amount === 99_000)).toBe(false);
  });

  it("dates a payment by when it was paid, not when it was recorded", () => {
    expect(monthlyInflows(sources)[0]).toEqual({ date: "2026-09-03", amount: 10_000 });
  });

  it("falls back to created_at when nothing says when it was paid", () => {
    expect(monthlyInflows(sources)[1]).toEqual({ date: "2026-09-20", amount: 5_000 });
  });

  it("survives junk amounts", () => {
    const rows = monthlyInflows({
      payments: [{ amount: "nope", paid_at: "2026-09-01", created_at: "2026-09-01" }],
      installments: [],
      recurring: [],
    });
    expect(rows[0].amount).toBe(0);
  });
});

describe("monthlyOutflows", () => {
  it("takes an expense at its own date", () => {
    expect(
      monthlyOutflows([{ expense_date: "2026-09-04", amount: "1200" }]),
    ).toEqual([{ date: "2026-09-04", amount: 1200 }]);
  });
});

describe("month helpers", () => {
  it("keys by month", () => {
    expect(monthKey("2026-09-04")).toBe("2026-09");
  });

  it("totals one month and ignores the others", () => {
    const rows = [
      { date: "2026-09-01", amount: 100 },
      { date: "2026-09-30", amount: 50 },
      { date: "2026-10-01", amount: 999 },
    ];
    expect(totalForMonth(rows, "2026-09")).toBe(150);
  });

  it("lists recent months oldest first, ending with this one", () => {
    expect(recentMonths(new Date("2026-09-05T00:00:00Z"), 3)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(recentMonths(new Date("2027-01-15T00:00:00Z"), 3)).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
  });

  it("builds a series with zeros for empty months", () => {
    expect(
      seriesByMonth([{ date: "2026-09-01", amount: 10 }], ["2026-08", "2026-09"]),
    ).toEqual([
      { month: "2026-08", total: 0 },
      { month: "2026-09", total: 10 },
    ]);
  });
});

describe("weekStart", () => {
  it("returns the Monday of that week", () => {
    // 2026-09-05 is a Saturday.
    expect(weekStart(new Date("2026-09-05T12:00:00Z"))).toBe("2026-08-31");
  });

  it("treats Sunday as the end of the week that began on Monday", () => {
    expect(weekStart(new Date("2026-09-06T12:00:00Z"))).toBe("2026-08-31");
  });

  it("leaves a Monday alone", () => {
    expect(weekStart(new Date("2026-09-07T12:00:00Z"))).toBe("2026-09-07");
  });
});

describe("forecastCash", () => {
  const now = new Date("2026-09-05T00:00:00Z");

  it("puts scheduled money in the week it is due", () => {
    const weeks = forecastCash(
      {
        scheduledIn: [{ date: "2026-09-09", amount: 50_000 }],
        scheduledOut: [],
        historyIn: [],
        historyOut: [],
      },
      now,
      3,
    );
    expect(weeks[0].committed).toBe(0);
    expect(weeks[1].committed).toBe(50_000);
  });

  it("keeps committed and expected apart", () => {
    // The answer to "can we make payroll" depends entirely on which half you
    // are betting on, so a single blended number would hide it.
    const weeks = forecastCash(
      {
        scheduledIn: [{ date: "2026-09-09", amount: 10_000 }],
        scheduledOut: [],
        historyIn: Array.from({ length: 13 }, (_, i) => ({
          date: new Date(now.getTime() - i * 7 * 86_400_000)
            .toISOString()
            .slice(0, 10),
          amount: 1_300,
        })),
        historyOut: [],
      },
      now,
      3,
    );
    expect(weeks[1].committed).toBe(10_000);
    expect(weeks[1].expected).toBeGreaterThan(weeks[1].committed);
  });

  it("does not guess for the current week, which is already part spent", () => {
    const weeks = forecastCash(
      {
        scheduledIn: [],
        scheduledOut: [],
        historyIn: [{ date: "2026-09-01", amount: 13_000 }],
        historyOut: [],
      },
      now,
      2,
    );
    expect(weeks[0].expected).toBe(0);
    expect(weeks[1].expected).toBeGreaterThan(0);
  });

  it("returns the number of weeks asked for, starting this week", () => {
    const weeks = forecastCash(
      { scheduledIn: [], scheduledOut: [], historyIn: [], historyOut: [] },
      now,
      13,
    );
    expect(weeks).toHaveLength(13);
    expect(weeks[0].weekStart).toBe("2026-08-31");
  });
});
