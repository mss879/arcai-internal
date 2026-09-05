import { NextResponse } from "next/server";

import { errorSummary } from "@/lib/errors";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { isSmsConfigured } from "@/lib/sms";
import { isSocialCryptoConfigured } from "@/lib/social/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { isWhatsAppConfigured } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The automation tick runs every 5 minutes; three misses is an outage. */
const TICK_STALE_MS = 16 * 60 * 1000;
/** The WhatsApp tick runs every minute. */
const WA_TICK_STALE_MS = 6 * 60 * 1000;

/**
 * Is the CRM alive? (T5.5)
 *
 * One GET for an uptime monitor: the database answers, the automation tick
 * has run recently, the WhatsApp tick has run recently (when WhatsApp is
 * configured), and which integrations have their keys. 200 when it is well,
 * 503 when it is not — the body says which check failed, and never a secret:
 * every flag is a boolean.
 *
 * Public and machine-only (PUBLIC_PREFIXES + MACHINE_PREFIXES in
 * src/lib/supabase/middleware.ts, and the matcher in src/proxy.ts), so no
 * session is refreshed for a monitor that calls it every minute. Rate-
 * limited by IP so it cannot be turned into a free database ping loop.
 */
export async function GET(request: Request) {
  const supabase = createAdminClient();

  const limit = await enforceRateLimit(supabase, `health:${clientIp(request.headers)}`, {
    limit: 60,
    windowSec: 60,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const startedAt = Date.now();
  const checks: Record<string, { ok: boolean; detail?: string; at?: string | null; ms?: number }> = {};

  // --- Database -----------------------------------------------------------
  let stamps: { key: string; value: Record<string, unknown> }[] = [];
  try {
    const t0 = Date.now();
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["automation_tick", "wa_agent_tick"]);
    if (error) throw new Error(error.message);
    stamps = data ?? [];
    checks.database = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : "unreachable" };
  }

  // --- Ticks ------------------------------------------------------------
  const tickAt = stampAt(stamps, "automation_tick");
  const tickAge = tickAt ? Date.now() - new Date(tickAt).getTime() : null;
  checks.automationTick = {
    ok: tickAge !== null && tickAge < TICK_STALE_MS,
    at: tickAt,
    detail:
      tickAge === null
        ? "never ran — is SMS_CRON_SECRET set and the scheduled function deployed?"
        : tickAge < TICK_STALE_MS
          ? `${Math.round(tickAge / 60_000)} min ago`
          : `stale — ${Math.round(tickAge / 60_000)} min ago`,
  };

  const waAt = stampAt(stamps, "wa_agent_tick");
  const waAge = waAt ? Date.now() - new Date(waAt).getTime() : null;
  checks.whatsappTick = isWhatsAppConfigured()
    ? {
        ok: waAge !== null && waAge < WA_TICK_STALE_MS,
        at: waAt,
        detail:
          waAge === null
            ? "never ran"
            : waAge < WA_TICK_STALE_MS
              ? `${Math.round(waAge / 60_000)} min ago`
              : `stale — ${Math.round(waAge / 60_000)} min ago`,
      }
    : { ok: true, detail: "WhatsApp not configured — not checked" };

  // --- Integrations (booleans only) ----------------------------------------
  const env = {
    supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    serviceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    appUrl: Boolean(process.env.NEXT_PUBLIC_APP_URL),
    cronSecret: Boolean(process.env.SMS_CRON_SECRET),
    resend: Boolean(process.env.RESEND_API_KEY),
    whatsapp: isWhatsAppConfigured(),
    sms: isSmsConfigured(),
    openai: Boolean(process.env.OPENAI_API_KEY),
    socialTokenKey: isSocialCryptoConfigured(),
    sentry: Boolean(process.env.SENTRY_DSN),
  };

  const errors = await errorSummary();

  const ok = checks.database.ok && checks.automationTick.ok && checks.whatsappTick.ok;
  return NextResponse.json(
    {
      ok,
      status: ok ? "healthy" : "degraded",
      checkedAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
      checks,
      env,
      errors,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    },
  );
}

function stampAt(stamps: { key: string; value: Record<string, unknown> }[], key: string): string | null {
  const at = stamps.find((s) => s.key === key)?.value?.at;
  return typeof at === "string" ? at : null;
}
