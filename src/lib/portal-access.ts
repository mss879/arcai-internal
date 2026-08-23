import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Who may see a client portal (0094).
 *
 * The share link has always been an unguessable UUID, which is fine right up
 * until a client forwards the message. A project can now carry a passcode: the
 * page asks for it, and shows nothing until it's given.
 *
 * Three things make a four-digit code safe enough here:
 *
 *   • it guards a page that shows a client their own project — not money
 *     movement, not the workspace;
 *   • you need the unguessable token FIRST, so an attacker isn't picking from
 *     10,000 codes, they're picking from 10,000 × 2^122;
 *   • wrong answers are counted, and the portal locks itself after a few.
 *     The counter, not the length of the code, is the actual protection.
 *
 * Once unlocked, the browser holds an HMAC of the token and the current
 * passcode. Change the passcode and every cookie ever issued stops verifying —
 * which is exactly what "revoke" should mean, with no session table to keep.
 */

/** Wrong tries before the portal shuts for a while. */
export const MAX_PORTAL_ATTEMPTS = 5;
/** How long it stays shut. Long enough to be useless to a script. */
export const PORTAL_LOCK_MINUTES = 15;
/** How long a successful unlock lasts before the client is asked again. */
const UNLOCK_DAYS = 30;

/**
 * The signing key.
 *
 * Reuses the service-role key rather than asking for another env var — it is
 * already server-only, already required for the portal to work at all, and
 * rotating it should invalidate portal sessions anyway.
 */
function signingKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  return key;
}

function cookieName(token: string): string {
  return `arc_portal_${token}`;
}

/** The value a browser holds once it has answered correctly. */
function expectedValue(token: string, passcode: string): string {
  return createHmac("sha256", signingKey())
    .update(`${token}:${passcode}`)
    .digest("hex");
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type PortalGate =
  | { state: "open" }
  | { state: "locked"; until: string }
  | { state: "expired" }
  | { state: "revoked" }
  | { state: "passcode"; attemptsLeft: number };

export type PortalGateInput = {
  token: string;
  passcode: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lockedUntil: string | null;
  failedAttempts: number;
};

/**
 * Decide what to show for a portal request.
 *
 * Order matters: revoked and expired beat the passcode, so a client who knows
 * the code still can't get in once the link is dead.
 */
export async function checkPortalGate(
  input: PortalGateInput,
): Promise<PortalGate> {
  if (input.revokedAt) return { state: "revoked" };
  if (input.expiresAt && new Date(input.expiresAt).getTime() < Date.now()) {
    return { state: "expired" };
  }

  // No passcode set — every link created before 0094, and every project the
  // team hasn't locked. Behaves exactly as it always has.
  if (!input.passcode) return { state: "open" };

  if (
    input.lockedUntil &&
    new Date(input.lockedUntil).getTime() > Date.now()
  ) {
    return { state: "locked", until: input.lockedUntil };
  }

  const jar = await cookies();
  const held = jar.get(cookieName(input.token))?.value;
  if (held && sameValue(held, expectedValue(input.token, input.passcode))) {
    return { state: "open" };
  }

  return {
    state: "passcode",
    attemptsLeft: Math.max(0, MAX_PORTAL_ATTEMPTS - input.failedAttempts),
  };
}

/** Remember a correct answer in the client's browser. */
export async function grantPortalAccess(
  token: string,
  passcode: string,
): Promise<void> {
  const jar = await cookies();
  jar.set(cookieName(token), expectedValue(token, passcode), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/public/project/${token}`,
    maxAge: UNLOCK_DAYS * 24 * 60 * 60,
  });
}

/** Compare a typed code with the stored one, without leaking timing. */
export function passcodeMatches(typed: string, stored: string): boolean {
  const a = typed.trim();
  const b = stored.trim();
  if (!a || !b || a.length !== b.length) return false;
  return sameValue(a, b);
}

/** A fresh 6-digit code. Avoids leading zeros being dropped by a phone keypad. */
export function generatePasscode(): string {
  // 100000–999999, from the same CSPRNG the tokens come from.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}
