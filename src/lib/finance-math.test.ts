import { describe, expect, it } from "vitest";

import {
  detectStandingCosts,
  forecastCash,
  inflowLines,
  monthlyInflows,
  monthlyOutflows,
  monthKey,
  profitAndLoss,
  projectStandingCosts,
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

describe("inflowLines — Finance Overview and the Tax tab are the same number", () => {
  // The Tax tab used to build its own income list from payments and
  // instalments only. A received recurring month then showed on Overview
  // and not on the export, and the two totals disagreed.
  const sources = {
    payments: [
      { amount: 10_000, paid_at: "2026-09-03", created_at: "2026-09-01T00:00:00Z", notes: "Deposit" },
      { amount: 5_000, paid_at: null, created_at: "2026-09-20T00:00:00Z", notes: null },
    ],
    installments: [
      { amount: 20_000, status: "paid", paid_at: "2026-09-10", due_date: "2026-09-01", seq: 2, plan_id: "plan-1" },
      { amount: 99_000, status: "pending", paid_at: null, due_date: "2026-09-15", seq: 3, plan_id: "plan-1" },
    ],
    recurring: [
      {
        id: "r1",
        label: "Hosting",
        entries: [
          { amount: 7_000, status: "received", received_on: "2026-09-05", due_date: "2026-09-01", period: "2026-09-01" },
          { amount: 7_000, status: "pending", received_on: null, due_date: "2026-10-01", period: "2026-10-01" },
        ],
      },
    ],
  };
  const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

  it("totals exactly what monthlyInflows totals", () => {
    expect(sum(inflowLines(sources))).toBe(sum(monthlyInflows(sources)));
    expect(sum(inflowLines(sources))).toBe(42_000);
  });

  it("is monthlyInflows with the words dropped — line for line", () => {
    expect(inflowLines(sources).map(({ date, amount }) => ({ date, amount }))).toEqual(
      monthlyInflows(sources),
    );
  });

  it("agrees for one month, which is what Overview shows", () => {
    const month = "2026-09";
    const taxTotal = inflowLines(sources)
      .filter((l) => monthKey(l.date) === month)
      .reduce((s, l) => s + l.amount, 0);
    expect(taxTotal).toBe(totalForMonth(monthlyInflows(sources), month));
  });

  it("keeps the recurring month the Tax tab used to drop", () => {
    const recurring = inflowLines(sources).filter((l) => l.kind === "recurring");
    expect(recurring).toEqual([
      { date: "2026-09-05", amount: 7_000, kind: "recurring", description: "Hosting — September 2026", ref: "r1" },
    ]);
  });

  it("describes each line for the export", () => {
    const lines = inflowLines(sources);
    expect(lines[0]).toMatchObject({ kind: "payment", description: "Deposit", ref: null });
    expect(lines[1]).toMatchObject({ kind: "payment", description: "Project payment" });
    expect(lines[2]).toMatchObject({ kind: "installment", description: "Installment #2", ref: "plan-1" });
  });
});

describe("profitAndLoss", () => {
  it("nets in against out per month, and shows payouts without subtracting them twice", () => {
    const rows = profitAndLoss({
      months: ["2026-08", "2026-09"],
      inflows: [
        { date: "2026-08-10", amount: 100_000 },
        { date: "2026-09-10", amount: 80_000 },
      ],
      // The payout run's own expenses row is already in here.
      outflows: [
        { date: "2026-09-01", amount: 30_000 },
        { date: "2026-09-28", amount: 25_000 },
      ],
      payouts: [{ date: "2026-09-28", amount: 25_000 }],
    });
    expect(rows).toEqual([
      { month: "2026-08", inflow: 100_000, outflow: 0, payouts: 0, net: 100_000 },
      { month: "2026-09", inflow: 80_000, outflow: 55_000, payouts: 25_000, net: 25_000 },
    ]);
  });

  it("returns a zero line for a month with nothing in it", () => {
    expect(profitAndLoss({ months: ["2026-01"], inflows: [], outflows: [], payouts: [] })).toEqual([
      { month: "2026-01", inflow: 0, outflow: 0, payouts: 0, net: 0 },
    ]);
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

describe("standing costs", () => {
  const now = new Date("2026-09-05T00:00:00.000Z");
  const ledger = [
    // Rent, three months running, always the 1st.
    { expense_date: "2026-07-01", amount: 60_000, vendor: "Landlord", description: "Office rent" },
    { expense_date: "2026-08-01", amount: 60_000, vendor: "Landlord", description: "Office rent" },
    { expense_date: "2026-09-01", amount: 60_000, vendor: "Landlord", description: "Office rent" },
    // Hosting, two months, no vendor — keyed on the description.
    { expense_date: "2026-07-15", amount: 4_000, vendor: null, description: "Netlify" },
    { expense_date: "2026-08-15", amount: 4_500, vendor: null, description: "netlify" },
    // A laptop is not a standing cost.
    { expense_date: "2026-08-20", amount: 350_000, vendor: "Abans", description: "MacBook" },
    // Two payments in ONE month is still one month.
    { expense_date: "2026-08-03", amount: 2_000, vendor: "Uber", description: "Transport" },
    { expense_date: "2026-08-09", amount: 2_500, vendor: "Uber", description: "Transport" },
    // Too old to count.
    { expense_date: "2026-04-01", amount: 9_000, vendor: "Dialog", description: "Phones" },
    { expense_date: "2026-05-01", amount: 9_000, vendor: "Dialog", description: "Phones" },
  ];

  it("finds what comes back in two of the last three months", () => {
    const costs = detectStandingCosts(ledger, now);
    expect(costs.map((c) => c.name)).toEqual(["Landlord", "Netlify"]);
  });

  it("uses the typical amount and the usual day", () => {
    const hosting = detectStandingCosts(ledger, now).find((c) => c.name === "Netlify")!;
    expect(hosting.amount).toBe(4_250);
    expect(hosting.day).toBe(15);
  });

  it("projects forward, skipping what this month has already paid", () => {
    const rows = projectStandingCosts(ledger, now, 2);
    // Rent was paid on the 1st, so September's is not expected again.
    expect(rows.filter((r) => r.amount === 60_000).map((r) => r.date)).toEqual([
      "2026-10-01",
      "2026-11-01",
    ]);
    // Hosting hasn't landed yet this month — the 15th is still ahead.
    expect(rows.filter((r) => r.amount === 4_250).map((r) => r.date)).toEqual([
      "2026-09-15",
      "2026-10-15",
      "2026-11-15",
    ]);
  });

  it("returns nothing for an empty ledger", () => {
    expect(projectStandingCosts([], now)).toEqual([]);
  });
});
