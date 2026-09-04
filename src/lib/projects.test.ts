import { describe, expect, it } from "vitest";

import {
  balanceDue,
  buildLedger,
  paidPercent,
  settledAmount,
  type MoneyProject,
} from "./projects";

/**
 * The money invariant, pinned.
 *
 * `deposit_paid` and a project's `payments` rows are two records of the SAME
 * money — nine of the ten projects with payment rows had them exactly equal.
 * Adding them doubles every "Received" figure on four screens, which is the
 * bug this module exists to prevent. Only `company_payments` (the Payments
 * board) is a separate ledger that adds on top.
 */

const project = (p: Partial<MoneyProject>): MoneyProject => ({
  total_value: 100_000,
  deposit_paid: 0,
  payments: [],
  company_payments: [],
  ...p,
});

describe("settledAmount", () => {
  it("counts a deposit that was never itemised", () => {
    expect(settledAmount(project({ deposit_paid: 30_000 }))).toBe(30_000);
  });

  it("counts payment rows on their own", () => {
    expect(
      settledAmount(
        project({ payments: [{ amount: 20_000 }, { amount: 5_000 }] }),
      ),
    ).toBe(25_000);
  });

  it("counts the same money ONCE when the deposit equals its payment rows", () => {
    // The normal case in this workspace: the team records a payment row and
    // bumps deposit_paid to match. 30k + 30k must read as 30k, not 60k.
    expect(
      settledAmount(
        project({ deposit_paid: 30_000, payments: [{ amount: 30_000 }] }),
      ),
    ).toBe(30_000);
  });

  it("adds only the part of a deposit the rows don't account for", () => {
    expect(
      settledAmount(
        project({ deposit_paid: 50_000, payments: [{ amount: 30_000 }] }),
      ),
    ).toBe(50_000);
  });

  it("never subtracts when the rows exceed the deposit", () => {
    expect(
      settledAmount(
        project({ deposit_paid: 10_000, payments: [{ amount: 30_000 }] }),
      ),
    ).toBe(30_000);
  });

  it("ignores project payment rows that aren't paid", () => {
    expect(
      settledAmount(
        project({
          payments: [{ amount: 20_000 }, { amount: 9_000, status: "pending" }],
        }),
      ),
    ).toBe(20_000);
  });

  it("adds Payments-board money on top, but only when it is settled", () => {
    expect(
      settledAmount(
        project({
          deposit_paid: 30_000,
          payments: [{ amount: 30_000 }],
          company_payments: [
            { price_lkr: 15_000, is_paid: true },
            // 'pending'/'upcoming' describe WHEN money is expected, not that
            // it arrived — is_paid is the only settled flag.
            { price_lkr: 40_000, is_paid: false },
            { price_lkr: 40_000 },
          ],
        }),
      ),
    ).toBe(45_000);
  });

  it("treats junk amounts as zero rather than NaN", () => {
    expect(
      settledAmount(
        project({
          deposit_paid: "not a number",
          payments: [{ amount: "12000" }],
        }),
      ),
    ).toBe(12_000);
  });
});

describe("balanceDue", () => {
  it("is what's left", () => {
    expect(balanceDue(project({ deposit_paid: 40_000 }))).toBe(60_000);
  });

  it("reads an overpayment as settled, never as a negative", () => {
    expect(balanceDue(project({ deposit_paid: 140_000 }))).toBe(0);
  });
});

describe("paidPercent", () => {
  it("rounds and caps at 100", () => {
    expect(paidPercent(project({ deposit_paid: 33_333 }))).toBe(33);
    expect(paidPercent(project({ deposit_paid: 200_000 }))).toBe(100);
  });

  it("is 0 for a project with no value rather than dividing by zero", () => {
    expect(paidPercent(project({ total_value: 0, deposit_paid: 5_000 }))).toBe(0);
  });
});

describe("buildLedger", () => {
  it("adds up to exactly settledAmount", () => {
    const p = project({
      deposit_paid: 50_000,
      payments: [{ id: "a", amount: 30_000, paid_at: "2026-03-01" }],
      company_payments: [{ id: "b", price_lkr: 15_000, is_paid: true }],
    });
    const paid = buildLedger(p)
      .filter((r) => r.paid)
      .reduce((sum, r) => sum + r.amount, 0);
    expect(paid).toBe(settledAmount(p));
  });

  it("shows the deposit only for the part not itemised below", () => {
    const rows = buildLedger(
      project({ deposit_paid: 50_000, payments: [{ id: "a", amount: 30_000 }] }),
    );
    const deposit = rows.find((r) => r.source === "deposit");
    expect(deposit?.amount).toBe(20_000);
    expect(deposit?.note).toBe("The part of the deposit not itemised below");
  });

  it("omits the deposit row entirely when the rows already cover it", () => {
    const rows = buildLedger(
      project({ deposit_paid: 30_000, payments: [{ id: "a", amount: 30_000 }] }),
    );
    expect(rows.some((r) => r.source === "deposit")).toBe(false);
  });

  it("flags the same amount entered in both tables within three days", () => {
    const rows = buildLedger(
      project({
        payments: [{ id: "own", amount: 25_000, paid_at: "2026-03-01" }],
        company_payments: [
          { id: "board", price_lkr: 25_000, is_paid: true, created_at: "2026-03-02" },
        ],
      }),
    );
    expect(rows.find((r) => r.id === "own")?.possibleDuplicateOf).toBe("board");
    expect(rows.find((r) => r.id === "board")?.possibleDuplicateOf).toBe("own");
  });

  it("does not flag two installments of the same size in the SAME table", () => {
    const rows = buildLedger(
      project({
        payments: [
          { id: "one", amount: 25_000, paid_at: "2026-03-01" },
          { id: "two", amount: 25_000, paid_at: "2026-03-02" },
        ],
      }),
    );
    expect(rows.every((r) => !r.possibleDuplicateOf)).toBe(true);
  });

  it("does not flag matching amounts more than three days apart", () => {
    const rows = buildLedger(
      project({
        payments: [{ id: "own", amount: 25_000, paid_at: "2026-03-01" }],
        company_payments: [
          { id: "board", price_lkr: 25_000, is_paid: true, created_at: "2026-03-20" },
        ],
      }),
    );
    expect(rows.every((r) => !r.possibleDuplicateOf)).toBe(true);
  });

  it("sorts newest first and puts undated rows last", () => {
    const rows = buildLedger(
      project({
        deposit_paid: 5_000,
        payments: [
          { id: "old", amount: 1_000, paid_at: "2026-01-01" },
          { id: "new", amount: 2_000, paid_at: "2026-06-01" },
        ],
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "old", "deposit"]);
  });
});
