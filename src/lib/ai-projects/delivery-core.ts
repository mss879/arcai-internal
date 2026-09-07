/**
 * When to try a lead delivery again, and when to stop (0127) — pure, so the
 * schedule is a thing you can read rather than infer.
 *
 * A captured lead is the most valuable thing this whole system produces, so
 * the queue leans towards trying again: five attempts spread over about nine
 * hours, which covers a client's server being restarted, redeployed, or down
 * overnight. After that it stops and says so on the Leads tab, because a
 * queue that retries forever is one nobody ever looks at.
 */

/** The wait before attempt N+1, after N failures. */
export const RETRY_BACKOFF_MS = [
  60_000, // 1 minute — a redeploy
  5 * 60_000, // 5 minutes
  30 * 60_000, // half an hour
  2 * 3_600_000, // 2 hours
  6 * 3_600_000, // 6 hours — overnight
] as const;

export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MS.length;

export type DeliveryOutcome =
  | { status: "sent"; attempts: number; deliveredAt: string; nextAttemptAt: null }
  | { status: "pending"; attempts: number; nextAttemptAt: string; error: string }
  | { status: "failed"; attempts: number; nextAttemptAt: null; error: string };

/**
 * Fold one attempt's result into the row's next state.
 *
 * `attemptsBefore` is what the row carried when it was claimed, so the
 * arithmetic is the same whether the caller is the inline attempt or the
 * tick.
 */
export function nextDeliveryState(
  attemptsBefore: number,
  result: { ok: boolean; error?: string | null },
  now: Date = new Date(),
): DeliveryOutcome {
  const attempts = attemptsBefore + 1;
  if (result.ok) {
    return { status: "sent", attempts, deliveredAt: now.toISOString(), nextAttemptAt: null };
  }
  const error = (result.error ?? "The call failed.").slice(0, 500);
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { status: "failed", attempts, nextAttemptAt: null, error };
  }
  const wait = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
  return {
    status: "pending",
    attempts,
    nextAttemptAt: new Date(now.getTime() + wait).toISOString(),
    error,
  };
}

/** Is this row due to be tried now? */
export function isDue(
  row: { status: string; next_attempt_at: string },
  now: Date = new Date(),
): boolean {
  return row.status === "pending" && row.next_attempt_at <= now.toISOString();
}

/** How long until the next try, in words for the Backend tab. */
export function describeWait(nextAttemptAt: string | null, now: Date = new Date()): string {
  if (!nextAttemptAt) return "—";
  const ms = Date.parse(nextAttemptAt) - now.getTime();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "any moment";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** One line for the Leads tab's delivery chip. */
export function describeDelivery(row: {
  status: string;
  attempts: number;
  last_error: string | null;
} | null): { label: string; tone: "good" | "waiting" | "bad" | "none" } {
  if (!row) return { label: "Not sent", tone: "none" };
  if (row.status === "sent") return { label: "Delivered", tone: "good" };
  if (row.status === "failed") {
    return { label: `Failed after ${row.attempts} tries`, tone: "bad" };
  }
  return {
    label: row.attempts === 0 ? "Queued" : `Retrying (${row.attempts}/${MAX_DELIVERY_ATTEMPTS})`,
    tone: "waiting",
  };
}
