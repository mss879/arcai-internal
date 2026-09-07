import { describe, expect, it } from "vitest";

import {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  describeDelivery,
  describeWait,
  isDue,
  nextDeliveryState,
} from "./delivery-core";

const NOW = new Date("2026-09-07T12:00:00.000Z");

describe("nextDeliveryState", () => {
  it("marks a success delivered and stops scheduling", () => {
    const res = nextDeliveryState(0, { ok: true }, NOW);
    expect(res).toEqual({ status: "sent", attempts: 1, deliveredAt: NOW.toISOString(), nextAttemptAt: null });
  });

  it("walks the backoff, one step per failure", () => {
    const waits: number[] = [];
    for (let before = 0; before < MAX_DELIVERY_ATTEMPTS - 1; before += 1) {
      const res = nextDeliveryState(before, { ok: false, error: "down" }, NOW);
      expect(res.status).toBe("pending");
      if (res.status !== "pending") throw new Error("unreachable");
      waits.push(Date.parse(res.nextAttemptAt) - NOW.getTime());
    }
    expect(waits).toEqual(RETRY_BACKOFF_MS.slice(0, MAX_DELIVERY_ATTEMPTS - 1));
  });

  it("gives up after the last attempt and keeps the reason", () => {
    const res = nextDeliveryState(MAX_DELIVERY_ATTEMPTS - 1, { ok: false, error: "still down" }, NOW);
    expect(res.status).toBe("failed");
    expect(res.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    if (res.status === "failed") expect(res.error).toBe("still down");
  });

  it("caps the stored error and always has one", () => {
    const res = nextDeliveryState(0, { ok: false, error: "x".repeat(2_000) }, NOW);
    if (res.status !== "pending") throw new Error("unreachable");
    expect(res.error).toHaveLength(500);
    const noReason = nextDeliveryState(0, { ok: false }, NOW);
    if (noReason.status !== "pending") throw new Error("unreachable");
    expect(noReason.error).toBe("The call failed.");
  });

  it("retries for roughly nine hours in total", () => {
    const total = RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total / 3_600_000).toBeGreaterThan(8);
    expect(total / 3_600_000).toBeLessThan(10);
  });
});

describe("isDue", () => {
  it("claims a pending row whose time has come, and nothing else", () => {
    expect(isDue({ status: "pending", next_attempt_at: "2026-09-07T11:59:00.000Z" }, NOW)).toBe(true);
    expect(isDue({ status: "pending", next_attempt_at: "2026-09-07T12:01:00.000Z" }, NOW)).toBe(false);
    expect(isDue({ status: "sent", next_attempt_at: "2026-09-07T11:00:00.000Z" }, NOW)).toBe(false);
    expect(isDue({ status: "failed", next_attempt_at: "2026-09-07T11:00:00.000Z" }, NOW)).toBe(false);
  });
});

describe("wording", () => {
  it("describes the wait", () => {
    expect(describeWait(null)).toBe("—");
    expect(describeWait("2026-09-07T11:59:00.000Z", NOW)).toBe("any moment");
    expect(describeWait("2026-09-07T12:05:00.000Z", NOW)).toBe("in 5 min");
    expect(describeWait("2026-09-07T14:00:00.000Z", NOW)).toBe("in 2 hours");
  });

  it("describes the state for the Leads chip", () => {
    expect(describeDelivery(null)).toEqual({ label: "Not sent", tone: "none" });
    expect(describeDelivery({ status: "sent", attempts: 1, last_error: null }).tone).toBe("good");
    expect(describeDelivery({ status: "pending", attempts: 0, last_error: null }).label).toBe("Queued");
    expect(describeDelivery({ status: "pending", attempts: 2, last_error: "x" }).label).toBe("Retrying (2/5)");
    expect(describeDelivery({ status: "failed", attempts: 5, last_error: "x" })).toEqual({
      label: "Failed after 5 tries",
      tone: "bad",
    });
  });
});
