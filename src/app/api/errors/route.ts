import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { captureError } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Where the error boundaries report to (T5.5).
 *
 * `src/app/error.tsx` and `global-error.tsx` post what broke on the page,
 * so a crash a person saw becomes a row an admin can see too. Signed-in
 * only — a public error sink is a public write — and capped per person.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ ok: false }, { status: 401 });

  const supabase = await createClient();
  const limit = await enforceRateLimit(supabase, `client-errors:${profile.id}`, { limit: 20, windowSec: 60 });
  if (!limit.ok) return NextResponse.json({ ok: false }, { status: 429 });

  let body: { message?: unknown; stack?: unknown; digest?: unknown; path?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.slice(0, 1000) : "Unknown client error";
  const err = new Error(message);
  if (typeof body.stack === "string") err.stack = body.stack.slice(0, 8000);

  await captureError(err, {
    source: "client",
    path: typeof body.path === "string" ? body.path.slice(0, 300) : null,
    meta: {
      digest: typeof body.digest === "string" ? body.digest : null,
      user_id: profile.id,
      user_agent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
    },
  });
  return NextResponse.json({ ok: true });
}
