import { describe, expect, it } from "vitest";

import {
  SIGNATURE_WINDOW_SECONDS,
  generateReadKey,
  generateSecret,
  idempotencyKey,
  keysMatch,
  signPayload,
  signedHeaders,
  verifySignature,
} from "./signature";

const SECRET = "arcs_test_secret";
const BODY = JSON.stringify({ event: "lead.captured", lead: { name: "Nimal" } });
const NOW = new Date("2026-09-07T12:00:00Z");

function headersFor(body = BODY, at = NOW) {
  const h = signedHeaders(SECRET, body, "pk_abc", at);
  return { signature: h["x-arc-signature"], timestamp: h["x-arc-timestamp"] };
}

describe("verifySignature", () => {
  it("accepts what it signed", () => {
    expect(verifySignature(SECRET, BODY, headersFor(), NOW)).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const h = headersFor();
    const res = verifySignature(SECRET, BODY.replace("Nimal", "Attacker"), h, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("does not match");
  });

  it("rejects the wrong secret", () => {
    expect(verifySignature("other", BODY, headersFor(), NOW).ok).toBe(false);
  });

  it("rejects a replay outside the window and accepts one inside it", () => {
    const h = headersFor();
    const justInside = new Date(NOW.getTime() + SIGNATURE_WINDOW_SECONDS * 1000);
    const justOutside = new Date(NOW.getTime() + (SIGNATURE_WINDOW_SECONDS + 1) * 1000);
    expect(verifySignature(SECRET, BODY, h, justInside).ok).toBe(true);
    expect(verifySignature(SECRET, BODY, h, justOutside).ok).toBe(false);
    // Clock skew the other way is just as acceptable, and just as bounded.
    expect(verifySignature(SECRET, BODY, h, new Date(NOW.getTime() - SIGNATURE_WINDOW_SECONDS * 1000)).ok).toBe(true);
    expect(verifySignature(SECRET, BODY, h, new Date(NOW.getTime() - (SIGNATURE_WINDOW_SECONDS + 1) * 1000)).ok).toBe(false);
  });

  it("rejects missing or malformed headers without throwing", () => {
    expect(verifySignature(SECRET, BODY, {}, NOW).ok).toBe(false);
    expect(verifySignature(SECRET, BODY, { signature: "v1=abc", timestamp: null }, NOW).ok).toBe(false);
    expect(verifySignature(SECRET, BODY, { signature: "v1=abc", timestamp: "not-a-number" }, NOW).ok).toBe(false);
    // A signature of the wrong length must fail on length, not throw.
    expect(verifySignature(SECRET, BODY, { signature: "v1=00", timestamp: "1757246400" }, NOW).ok).toBe(false);
  });

  it("signs the timestamp too, so it cannot be moved", () => {
    const h = headersFor();
    const moved = { signature: h.signature, timestamp: String(Number(h.timestamp) + 1) };
    expect(verifySignature(SECRET, BODY, moved, NOW).ok).toBe(false);
  });

  it("is stable for the same inputs", () => {
    expect(signPayload(SECRET, BODY, 1757246400)).toBe(signPayload(SECRET, BODY, 1757246400));
    expect(signPayload(SECRET, BODY, 1757246400).startsWith("v1=")).toBe(true);
  });
});

describe("idempotencyKey", () => {
  it("is the same for the same request and different for a changed one", () => {
    const a = idempotencyKey("conv1", "create_booking", { day: "Thu", time: "15:00" });
    const b = idempotencyKey("conv1", "create_booking", { time: "15:00", day: "Thu" });
    expect(a).toBe(b); // key order must not matter
    expect(idempotencyKey("conv1", "create_booking", { day: "Fri", time: "15:00" })).not.toBe(a);
    expect(idempotencyKey("conv2", "create_booking", { day: "Thu", time: "15:00" })).not.toBe(a);
    expect(a).toHaveLength(32);
  });
});

describe("keys", () => {
  it("mints distinct prefixed secrets", () => {
    expect(generateSecret().startsWith("arcs_")).toBe(true);
    expect(generateReadKey().startsWith("arck_")).toBe(true);
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it("compares in constant time without throwing on a length mismatch", () => {
    expect(keysMatch("abc", "abc")).toBe(true);
    expect(keysMatch("abc", "abd")).toBe(false);
    expect(keysMatch("abc", "abcd")).toBe(false);
    expect(keysMatch("", "")).toBe(false);
  });
});
