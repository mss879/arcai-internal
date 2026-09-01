import { NextResponse } from "next/server";

/**
 * Shared guard for the machine-only cron endpoints (the tick routes, the
 * analytics sync, the weekly digest).
 *
 * Fails closed: an environment without SMS_CRON_SECRET refuses to tick (503)
 * instead of silently becoming a public, anyone-can-trigger endpoint. And the
 * secret is only accepted as an Authorization header — never as a query
 * parameter, which would copy it into every request log line.
 */
export function requireCronSecret(request: Request): NextResponse | null {
  const secret = process.env.SMS_CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "SMS_CRON_SECRET is not configured — refusing to run." },
      { status: 503 },
    );
  }
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
