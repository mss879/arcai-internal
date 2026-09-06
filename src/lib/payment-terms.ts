/**
 * The agency's standard payment split, as numbers.
 *
 * 70/30 was already written down in three places — the proposal's default
 * `paymentTerms`, the services agreement template, and the invoice chase —
 * but only ever as prose. Nothing could work out what a client actually owes
 * TODAY, so the portal showed "Balance due: Rs 200,000" on day one of a
 * project where the sum to send was Rs 140,000. The figure was true and the
 * instruction was wrong.
 *
 * Pure and dependency-free: the portal, the project page and the tests all
 * read the same function, and the prose above reads the same constants.
 */

/** Payable before the project commences. */
export const UPFRONT_PERCENT = 70;
/** Payable on completion, before launch or handover. */
export const FINAL_PERCENT = 100 - UPFRONT_PERCENT;

export type PaymentDueKind =
  /** The upfront hasn't been covered and work hasn't started. */
  | "upfront"
  /** Upfront covered, work in flight — the rest lands on completion. */
  | "on_completion"
  /** Work is finished; the remainder is payable now. */
  | "final"
  /** Nothing outstanding. */
  | "settled";

export type PaymentDue = {
  kind: PaymentDueKind;
  /** What to send, in the project's currency. Never negative. */
  amount: number;
  /** The share of the total this instalment represents, for the copy. */
  percent: number;
};

/**
 * What the client owes right now.
 *
 * `received` is counted against the upfront first, which is simply the order
 * the money arrives in. An overpayment against the upfront is not "change" —
 * it just reduces what is left at the end, so `final` is always the real
 * remaining balance rather than a fixed 30%.
 */
export function paymentDue(input: {
  totalValue: number;
  received: number;
  /** True once the project's status is `completed`. */
  completed: boolean;
  /**
   * This project's own deposit share, when its invoice or proposal set one
   * (projects.deposit_required_percent). Null or out of range falls back to
   * the standard split — a 50% deal must ask for 50%, and a project with no
   * documents must still ask for something.
   */
  upfrontPercent?: number | null;
}): PaymentDue {
  const upfrontPercent =
    input.upfrontPercent != null &&
    Number.isFinite(input.upfrontPercent) &&
    input.upfrontPercent > 0 &&
    input.upfrontPercent <= 100
      ? input.upfrontPercent
      : UPFRONT_PERCENT;
  const total = Math.max(0, Number(input.totalValue) || 0);
  const received = Math.max(0, Number(input.received) || 0);
  const balance = Math.max(0, total - received);

  if (total <= 0 || balance <= 0) {
    return { kind: "settled", amount: 0, percent: 0 };
  }

  // Finished work: the whole remainder is payable, whatever it is. Quoted as
  // the final share only when the upfront really was paid — a project that
  // completes with nothing received owes 100%, not 30%.
  if (input.completed) {
    return {
      kind: "final",
      amount: balance,
      percent: Math.round((balance / total) * 100),
    };
  }

  const upfront = Math.round((total * upfrontPercent) / 100);
  const upfrontOutstanding = Math.max(0, upfront - received);

  if (upfrontOutstanding > 0) {
    return {
      kind: "upfront",
      // Never ask for more than is actually left on the project.
      amount: Math.min(upfrontOutstanding, balance),
      percent: upfrontPercent,
    };
  }

  return {
    kind: "on_completion",
    amount: balance,
    percent: Math.round((balance / total) * 100),
  };
}
