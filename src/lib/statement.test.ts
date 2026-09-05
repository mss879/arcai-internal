import { describe, expect, it } from "vitest";

import { composeStatement, type ComposeStatementInput } from "./statement";

/**
 * A statement is the one document the client's accountant checks line by
 * line, so its arithmetic is pinned rather than eyeballed. Two things can go
 * wrong and both are silent: money counted twice (the deposit AND its
 * payment rows; an instalment AND the payments row that paid it), and money
 * missed (a recurring month, an instalment ticked off on its own — neither
 * has a payments row). Either way the closing balance is simply a wrong
 * number on a letterhead.
 */

const client = {
  id: "c1",
  name: "Nimal Perera",
  company: "Perera Traders",
  email: "nimal@example.com",
  phone: "0771234567",
  statementToken: "tok",
};

const base = (over: Partial<ComposeStatementInput> = {}): ComposeStatementInput => ({
  client,
  projects: [],
  invoices: [],
  today: "2026-09-05",
  ...over,
});

describe("composeStatement", () => {
  it("lists invoices as debits and receipts as credits, with a running balance", () => {
    const s = composeStatement(
      base({
        projects: [
          {
            id: "p1",
            name: "Website",
            currency: "LKR",
            total_value: 100_000,
            deposit_paid: 0,
            created_at: "2026-01-01T00:00:00Z",
            payments: [
              { id: "pay1", amount: 30_000, status: "paid", paid_at: "2026-02-10", method: "bank", invoice_id: "i1" },
            ],
            company_payments: [],
          },
        ],
        invoices: [
          { id: "i1", invoice_number: "#00201", invoice_date: "2026-02-01", grand_total: 60_000, paid_amount: 30_000, status: "partially_paid", currency: "LKR", project_id: "p1" },
          { id: "i2", invoice_number: "#00210", invoice_date: "2026-03-01", grand_total: 40_000, paid_amount: 0, status: "sent", currency: "LKR", project_id: "p1" },
        ],
      }),
    );

    expect(s.currencies).toHaveLength(1);
    const lkr = s.currencies[0];
    expect(lkr.currency).toBe("LKR");
    expect(lkr.lines.map((l) => [l.date, l.kind, l.debit, l.credit, l.balance])).toEqual([
      ["2026-02-01", "invoice", 60_000, 0, 60_000],
      ["2026-02-10", "receipt", 0, 30_000, 30_000],
      ["2026-03-01", "invoice", 40_000, 0, 70_000],
    ]);
    expect(lkr.invoiced).toBe(100_000);
    expect(lkr.received).toBe(30_000);
    expect(lkr.closing).toBe(70_000);
    expect(lkr.lines[1].description).toContain("Invoice #00201");
    expect(lkr.outstanding.map((i) => [i.number, i.balance])).toEqual([
      ["#00201", 30_000],
      ["#00210", 40_000],
    ]);
  });

  it("never counts the deposit and its payment rows twice", () => {
    // deposit_paid 30,000 written up as one 30,000 payment row: ONE receipt.
    const s = composeStatement(
      base({
        projects: [
          {
            id: "p1",
            name: "Website",
            currency: "LKR",
            total_value: 100_000,
            deposit_paid: 30_000,
            created_at: "2026-01-01T00:00:00Z",
            payments: [{ id: "pay1", amount: 30_000, status: "paid", paid_at: "2026-02-10" }],
            company_payments: [],
          },
        ],
      }),
    );
    const lkr = s.currencies[0];
    expect(lkr.received).toBe(30_000);
    expect(lkr.lines).toHaveLength(1);
    expect(lkr.closing).toBe(-30_000);
  });

  it("dates an un-itemised deposit at the project's start", () => {
    const s = composeStatement(
      base({
        projects: [
          {
            id: "p1",
            name: "Website",
            currency: "LKR",
            total_value: 100_000,
            deposit_paid: 25_000,
            start_date: "2026-01-15",
            created_at: "2026-01-01T00:00:00Z",
            payments: [],
            company_payments: [],
          },
        ],
      }),
    );
    expect(s.currencies[0].lines[0]).toMatchObject({
      date: "2026-01-15",
      reference: "Deposit",
      credit: 25_000,
    });
  });

  it("includes an instalment ticked off on its own, but not one a payments row already carries", () => {
    const s = composeStatement(
      base({
        projects: [
          {
            id: "p1",
            name: "App",
            currency: "LKR",
            total_value: 90_000,
            deposit_paid: 0,
            created_at: "2026-01-01T00:00:00Z",
            payments: [
              // Recorded as a project payment against instalment 1.
              { id: "pay1", amount: 30_000, status: "paid", paid_at: "2026-02-01", installment_id: "inst1" },
            ],
            company_payments: [],
          },
        ],
        plans: [
          {
            id: "plan1",
            title: "App in three",
            currency: "LKR",
            installments: [
              { id: "inst1", seq: 1, amount: 30_000, status: "paid", paid_at: "2026-02-01T09:00:00Z", due_date: "2026-02-01" },
              { id: "inst2", seq: 2, amount: 30_000, status: "paid", paid_at: "2026-03-01T09:00:00Z", due_date: "2026-03-01" },
              { id: "inst3", seq: 3, amount: 30_000, status: "pending", due_date: "2026-04-01" },
            ],
          },
        ],
      }),
    );
    const lkr = s.currencies[0];
    expect(lkr.received).toBe(60_000);
    expect(lkr.lines.map((l) => l.reference)).toEqual(["Payment", "Instalment 2 of 3"]);
  });

  it("includes a recurring month received, which has no payments row", () => {
    const s = composeStatement(
      base({
        invoices: [
          { id: "i9", invoice_number: "#00300", invoice_date: "2026-08-01", grand_total: 15_000, paid_amount: 15_000, status: "paid", currency: "LKR" },
        ],
        recurring: [
          {
            id: "r1",
            label: "Hosting",
            currency: "LKR",
            entries: [
              { id: "e1", period: "2026-08-01", amount: 15_000, status: "received", received_on: "2026-08-03", due_date: "2026-08-05", invoice_id: "i9" },
              { id: "e2", period: "2026-09-01", amount: 15_000, status: "pending", due_date: "2026-09-05" },
            ],
          },
        ],
      }),
    );
    const lkr = s.currencies[0];
    expect(lkr.lines.map((l) => [l.kind, l.credit || l.debit])).toEqual([
      ["invoice", 15_000],
      ["receipt", 15_000],
    ]);
    expect(lkr.lines[1].description).toBe("Invoice #00300 — Hosting · August 2026");
    expect(lkr.closing).toBe(0);
    expect(lkr.outstanding).toEqual([]);
  });

  it("carries everything before the period in as the opening balance", () => {
    const s = composeStatement(
      base({
        invoices: [
          { id: "i1", invoice_number: "#1", invoice_date: "2026-01-10", grand_total: 50_000, paid_amount: 20_000, status: "partially_paid", currency: "LKR" },
          { id: "i2", invoice_number: "#2", invoice_date: "2026-03-10", grand_total: 10_000, paid_amount: 0, status: "sent", currency: "LKR" },
        ],
        clientPayments: [
          { id: "cp1", amount: 20_000, currency: "LKR", status: "paid", paid_at: "2026-01-20", invoice_id: "i1" },
          { id: "cp2", amount: 5_000, currency: "LKR", status: "paid", paid_at: "2026-03-20", invoice_id: "i2" },
        ],
        period: { from: "2026-03-01", to: "2026-03-31" },
      }),
    );
    const lkr = s.currencies[0];
    expect(lkr.opening).toBe(30_000);
    expect(lkr.lines.map((l) => l.balance)).toEqual([40_000, 35_000]);
    expect(lkr.closing).toBe(35_000);
    expect(s.period).toEqual({ from: "2026-03-01", to: "2026-03-31" });
  });

  it("keeps currencies apart and never sums across them", () => {
    const s = composeStatement(
      base({
        invoices: [
          { id: "i1", invoice_number: "#1", invoice_date: "2026-01-10", grand_total: 1_000, paid_amount: 0, status: "sent", currency: "USD" },
          { id: "i2", invoice_number: "#2", invoice_date: "2026-01-11", grand_total: 50_000, paid_amount: 0, status: "sent", currency: "LKR" },
          { id: "i3", invoice_number: "#3", invoice_date: "2026-01-12", grand_total: 20_000, paid_amount: 0, status: "sent", currency: null },
        ],
      }),
    );
    expect(s.currencies.map((c) => [c.currency, c.closing])).toEqual([
      ["LKR", 70_000],
      ["USD", 1_000],
    ]);
  });

  it("leaves a void invoice out entirely", () => {
    const s = composeStatement(
      base({
        invoices: [
          { id: "i1", invoice_number: "#1", invoice_date: "2026-01-10", grand_total: 50_000, paid_amount: 0, status: "void", currency: "LKR" },
        ],
      }),
    );
    expect(s.currencies[0].lines).toEqual([]);
    expect(s.currencies[0].outstanding).toEqual([]);
  });

  it("flags an unpaid invoice past its due date as overdue", () => {
    const s = composeStatement(
      base({
        invoices: [
          { id: "i1", invoice_number: "#1", invoice_date: "2026-08-01", due_date: "2026-08-15", grand_total: 5_000, paid_amount: 0, status: "sent", currency: "LKR" },
          { id: "i2", invoice_number: "#2", invoice_date: "2026-09-01", due_date: "2026-09-30", grand_total: 5_000, paid_amount: 0, status: "sent", currency: "LKR" },
        ],
      }),
    );
    expect(s.currencies[0].outstanding.map((i) => i.overdue)).toEqual([true, false]);
  });

  it("shows the home currency with nothing in it rather than no statement at all", () => {
    const s = composeStatement(base({ projects: [{ id: "p", name: "X", currency: "GBP" }] }));
    expect(s.currencies).toEqual([
      { currency: "GBP", opening: 0, invoiced: 0, received: 0, closing: 0, lines: [], outstanding: [] },
    ]);
  });
});
