import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * Rate limiting for the endpoints anyone on the internet can reach.
 *
 * The CRM's public surface has never had any: a script can submit ten
 * thousand leads through the form, enumerate share tokens against the invoice
 * page, or bill us for ten thousand PDF renders on a plan that charges by the
 * invocation. None of that needs a vulnerability — just a loop.
 *
 * Two layers, on purpose:
 *
 *   1. An in-process Map. Free, and it absorbs the case that actually
 *      happens — the same client hammering the same instance — without a
 *      round-trip.
 *   2. `rate_limit_check()` (0116), the shared counter. Serverless means N
 *      instances each with their own Map, so in-process counting alone gives
 *      an attacker N times the allowance and a cold start resets it.
 *
 * Fail-OPEN by design: if the database is unreachable the request is allowed.
 * A limiter that takes the whole public surface down when the counter has a
 * bad minute is a worse outage than the abuse it prevents.
 */

type Window = { count: number; resetAt: number };

const local = new Map<string, Window>();

/** Stop the Map growing without bound on a long-lived instance. */
function sweep(now: number): void {
  if (local.size < 5_000) return;
  for (const [key, window] of local) {
    if (window.resetAt <= now) local.delete(key);
  }
}

export type RateLimit = {
  /** How many requests are allowed in the window. */
  limit: number;
  /** The window, in seconds. */
  windowSec: number;
};

export type RateLimitResult = {
  ok: boolean;
  /** Seconds until they may try again. Only meaningful when ok is false. */
  retryAfter: number;
};

/**
 * Count this request against `key` and say whether it is allowed.
 *
 * `key` should name the bucket and the subject: `lead-form:<ip>`,
 * `portal-comment:<token>`. Different buckets never share an allowance.
 */
export async function enforceRateLimit(
  db: DB,
  key: string,
  { limit, windowSec }: RateLimit,
  now = Date.now(),
): Promise<RateLimitResult> {
  const windowMs = Math.max(1, windowSec) * 1000;

  // --- 1. In-process ---------------------------------------------------
  const current = local.get(key);
  if (!current || current.resetAt <= now) {
    local.set(key, { count: 1, resetAt: now + windowMs });
    sweep(now);
  } else {
    current.count += 1;
    if (current.count > limit) {
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      };
    }
  }

  // --- 2. Shared counter ------------------------------------------------
  try {
    const { data, error } = await db.rpc("rate_limit_check", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSec,
    });
    // A missing function (0116 not applied) or any other error: allow.
    if (error) return { ok: true, retryAfter: 0 };
    if (data === false) return { ok: false, retryAfter: windowSec };
  } catch {
    return { ok: true, retryAfter: 0 };
  }

  return { ok: true, retryAfter: 0 };
}

/**
 * The caller's IP, as far as the proxy will tell us.
 *
 * Netlify sets x-nf-client-connection-ip and it cannot be spoofed by the
 * client; x-forwarded-for CAN be, so it is only a fallback and only its first
 * entry is read. "unknown" is a valid bucket — it simply means every caller
 * we cannot identify shares one allowance, which is the safe direction.
 */
export function clientIp(headers: Headers): string {
  const netlify = headers.get("x-nf-client-connection-ip");
  if (netlify) return netlify.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

/** A 429 with the header clients actually respect. */
export function tooManyRequests(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Try again shortly." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, retryAfter)),
      },
    },
  );
}
