import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getAssistantProfile } from "@/lib/auth";
import { sendAndLogEmail } from "@/lib/email-outbox";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Send an email the assistant prepared.
 *
 * The ONLY path that actually sends one: it fires when a person taps Send on
 * the confirmation card, having read the recipient, the subject and the exact
 * words. The model never reaches this route — it needs a browser session, so
 * a mission running on a cron cannot call it either. That is the whole safety
 * model, and it is why missions.ts must never import a sender directly.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    to?: unknown;
    subject?: unknown;
    body?: unknown;
    clientId?: unknown;
    leadId?: unknown;
    projectId?: unknown;
    cta?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const to = (Array.isArray(body?.to) ? body.to : [body?.to])
    .map((a) => String(a ?? "").trim())
    .filter(Boolean);
  if (!to.length) {
    return NextResponse.json({ ok: false, error: "No recipient." }, { status: 400 });
  }

  const subject = String(body?.subject ?? "").trim();
  const text = String(body?.body ?? "").trim();
  if (!subject || !text) {
    return NextResponse.json(
      { ok: false, error: "The email needs a subject and a body." },
      { status: 400 },
    );
  }

  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const cta =
    body?.cta && typeof body.cta === "object"
      ? {
          href: String((body.cta as { href?: unknown }).href ?? ""),
          label: String((body.cta as { label?: unknown }).label ?? "Open"),
        }
      : null;

  const supabase = await createClient();
  const result = await sendAndLogEmail(supabase, {
    to,
    kind: "compose",
    actor: "assistant",
    sentBy: profile.id,
    clientId: str(body?.clientId),
    leadId: str(body?.leadId),
    projectId: str(body?.projectId),
    message: {
      transport: "generic",
      subject,
      body: text,
      ...(cta?.href ? { cta } : {}),
    },
  });

  revalidatePath("/inbox");
  const clientId = str(body?.clientId);
  if (clientId) revalidatePath(`/clients/${clientId}`);

  if (!result.sent) {
    return NextResponse.json(
      { ok: false, error: result.error || "The email failed to send." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
