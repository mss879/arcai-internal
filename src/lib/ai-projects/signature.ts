import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The signature on everything that crosses between the CRM and a client's
 * backend (0127).
 *
 * One scheme, used in both directions and printed verbatim into the client
 * kit, so the code that signs and the code that verifies can never drift:
 *
 *   X-Arc-Timestamp: 1757251200
 *   X-Arc-Signature: v1=<hex hmac-sha256("<timestamp>.<raw body>", secret)>
 *   X-Arc-Project:   pk_…
 *
 * The timestamp is inside the signed string, so it cannot be moved without
 * breaking the signature, and a ±5 minute window means a captured request
 * cannot be replayed tomorrow. The body is signed RAW — verify before
 * parsing, never after, or you are signing your parser's opinion of the
 * bytes rather than the bytes.
 *
 * Not `server-only`: `signature.test.ts` imports it directly, and it touches
 * nothing but `node:crypto`.
 */

export const SIGNATURE_HEADER = "x-arc-signature";
export const TIMESTAMP_HEADER = "x-arc-timestamp";
export const PROJECT_HEADER = "x-arc-project";
export const IDEMPOTENCY_HEADER = "x-arc-idempotency-key";

/** How far out of step a request's clock may be. Five minutes each way is
 * loose enough for an unsynchronised server and tight enough that a captured
 * request is worthless by the time anyone finds it. */
export const SIGNATURE_WINDOW_SECONDS = 300;

export function signPayload(secret: string, body: string, timestamp: number): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** The three headers to send with a signed request. */
export function signedHeaders(
  secret: string,
  body: string,
  projectKey: string,
  at: Date = new Date(),
): Record<string, string> {
  const timestamp = Math.floor(at.getTime() / 1000);
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signPayload(secret, body, timestamp),
    [PROJECT_HEADER]: projectKey,
  };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Verify a signature against the raw body.
 *
 * Order matters: the timestamp is checked first (cheap, and a stale request
 * is refused without spending an HMAC), then the digest with a
 * constant-time compare so a wrong signature cannot be found a byte at a
 * time by timing the reply.
 */
export function verifySignature(
  secret: string,
  body: string,
  headers: { signature?: string | null; timestamp?: string | null },
  now: Date = new Date(),
): VerifyResult {
  const signature = (headers.signature ?? "").trim();
  const timestampRaw = (headers.timestamp ?? "").trim();
  if (!signature || !timestampRaw) return { ok: false, error: "Missing signature headers." };

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return { ok: false, error: "Bad timestamp." };
  const drift = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  if (drift > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, error: "That request is too old — check the clock on both servers." };
  }

  const expected = signPayload(secret, body, timestamp);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "Signature does not match." };
  }
  return { ok: true };
}

/**
 * The key that stops a retried write from happening twice.
 *
 * Derived from the conversation, the tool and the exact arguments, so the
 * same booking asked for twice in one conversation carries the same key and
 * the client's endpoint can recognise it. A different argument is a
 * different request, which is the correct reading: changing the time IS a
 * new booking.
 */
export function idempotencyKey(conversationId: string, tool: string, args: unknown): string {
  const canonical = JSON.stringify(args ?? {}, Object.keys((args as object) ?? {}).sort());
  return createHash("sha256").update(`${conversationId}:${tool}:${canonical}`).digest("hex").slice(0, 32);
}

/** A shared secret for a project's backend link. 32 bytes, base64url. */
export function generateSecret(): string {
  return `arcs_${randomBytes(32).toString("base64url")}`;
}

/** The bearer key the client's server reads leads with. */
export function generateReadKey(): string {
  return `arck_${randomBytes(24).toString("base64url")}`;
}

/** The lookup form of a read key. The stored ciphertext uses a random IV and
 *  so cannot be searched; this can, and reveals nothing on its own. */
export function hashKey(key: string): string {
  return createHash("sha256").update(`arc-read-key:${key}`).digest("hex");
}

/** Constant-time compare for the read key. */
export function keysMatch(a: string, b: string): boolean {
  const x = Buffer.from(a ?? "");
  const y = Buffer.from(b ?? "");
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}
