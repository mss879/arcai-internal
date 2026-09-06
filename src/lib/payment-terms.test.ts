import { describe, expect, it } from "vitest";

import { UPFRONT_PERCENT, paymentDue } from "./payment-terms";

/**
 * What a client is told to send. Getting this wrong asks for the wrong money
 * on a page the client reads before they pay, so it is worth the test.
 */
describe("paymentDue", () => {
  const total = 200_000;

  it("asks for the upfront share before anything is paid", () => {
    expect(paymentDue({ totalValue: total, received: 0, completed: false })).toEqual({
      kind: "upfront",
      amount: 140_000,
      percent: UPFRONT_PERCENT,
    });
  });

  it("asks only for what is left of the upfront after a part payment", () => {
    const due = paymentDue({ totalValue: total, received: 50_000, completed: false });
    expect(due.kind).toBe("upfront");
    expect(due.amount).toBe(90_000);
  });

  it("waits for completion once the upfront is covered", () => {
    const due = paymentDue({ totalValue: total, received: 140_000, completed: false });
    expect(due.kind).toBe("on_completion");
    expect(due.amount).toBe(60_000);
    expect(due.percent).toBe(30);
  });

  it("quotes the true remainder on completion, not a fixed share", () => {
    // Overpaid the upfront: what is left at the end is less than 30%.
    const due = paymentDue({ totalValue: total, received: 160_000, completed: true });
    expect(due.kind).toBe("final");
    expect(due.amount).toBe(40_000);
    expect(due.percent).toBe(20);
  });

  it("owes the whole value when a project completes with nothing paid", () => {
    const due = paymentDue({ totalValue: total, received: 0, completed: true });
    expect(due).toEqual({ kind: "final", amount: total, percent: 100 });
  });

  it("is settled when the balance is gone, or there is no value yet", () => {
    expect(
      paymentDue({ totalValue: total, received: total, completed: false }).kind,
    ).toBe("settled");
    expect(paymentDue({ totalValue: 0, received: 0, completed: false }).kind).toBe(
      "settled",
    );
  });

  it("never returns a negative amount when a client has overpaid", () => {
    const due = paymentDue({ totalValue: total, received: 250_000, completed: true });
    expect(due).toEqual({ kind: "settled", amount: 0, percent: 0 });
  });

  it("uses the project's own deposit share when its documents set one", () => {
    const due = paymentDue({ totalValue: total, received: 0, completed: false, upfrontPercent: 50 });
    expect(due).toEqual({ kind: "upfront", amount: 100_000, percent: 50 });
    // Out of range or missing → the standard split, never zero.
    expect(paymentDue({ totalValue: total, received: 0, completed: false, upfrontPercent: 0 }).percent).toBe(UPFRONT_PERCENT);
    expect(paymentDue({ totalValue: total, received: 0, completed: false, upfrontPercent: null }).percent).toBe(UPFRONT_PERCENT);
  });

  it("rounds the upfront to whole currency units", () => {
    const due = paymentDue({ totalValue: 99_999, received: 0, completed: false });
    expect(due.amount).toBe(Math.round((99_999 * UPFRONT_PERCENT) / 100));
    expect(Number.isInteger(due.amount)).toBe(true);
  });
});
